import type { Business, Device, DeviceStatus, InventoryState, Port, Rack } from "./types";

const STORAGE_KEY = "unifi-rack-planner.layout-overrides";
const RACK_STORAGE_KEY = "unifi-rack-planner.custom-racks";
const DEVICE_STORAGE_KEY = "unifi-rack-planner.custom-devices";
const RACK_LABEL_STORAGE_KEY = "unifi-rack-planner.rack-label-overrides";
const BUSINESS_LABEL_STORAGE_KEY = "unifi-rack-planner.business-label-overrides";

type LayoutOverride = {
  rackId?: string;
  uStart?: number;
  name?: string;
  model?: string;
  type?: Device["type"];
  heightU?: number;
  status?: DeviceStatus;
  locked?: boolean;
  ports?: Port[];
};

type LayoutOverrides = Record<string, LayoutOverride>;
type RackLabelOverride = Partial<Pick<Rack, "name" | "site" | "role" | "sizeU">>;
type BusinessLabelOverride = Partial<Pick<Business, "name" | "sites">>;
type RackLabelOverrides = Record<string, RackLabelOverride>;
type BusinessLabelOverrides = Record<string, BusinessLabelOverride>;

export function loadLayoutOverrides(): LayoutOverrides {
  const rawOverrides = window.localStorage.getItem(STORAGE_KEY);
  if (!rawOverrides) return {};

  try {
    return JSON.parse(rawOverrides) as LayoutOverrides;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

export function clearLocalPlanningData(): void {
  [
    STORAGE_KEY,
    RACK_STORAGE_KEY,
    DEVICE_STORAGE_KEY,
    RACK_LABEL_STORAGE_KEY,
    BUSINESS_LABEL_STORAGE_KEY,
  ].forEach((key) => window.localStorage.removeItem(key));
}

export function saveDevicePlacement(deviceId: string, rackId: string, uStart: number): void {
  const overrides = loadLayoutOverrides();
  overrides[deviceId] = { ...overrides[deviceId], rackId, uStart };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function saveDeviceEdits(
  deviceId: string,
  edits: Pick<LayoutOverride, "name" | "model" | "type" | "heightU" | "status" | "locked" | "ports">,
): void {
  const overrides = loadLayoutOverrides();
  overrides[deviceId] = { ...overrides[deviceId], ...edits };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function applyLayoutOverrides(inventory: InventoryState): InventoryState {
  const overrides = loadLayoutOverrides();
  const customRacks = loadCustomRacks();
  const rackLabelOverrides = loadRackLabelOverrides();
  const businessLabelOverrides = loadBusinessLabelOverrides();
  const racks = mergeRacks(inventory.racks, customRacks).map((rack) => ({
    ...rack,
    ...rackLabelOverrides[rack.id],
  }));
  const devices = mergeDevices(inventory.devices, loadCustomDevices());

  return {
    ...inventory,
    businesses: inventory.businesses.map((business) => ({
      ...business,
      ...businessLabelOverrides[business.id],
    })),
    racks,
    devices: devices.map((device) => {
      const override = overrides[device.id];
      if (!override) return device;
      const overrideRackExists =
        !override.rackId || racks.some((rack) => rack.id === override.rackId);

      return {
        ...device,
        rackId: overrideRackExists ? override.rackId ?? device.rackId : device.rackId,
        uStart: override.uStart ?? device.uStart,
        name: override.name ?? device.name,
        model: override.model ?? device.model,
        type: override.type ?? device.type,
        heightU: override.heightU ?? device.heightU,
        status: override.status ?? device.status,
        locked: override.locked ?? device.locked,
        ports: override.ports ? mergeDevicePorts(device.ports, override.ports) : device.ports,
      };
    }),
  };
}

function mergeDevicePorts(basePorts: Port[], overridePorts: Port[]): Port[] {
  const basePortsById = new Map(basePorts.map((port) => [port.id, port]));
  const basePortsByNumber = new Map(basePorts.map((port) => [getPortNumber(port), port]));

  return overridePorts.map((overridePort) => {
    const basePort =
      basePortsById.get(overridePort.id) ??
      basePortsByNumber.get(getPortNumber(overridePort));
    if (!basePort) return overridePort;

    const migratedPatchConnection =
      overridePort.patchConnection || (looksLikePatchLink(overridePort.connectedTo) ? overridePort.connectedTo : "");
    const connectedTo = resolveMergedConnectedTo(basePort, overridePort);

    return {
      ...basePort,
      label: overridePort.label || basePort.label,
      speed: basePort.speed || overridePort.speed,
      vlan: overridePort.vlan ?? basePort.vlan,
      connectedTo,
      importedEndpointName: basePort.importedEndpointName ?? basePort.connectedTo,
      patchConnection: migratedPatchConnection || basePort.patchConnection,
      endpointType: overridePort.endpointType ?? basePort.endpointType,
      endpointLocation: overridePort.endpointLocation ?? basePort.endpointLocation,
      endpointOwner: overridePort.endpointOwner ?? basePort.endpointOwner,
      endpointVendor: basePort.endpointVendor ?? overridePort.endpointVendor,
      endpointNotes: overridePort.endpointNotes ?? basePort.endpointNotes,
      connectedMac: basePort.connectedMac || overridePort.connectedMac,
      connectedIp: basePort.connectedIp || overridePort.connectedIp,
      poeMode: basePort.poeMode || overridePort.poeMode,
      stp: basePort.stp || overridePort.stp,
      wireUse: overridePort.wireUse ?? basePort.wireUse,
      wireColor: overridePort.wireColor ?? basePort.wireColor,
    };
  });
}

function resolveMergedConnectedTo(basePort: Port, overridePort: Port): string | undefined {
  if (looksLikePatchLink(overridePort.connectedTo)) return basePort.connectedTo;
  const baseEndpoint = basePort.importedEndpointName ?? basePort.connectedTo;
  const overrideEndpoint = overridePort.connectedTo;
  if (
    overrideEndpoint &&
    baseEndpoint &&
    isGenericAccessEndpointName(overrideEndpoint) &&
    !isGenericAccessEndpointName(baseEndpoint)
  ) {
    return baseEndpoint;
  }

  return overrideEndpoint ?? basePort.connectedTo;
}

function looksLikePatchLink(value: string | undefined): boolean {
  return Boolean(value?.match(/\s\/\s(?:sfp\s*)?\d+\s*$/i));
}

function isGenericAccessEndpointName(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  const genericNames = new Set([
    "door",
    "reader",
    "ua",
    "ua hub",
    "uahub",
    "ua hub door",
    "uahubdoor",
    "ua hub door mini",
    "uahubdoormini",
    "ua reader",
    "uareader",
    "ua reader lite",
    "uareaderlite",
    "ua reader pro",
    "uareaderpro",
    "ua reader ultra",
    "uareaderultra",
    "ua ultra",
    "uaultra",
    "access hub",
    "accesshub",
    "access reader",
    "accessreader",
    "door reader",
    "doorreader",
  ]);

  return genericNames.has(normalized) || genericNames.has(compact);
}

function getPortNumber(port: Port): number {
  const match = port.label.match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

export function saveBusinessEdits(
  businessId: string,
  edits: BusinessLabelOverride,
): void {
  const overrides = loadBusinessLabelOverrides();
  overrides[businessId] = { ...overrides[businessId], ...edits };
  window.localStorage.setItem(BUSINESS_LABEL_STORAGE_KEY, JSON.stringify(overrides));
}

export function saveRackEdits(rackId: string, edits: RackLabelOverride): void {
  const overrides = loadRackLabelOverrides();
  overrides[rackId] = { ...overrides[rackId], ...edits };
  window.localStorage.setItem(RACK_LABEL_STORAGE_KEY, JSON.stringify(overrides));
}

function loadRackLabelOverrides(): RackLabelOverrides {
  const rawOverrides = window.localStorage.getItem(RACK_LABEL_STORAGE_KEY);
  if (!rawOverrides) return {};

  try {
    return JSON.parse(rawOverrides) as RackLabelOverrides;
  } catch {
    window.localStorage.removeItem(RACK_LABEL_STORAGE_KEY);
    return {};
  }
}

function loadBusinessLabelOverrides(): BusinessLabelOverrides {
  const rawOverrides = window.localStorage.getItem(BUSINESS_LABEL_STORAGE_KEY);
  if (!rawOverrides) return {};

  try {
    return JSON.parse(rawOverrides) as BusinessLabelOverrides;
  } catch {
    window.localStorage.removeItem(BUSINESS_LABEL_STORAGE_KEY);
    return {};
  }
}

export function loadCustomDevices(): Device[] {
  const rawDevices = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (!rawDevices) return [];

  try {
    return JSON.parse(rawDevices) as Device[];
  } catch {
    window.localStorage.removeItem(DEVICE_STORAGE_KEY);
    return [];
  }
}

export function saveCustomDevice(device: Device): void {
  const devices = mergeDevices(loadCustomDevices(), [device]);
  window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(devices));
}

export function deleteCustomDevice(deviceId: string): void {
  const devices = loadCustomDevices().filter((device) => device.id !== deviceId);
  const overrides = loadLayoutOverrides();
  delete overrides[deviceId];
  window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(devices));
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function loadCustomRacks(): Rack[] {
  const rawRacks = window.localStorage.getItem(RACK_STORAGE_KEY);
  if (!rawRacks) return [];

  try {
    return JSON.parse(rawRacks) as Rack[];
  } catch {
    window.localStorage.removeItem(RACK_STORAGE_KEY);
    return [];
  }
}

export function saveCustomRack(rack: Rack): void {
  const racks = mergeRacks(loadCustomRacks(), [rack]);
  window.localStorage.setItem(RACK_STORAGE_KEY, JSON.stringify(racks));
}

export function moveDeviceInInventory(
  inventory: InventoryState,
  deviceId: string,
  rackId: string,
  uStart: number,
): InventoryState {
  const deviceToMove = inventory.devices.find((device) => device.id === deviceId);
  if (deviceToMove?.locked) return inventory;

  saveDevicePlacement(deviceId, rackId, uStart);

  return {
    ...inventory,
    devices: inventory.devices.map((device) =>
      device.id === deviceId ? moveDevice(device, rackId, uStart) : device,
    ),
  };
}

function moveDevice(device: Device, rackId: string, uStart: number): Device {
  return {
    ...device,
    rackId,
    uStart,
  };
}

function mergeRacks(baseRacks: Rack[], customRacks: Rack[]): Rack[] {
  return Array.from(new Map([...baseRacks, ...customRacks].map((rack) => [rack.id, rack])).values());
}

function mergeDevices(baseDevices: Device[], customDevices: Device[]): Device[] {
  return Array.from(
    new Map([...baseDevices, ...customDevices].map((device) => [device.id, device])).values(),
  );
}
