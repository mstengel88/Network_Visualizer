import type { InventoryState, UniFiAccountProfile } from "./types";

const STORAGE_KEY = "unifi-rack-planner.account";

export type UniFiAccountInput = Pick<
  UniFiAccountProfile,
  "label" | "mode" | "controllerUrl" | "siteId" | "apiToken"
>;

export function loadUniFiAccount(): UniFiAccountProfile | null {
  const rawProfile = window.localStorage.getItem(STORAGE_KEY);
  if (!rawProfile) return null;

  try {
    return JSON.parse(rawProfile) as UniFiAccountProfile;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveUniFiAccount(input: UniFiAccountInput): UniFiAccountProfile {
  const profile: UniFiAccountProfile = {
    ...input,
    id: crypto.randomUUID(),
    controllerUrl: normalizeControllerUrl(input.controllerUrl),
    status: "not-tested",
  };

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  return profile;
}

export function updateUniFiAccount(profile: UniFiAccountProfile): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function clearUniFiAccount(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function maskToken(token: string): string {
  if (token.length <= 8) return "Saved token";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export async function testUniFiConnection(
  profile: UniFiAccountProfile,
): Promise<UniFiAccountProfile> {
  try {
    const response = await fetch("/api/unifi/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        mode: profile.mode,
        controllerUrl: profile.controllerUrl,
        siteId: profile.siteId,
        apiToken: profile.apiToken,
      }),
    });
    const result = (await response.json()) as { ok: boolean; message: string };

    const nextProfile: UniFiAccountProfile = {
      ...profile,
      lastTestedAt: new Date().toISOString(),
      status: result.ok ? "connected" : "failed",
      statusMessage: result.message,
    };

    updateUniFiAccount(nextProfile);
    return nextProfile;
  } catch (error) {
    const nextProfile: UniFiAccountProfile = {
      ...profile,
      lastTestedAt: new Date().toISOString(),
      status: "failed",
      statusMessage:
        error instanceof Error
          ? error.message
          : "Connection failed before the local UniFi proxy responded.",
    };

    updateUniFiAccount(nextProfile);
    return nextProfile;
  }
}

export async function syncUniFiInventory(profile: UniFiAccountProfile): Promise<{
  inventory: InventoryState;
  message: string;
}> {
  const response = await fetch("/api/unifi/inventory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      mode: profile.mode,
      controllerUrl: profile.controllerUrl,
      siteId: profile.siteId,
      apiToken: profile.apiToken,
      label: profile.label,
    }),
  });

  const result = (await response.json()) as {
    ok: boolean;
    message: string;
    data?: {
      label: string;
      hosts: unknown[];
      sites: unknown[];
      devices: unknown[];
      networkSites?: unknown[];
      networkDevices?: unknown[];
      clients?: unknown[];
      legacyDevices?: unknown[];
      legacyClients?: unknown[];
    };
  };

  if (!response.ok || !result.ok || !result.data) {
    throw new Error(result.message || "Could not sync UniFi inventory");
  }
  const inventory = mapCloudInventory(result.data);

  return {
    inventory,
    message: `${result.message}; created ${inventory.businesses.length} businesses, ${inventory.racks.length} racks, ${inventory.devices.length} devices`,
  };
}

function mapCloudInventory(data: {
  label: string;
  hosts: unknown[];
  sites: unknown[];
  devices: unknown[];
  networkSites?: unknown[];
  networkDevices?: unknown[];
  clients?: unknown[];
  legacyDevices?: unknown[];
  legacyClients?: unknown[];
}): InventoryState {
  const hostsById = buildHostsById(data.hosts);
  const siteRecords = (data.networkSites?.length ? data.networkSites : data.sites).length
    ? data.networkSites?.length
      ? data.networkSites
      : data.sites
    : [{ siteId: "default", meta: { desc: "Default" } }];
  const expandedSiteRecords = addMissingHostSites(siteRecords, data.hosts);
  const racks = expandedSiteRecords.map((site, index) => {
    const siteObject = asRecord(site);
    const meta = asRecord(siteObject.meta);
    const hostId = getHostIdentifier(siteObject) || `host-${index + 1}`;
    const host = hostsById.get(hostId);
    const siteId = getString(siteObject, "siteId") || getString(siteObject, "id") || `site-${index + 1}`;
    const hostName =
      getString(asRecord(host), "name") ||
      getString(asRecord(host), "displayName") ||
      getString(asRecord(host), "hostname") ||
      "";
    const siteName =
      getString(meta, "desc") ||
      getString(meta, "name") ||
      getString(siteObject, "name") ||
      hostName ||
      `Site ${index + 1}`;
    const businessName = hostName || siteName;

    return {
      id: `rack-${toId(hostId)}-${toId(siteId)}`,
      businessId: `business-${toId(hostId)}`,
      site: siteName,
      name: "Rack 1",
      sizeU: 24,
      role: businessName,
    };
  });
  const uniqueRacks = Array.from(new Map(racks.map((rack) => [rack.id, rack])).values());
  const businessNamesById = new Map(
    uniqueRacks.map((rack) => [rack.businessId, rack.role || rack.site]),
  );
  const rackAliases = buildRackAliases(expandedSiteRecords, uniqueRacks);
  const unmatchedRack = {
    id: "rack-unassigned",
    businessId: "business-needs-site-mapping",
    site: "Needs site mapping",
    name: "Needs site mapping",
    sizeU: 24,
    role: "Imported devices that could not be matched to a UniFi site",
  };

  const importedDeviceRecords = data.legacyDevices?.length
    ? data.legacyDevices
    : data.networkDevices?.length
      ? data.networkDevices
      : data.devices;
  const rackDeviceRecords = importedDeviceRecords.filter((device) =>
    isRackDeviceRecord(asRecord(device)),
  );
  const endpointDeviceRecords = importedDeviceRecords.filter((device) =>
    !isRackDeviceRecord(asRecord(device)),
  );
  const endpointRecords = [
    ...(data.legacyClients ?? []),
    ...(data.clients ?? []),
    ...importedDeviceRecords,
  ];
  const portEndpointRecords = [
    ...(data.legacyClients ?? []),
    ...(data.clients ?? []),
  ];
  const clientsByMac = buildClientsByMac(endpointRecords);
  const clientsByPort = mergeMissingEndpointRecords(
    buildClientsByPort(portEndpointRecords),
    buildClientsByPort(endpointDeviceRecords),
  );
  const devices = rackDeviceRecords.map((device, index) => {
    const deviceObject = asRecord(device);
    const rackId = findRackIdForDevice(deviceObject, rackAliases) ?? unmatchedRack.id;
    const name =
      getString(deviceObject, "name") ||
      getString(deviceObject, "displayName") ||
      getString(deviceObject, "model") ||
      `UniFi device ${index + 1}`;
    const model =
      getString(deviceObject, "model") ||
      getString(deviceObject, "shortname") ||
      getString(deviceObject, "type") ||
      "UniFi device";
    const ip =
      getString(deviceObject, "ip") ||
      getString(deviceObject, "ipAddress") ||
      getString(deviceObject, "gatewayIp");

    return {
      id: `device-${toId(getString(deviceObject, "id") || getString(deviceObject, "mac") || name)}-${index}`,
      rackId,
      name,
      model,
      type: inferDeviceType(name, model),
      uStart: Math.max(1, 23 - index),
      heightU: 1,
      status: inferDeviceStatus(deviceObject),
      ip,
      ports: mapDevicePorts(deviceObject, index, ip, clientsByMac, clientsByPort),
    };
  });
  const connections = buildDeviceConnections(rackDeviceRecords, rackAliases);
  const finalRacks = devices.some((device) => device.rackId === unmatchedRack.id)
    ? [...uniqueRacks, unmatchedRack]
    : uniqueRacks;

  return {
    businesses: buildBusinesses(finalRacks, businessNamesById),
    racks: finalRacks,
    devices,
    connections,
  };
}

function addMissingHostSites(siteRecords: unknown[], hosts: unknown[]): unknown[] {
  const hostIdsWithSites = new Set(
    siteRecords
      .map((site) => getString(asRecord(site), "hostId") || getString(asRecord(site), "host_id"))
      .filter(Boolean),
  );
  const syntheticSites = hosts
    .map((host) => asRecord(host))
    .filter((host) => {
      const hostId = getHostIdentifier(host);
      return hostId && !hostIdsWithSites.has(hostId);
    })
    .map((host) => {
      const hostId = getHostIdentifier(host);
      const name =
        getString(host, "name") ||
        getString(host, "displayName") ||
        getString(host, "hostname") ||
        hostId;

      return {
        hostId,
        siteId: "default",
        name,
        meta: { desc: name, name: "default" },
      };
    });

  return [...siteRecords, ...syntheticSites];
}

function buildHostsById(hosts: unknown[]): Map<string, Record<string, unknown>> {
  const hostsById = new Map<string, Record<string, unknown>>();

  hosts.forEach((host) => {
    const hostObject = asRecord(host);
    const hostId = getHostIdentifier(hostObject);
    if (hostId) hostsById.set(hostId, hostObject);
  });

  return hostsById;
}

function buildBusinesses(
  racks: InventoryState["racks"],
  businessNamesById: Map<string, string>,
): InventoryState["businesses"] {
  const businesses = new Map<string, InventoryState["businesses"][number]>();

  racks.forEach((rack) => {
    const existing = businesses.get(rack.businessId);
    if (existing) {
      if (!existing.sites.includes(rack.site)) existing.sites.push(rack.site);
      return;
    }

    businesses.set(rack.businessId, {
      id: rack.businessId,
      name: businessNamesById.get(rack.businessId) || rack.site || rack.name,
      sites: [rack.site],
    });
  });

  return Array.from(businesses.values());
}

function buildRackAliases(siteRecords: unknown[], racks: InventoryState["racks"]) {
  const aliases = new Map<string, string>();

  siteRecords.forEach((site, index) => {
    const siteObject = asRecord(site);
    const meta = asRecord(siteObject.meta);
    const rack = racks[index];
    if (!rack) return;
    const hostId = getHostIdentifier(siteObject);
    const siteAliases = [
      getString(siteObject, "id"),
      getString(siteObject, "siteId"),
      getString(siteObject, "site_id"),
      getString(siteObject, "internalReference"),
      getString(siteObject, "name"),
      getString(meta, "name"),
      getString(meta, "desc"),
    ].filter(Boolean);

    siteAliases.forEach((alias) => aliases.set(toId(alias), rack.id));
    if (hostId) {
      aliases.set(toId(hostId), rack.id);
      siteAliases.forEach((alias) => aliases.set(toId(`${hostId}-${alias}`), rack.id));
    }
  });

  return aliases;
}

function findRackIdForDevice(
  device: Record<string, unknown>,
  rackAliases: Map<string, string>,
): string | undefined {
  const candidates = [
    `${getString(device, "hostId")}-${getString(device, "siteId")}`,
    `${getString(device, "hostId")}-${getString(device, "site_id")}`,
    `${getString(device, "consoleId")}-${getString(device, "siteId")}`,
    `${getString(device, "consoleId")}-${getString(device, "site_id")}`,
    getString(device, "siteId"),
    getString(device, "site_id"),
    getString(device, "site_name"),
    getString(device, "siteName"),
    getHostIdentifier(device),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const rackId = rackAliases.get(toId(candidate));
    if (rackId) return rackId;
  }

  return undefined;
}

function isRackDeviceRecord(device: Record<string, unknown>): boolean {
  const value = [
    getString(device, "name"),
    getString(device, "displayName"),
    getString(device, "model"),
    getString(device, "shortname"),
    getString(device, "type"),
    getString(device, "deviceType"),
    getString(device, "category"),
    getString(device, "productLine"),
  ]
    .join(" ")
    .toLowerCase();

  const excludedPatterns = [
    "access point",
    " uap",
    "uap-",
    " u6",
    "u6-",
    " u7",
    "u7-",
    " ap ",
    "ap-",
    "camera",
    "uvc",
    "doorbell",
    "sensor",
    "phone",
    "talk",
    "ubb",
    "building bridge",
    "bridge",
  ];
  if (excludedPatterns.some((pattern) => value.includes(pattern))) return false;

  const includedPatterns = [
    "switch",
    "usw",
    "us-",
    "us8",
    "us16",
    "us24",
    "us48",
    "gateway",
    "router",
    "dream machine",
    "udm",
    "uxg",
    "ucg",
    "usg",
    "server",
    "nas",
    "nvr",
    "unvr",
    "cloud key",
    "uck",
  ];

  return includedPatterns.some((pattern) => value.includes(pattern));
}

function inferDeviceType(name: string, model: string): InventoryState["devices"][number]["type"] {
  const value = `${name} ${model}`.toLowerCase();
  if (value.includes("gateway") || value.includes("dream machine") || value.includes("udm")) return "gateway";
  if (
    value.includes("switch") ||
    value.includes("usw") ||
    /\bus-?\d{1,2}/.test(value) ||
    /\busl?\d{1,2}/.test(value)
  ) {
    return "switch";
  }
  if (value.includes("power") || value.includes("pdu")) return "power";
  return "server";
}

function inferDeviceStatus(device: Record<string, unknown>): InventoryState["devices"][number]["status"] {
  const state = `${getString(device, "state")} ${getString(device, "status")}`.toLowerCase();
  if (state.includes("offline") || state.includes("disconnected")) return "attention";
  return "online";
}

function mapDevicePorts(
  device: Record<string, unknown>,
  deviceIndex: number,
  ip: string,
  clientsByMac: Map<string, Record<string, unknown>>,
  clientsByPort: Map<string, Record<string, unknown>>,
) {
  const interfaces = asRecord(device.interfaces);
  const rawPorts = Array.isArray(device.port_table)
    ? device.port_table
    : Array.isArray(interfaces.ports)
      ? interfaces.ports
      : [];

  if (!rawPorts.length) {
    return [
      {
        id: `port-${deviceIndex}-mgmt`,
        label: "Mgmt",
        speed: "Auto",
        connectedTo:
          ip ||
          getString(device, "macAddress") ||
          getString(device, "mac") ||
          "Imported from UniFi",
      },
    ];
  }

  return rawPorts.map((port, index) => {
    const portObject = asRecord(port);
    const idx = getPortIndex(portObject, index);
    const speedMbps =
      getString(portObject, "speed") ||
      getString(portObject, "speedMbps") ||
      getString(portObject, "maxSpeedMbps");
    const connector = getString(portObject, "connector") || getString(portObject, "media");
    const state = getPortState(portObject);
    const poe = asRecord(portObject.poe);
    const poeState = getString(portObject, "poe_mode") || getString(poe, "state") || getString(poe, "mode");
    const macs = getPortMacs(portObject);
    const macMatchedClient = macs.map((mac) => clientsByMac.get(normalizeMac(mac))).find(Boolean);
    const portMatchedClient = macMatchedClient ? undefined : findClientByPort(device, idx, clientsByPort);
    const connectedClient = macMatchedClient || portMatchedClient;
    const matchedBy = macMatchedClient ? "mac" : portMatchedClient ? "port" : "none";
    const portName = getString(portObject, "name");
    const label = getPortDisplayLabel(idx, portName, connector);
    const connectedName = getPortEndpointName(portObject, connectedClient, macs, state);
    const connectedMac = getClientMac(connectedClient) || macs[0] || "";
    const connectedIp = connectedClient ? getClientIp(connectedClient) : getPortEndpointIp(portObject);
    const hasEndpointEvidence = hasPortEndpointEvidence(portObject, connectedClient, macs, state);
    const endpointSource = firstRecordWithValues(
      connectedClient,
      asRecord(portObject.connectedDevice),
      asRecord(portObject.connectedClient),
      asRecord(portObject.lldp),
      asRecord(portObject.access),
      asRecord(portObject.accessDevice),
      asRecord(portObject.accessHub),
      asRecord(portObject.uaHub),
      asRecord(portObject.door),
      asRecord(portObject.reader),
    );

    return {
      id: `port-${deviceIndex}-${idx}`,
      label,
      speed: speedMbps ? formatSpeed(speedMbps) : "Auto",
      connectedTo: connectedName || "Unknown",
      importedEndpointName: connectedName || "Unknown",
      connectedMac,
      connectedIp,
      endpointType: hasEndpointEvidence ? inferEndpointType(connectedName, endpointSource) : "",
      endpointLocation: getEndpointLocation(endpointSource),
      endpointOwner: getEndpointOwner(endpointSource),
      endpointVendor: getEndpointVendor(endpointSource),
      poeMode: poeState,
      stp: getString(portObject, "stp_pathcost") ? "STP" : undefined,
      diagnostics: buildPortDiagnostics({
        port: portObject,
        idx,
        label,
        state,
        macs,
        connectedClient,
        matchedBy,
        hasEndpointEvidence,
        selectedEndpointName: connectedName,
        endpointType: hasEndpointEvidence ? inferEndpointType(connectedName, endpointSource) : "",
      }),
    };
  });
}

function buildPortDiagnostics({
  port,
  idx,
  label,
  state,
  macs,
  connectedClient,
  matchedBy,
  hasEndpointEvidence,
  selectedEndpointName,
  endpointType,
}: {
  port: Record<string, unknown>;
  idx: string;
  label: string;
  state: string;
  macs: string[];
  connectedClient: Record<string, unknown> | undefined;
  matchedBy: "mac" | "port" | "none";
  hasEndpointEvidence: boolean;
  selectedEndpointName: string;
  endpointType: string;
}) {
  return {
    portIndex: idx,
    portLabel: label,
    state,
    rawPortName: getString(port, "name") || getString(port, "portName") || getString(port, "port_name"),
    rawPortKeys: Object.keys(port).sort(),
    rawPort: toDiagnosticJson(port),
    macs,
    matchedBy,
    matchedClientName: getClientName(connectedClient),
    matchedClientIp: getClientIp(connectedClient),
    matchedClientMacs: connectedClient ? getMacCandidates(connectedClient) : [],
    matchedClientKeys: connectedClient ? Object.keys(connectedClient).sort() : [],
    matchedClient: connectedClient ? toDiagnosticJson(connectedClient) : undefined,
    hasEndpointEvidence,
    selectedEndpointName,
    endpointType,
  };
}

function toDiagnosticJson(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth limit]";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => toDiagnosticJson(item, depth + 1));
  if (typeof value !== "object") return undefined;

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  return Object.fromEntries(entries.map(([key, item]) => [key, toDiagnosticJson(item, depth + 1)]));
}

function buildClientsByMac(clients: unknown[]): Map<string, Record<string, unknown>> {
  const clientsByMac = new Map<string, Record<string, unknown>>();

  clients.forEach((client) => {
    const clientObject = asRecord(client);
    getMacCandidates(clientObject).forEach((mac) => setPreferredEndpointRecord(clientsByMac, mac, clientObject));
  });

  return clientsByMac;
}

function buildClientsByPort(clients: unknown[]): Map<string, Record<string, unknown>> {
  const clientsByPort = new Map<string, Record<string, unknown>>();

  clients.forEach((client) => {
    const clientObject = asRecord(client);
    const uplink = asRecord(clientObject.uplink);
    const uplinkDevice = asRecord(clientObject.uplinkDevice);
    const uplinkDeviceSnake = asRecord(clientObject.uplink_device);
    const uplinkDeviceInfo = asRecord(clientObject.uplinkDeviceInfo);
    const uplinkDeviceInfoSnake = asRecord(clientObject.uplink_device_info);
    const parentDevice = asRecord(clientObject.parentDevice);
    const parentDeviceSnake = asRecord(clientObject.parent_device);
    const uplinkSource = asRecord(clientObject.uplinkSource);
    const uplinkSourceSnake = asRecord(clientObject.uplink_source);
    const lastUplink = asRecord(clientObject.lastUplink);
    const lastUplinkSnake = asRecord(clientObject.last_uplink);
    const deviceIds = uniqueStrings([
      getString(clientObject, "uplinkDeviceId"),
      getString(clientObject, "uplink_device_id"),
      getString(clientObject, "uplinkSourceId"),
      getString(clientObject, "uplink_source_id"),
      getString(clientObject, "uplinkDevice"),
      getString(clientObject, "uplink_device"),
      getString(clientObject, "uplinkDeviceMac"),
      getString(clientObject, "uplink_device_mac"),
      getString(clientObject, "uplinkSourceMac"),
      getString(clientObject, "uplink_source_mac"),
      getString(clientObject, "switchMac"),
      getString(clientObject, "switch_mac"),
      getString(clientObject, "sw_mac"),
      getString(clientObject, "swMac"),
      getString(clientObject, "uplinkMac"),
      getString(clientObject, "uplink_mac"),
      getString(clientObject, "switchName"),
      getString(clientObject, "switch_name"),
      getString(clientObject, "uplinkDeviceName"),
      getString(clientObject, "uplink_device_name"),
      getString(uplink, "deviceId"),
      getString(uplink, "device_id"),
      getString(uplink, "_id"),
      getString(uplink, "id"),
      getString(uplink, "name"),
      getString(uplink, "deviceName"),
      getString(uplink, "device_name"),
      getString(uplink, "displayName"),
      getString(uplink, "display_name"),
      getString(uplink, "mac"),
      getString(uplink, "macAddress"),
      getString(uplink, "mac_address"),
      ...getDeviceIdentifierCandidates(uplinkDevice),
      ...getDeviceIdentifierCandidates(uplinkDeviceSnake),
      ...getDeviceIdentifierCandidates(uplinkDeviceInfo),
      ...getDeviceIdentifierCandidates(uplinkDeviceInfoSnake),
      ...getDeviceIdentifierCandidates(parentDevice),
      ...getDeviceIdentifierCandidates(parentDeviceSnake),
      ...getDeviceIdentifierCandidates(uplinkSource),
      ...getDeviceIdentifierCandidates(uplinkSourceSnake),
      ...getDeviceIdentifierCandidates(lastUplink),
      ...getDeviceIdentifierCandidates(lastUplinkSnake),
    ]);
    const port = getUplinkPortCandidate(clientObject, uplink);

    if (port) {
      deviceIds.forEach((deviceId) => setPreferredEndpointRecord(clientsByPort, makePortClientKey(deviceId, port), clientObject));
    }

    getNestedUplinkEntries(clientObject).forEach((entry) => {
      const entryDeviceIds = uniqueStrings([...deviceIds, ...getDeviceIdentifierCandidates(entry)]);
      const entryPort = getUplinkPortCandidate(entry, asRecord(entry.uplink));
      if (!entryPort) return;
      entryDeviceIds.forEach((deviceId) => setPreferredEndpointRecord(clientsByPort, makePortClientKey(deviceId, entryPort), clientObject));
    });
  });

  return clientsByPort;
}

function mergeMissingEndpointRecords(
  primaryMap: Map<string, Record<string, unknown>>,
  fallbackMap: Map<string, Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  fallbackMap.forEach((record, key) => {
    if (!primaryMap.has(key)) primaryMap.set(key, record);
  });

  return primaryMap;
}

function setPreferredEndpointRecord(
  endpointMap: Map<string, Record<string, unknown>>,
  key: string,
  nextRecord: Record<string, unknown>,
): void {
  const existingRecord = endpointMap.get(key);
  if (!existingRecord || shouldPreferEndpointRecord(nextRecord, existingRecord)) {
    endpointMap.set(key, nextRecord);
  }
}

function shouldPreferEndpointRecord(
  nextRecord: Record<string, unknown>,
  existingRecord: Record<string, unknown>,
): boolean {
  const nextName = getClientName(nextRecord);
  const existingName = getClientName(existingRecord);
  if (nextName && !existingName) return true;
  if (!nextName && existingName) return false;

  const nextHasIp = Boolean(getClientIp(nextRecord));
  const existingHasIp = Boolean(getClientIp(existingRecord));
  if (nextHasIp !== existingHasIp) return nextHasIp;

  return false;
}

function getDeviceIdentifierCandidates(record: Record<string, unknown>): string[] {
  return [
    getString(record, "_id"),
    getString(record, "id"),
    getString(record, "deviceId"),
    getString(record, "device_id"),
    getString(record, "deviceMac"),
    getString(record, "device_mac"),
    getString(record, "mac"),
    getString(record, "macAddress"),
    getString(record, "mac_address"),
    getString(record, "uplinkMac"),
    getString(record, "uplink_mac"),
    getString(record, "name"),
    getString(record, "displayName"),
    getString(record, "display_name"),
    getString(record, "hostname"),
  ].filter(Boolean);
}

function getUplinkPortCandidate(
  clientObject: Record<string, unknown>,
  uplink: Record<string, unknown>,
): string {
  return (
      getString(clientObject, "uplinkRemotePort") ||
      getString(clientObject, "uplink_remote_port") ||
      getString(clientObject, "uplinkPort") ||
      getString(clientObject, "uplink_port") ||
      getString(clientObject, "uplinkPortIdx") ||
      getString(clientObject, "uplink_port_idx") ||
      getString(clientObject, "uplinkPortIndex") ||
      getString(clientObject, "uplink_port_index") ||
      getString(clientObject, "sw_port") ||
      getString(clientObject, "switchPort") ||
      getString(clientObject, "switch_port") ||
      getString(clientObject, "switchPortIdx") ||
      getString(clientObject, "switch_port_idx") ||
      getString(clientObject, "port") ||
      getString(clientObject, "portNumber") ||
      getString(clientObject, "port_number") ||
      getString(clientObject, "portIndex") ||
      getString(clientObject, "port_index") ||
      getString(clientObject, "port_idx") ||
      getString(clientObject, "portIdx") ||
      getString(clientObject, "uplinkSourcePort") ||
      getString(clientObject, "uplink_source_port") ||
      getString(clientObject, "uplinkSourcePortIdx") ||
      getString(clientObject, "uplink_source_port_idx") ||
      getString(clientObject, "uplinkSourcePortIndex") ||
      getString(clientObject, "uplink_source_port_index") ||
      getString(uplink, "remotePort") ||
      getString(uplink, "remote_port") ||
      getString(uplink, "remotePortIdx") ||
      getString(uplink, "remote_port_idx") ||
      getString(uplink, "remotePortIndex") ||
      getString(uplink, "remote_port_index") ||
      getString(uplink, "portIdx") ||
      getString(uplink, "portIndex") ||
      getString(uplink, "port_index") ||
      getString(uplink, "port") ||
      getString(uplink, "port_idx") ||
      getString(uplink, "portNumber") ||
      getString(uplink, "port_number") ||
      getString(uplink, "uplinkPort") ||
      getString(uplink, "uplink_port") ||
      getString(uplink, "uplinkPortIdx") ||
      getString(uplink, "uplink_port_idx") ||
      getString(uplink, "uplinkSourcePort") ||
      getString(uplink, "uplink_source_port") ||
      getString(uplink, "uplinkSourcePortIdx") ||
      getString(uplink, "uplink_source_port_idx")
  );
}

function getNestedUplinkEntries(clientObject: Record<string, unknown>): Record<string, unknown>[] {
  return [
    clientObject.uplink,
    clientObject.uplinkTable,
    clientObject.uplink_table,
    clientObject.uplinks,
    clientObject.uplinkDevices,
    clientObject.uplink_devices,
    clientObject.uplinkSource,
    clientObject.uplink_source,
    clientObject.lastUplink,
    clientObject.last_uplink,
    clientObject.wiredUplink,
    clientObject.wired_uplink,
    clientObject.parentDevice,
    clientObject.parent_device,
  ].flatMap((value) => {
    if (Array.isArray(value)) return value.map(asRecord);
    const record = asRecord(value);
    return Object.keys(record).length ? [record] : [];
  });
}

function getPortState(port: Record<string, unknown>): string {
  if (typeof port.up === "boolean") return port.up ? "UP" : "DOWN";
  return getString(port, "state");
}

function getPortIndex(port: Record<string, unknown>, fallbackIndex: number): string {
  return (
    getString(port, "port_idx") ||
    getString(port, "portIdx") ||
    getString(port, "idx") ||
    getString(port, "port") ||
    getString(port, "portNumber") ||
    String(fallbackIndex + 1)
  );
}

function getPortDisplayLabel(index: string, name: string, connector: string): string {
  const indexNumber = Number(index);
  const nameNumber = Number(name.match(/\d+/)?.[0]);
  const nameLooksLikePortAlias = /^port\s+\d+$/i.test(name.trim());
  const nameLooksLikeSfpAlias = /\bsfp|sfp\+|sfpplus/i.test(name);

  if (Number.isFinite(indexNumber) && indexNumber > 0) {
    if (!name || nameLooksLikePortAlias || nameLooksLikeSfpAlias || Number.isFinite(nameNumber)) {
      return String(indexNumber);
    }
  }

  return name || (connector ? `${index} ${connector}` : index);
}

function getPortMacs(port: Record<string, unknown>): string[] {
  const macTable = port.mac_table;
  if (Array.isArray(macTable)) {
    return macTable
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const record = asRecord(entry);
        return getString(record, "mac") || getString(record, "macAddress");
      })
      .filter(Boolean);
  }

  const directMacs = [
    getString(port, "mac"),
    getString(port, "macAddress"),
    getString(port, "connectedMac"),
    getString(port, "connected_mac"),
  ].filter(Boolean);

  return uniqueStrings(directMacs);
}

function getMacCandidates(record: Record<string, unknown>): string[] {
  const nestedRecords = [
    asRecord(record.device),
    asRecord(record.client),
    asRecord(record.connectedDevice),
    asRecord(record.connectedClient),
    asRecord(record.uplink),
    asRecord(record.uplinkDevice),
    asRecord(record.uplink_device),
  ];
  const values = [
    getString(record, "mac"),
    getString(record, "macAddress"),
    getString(record, "mac_address"),
    getString(record, "deviceMac"),
    getString(record, "device_mac"),
    getString(record, "wiredMac"),
    getString(record, "wired_mac"),
    getString(record, "ethernetMac"),
    getString(record, "ethernet_mac"),
    getString(record, "connectedMac"),
    getString(record, "connected_mac"),
    getString(record, "apMac"),
    getString(record, "ap_mac"),
    getString(record, "cameraMac"),
    getString(record, "camera_mac"),
    ...nestedRecords.flatMap((item) => [
      getString(item, "mac"),
      getString(item, "macAddress"),
      getString(item, "mac_address"),
      getString(item, "deviceMac"),
      getString(item, "device_mac"),
    ]),
  ];

  return uniqueStrings(values.map(normalizeMac).filter(Boolean));
}

function findClientByPort(
  device: Record<string, unknown>,
  portIndex: string,
  clientsByPort: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const deviceIds = uniqueStrings([
    getString(device, "_id"),
    getString(device, "id"),
    getString(device, "deviceId"),
    getString(device, "device_id"),
    getString(device, "mac"),
    getString(device, "macAddress"),
    getString(device, "mac_address"),
    getString(device, "name"),
    getString(device, "displayName"),
    getString(device, "display_name"),
    ...getMacCandidates(device),
  ]);

  for (const deviceId of deviceIds) {
    const client = clientsByPort.get(makePortClientKey(deviceId, portIndex));
    if (client) return client;
  }

  return undefined;
}

function getPortEndpointName(
  port: Record<string, unknown>,
  client: Record<string, unknown> | undefined,
  macs: string[],
  state: string,
): string {
  const connectedDevice = asRecord(port.connectedDevice);
  const connectedClient = asRecord(port.connectedClient);
  const access = asRecord(port.access);
  const accessDevice = asRecord(port.accessDevice);
  const accessHub = asRecord(port.accessHub);
  const uaHub = asRecord(port.uaHub);
  const door = asRecord(port.door);
  const reader = asRecord(port.reader);
  const lldp = asRecord(port.lldp);
  const macEntry = asRecord(Array.isArray(port.mac_table) ? port.mac_table[0] : undefined);
  const hasEndpointEvidence = hasPortEndpointEvidence(port, client, macs, state);
  const accessEndpointName = getPreferredAccessEndpointName(
    port,
    client,
    connectedDevice,
    connectedClient,
    accessHub,
    uaHub,
    accessDevice,
    access,
    reader,
    door,
  );

  return (
    getClientName(client) ||
    getSpecificManagedEndpointName(
      getString(connectedDevice, "name"),
      getString(connectedDevice, "hostname"),
      getString(connectedClient, "name"),
      getString(connectedClient, "hostname"),
      getString(accessHub, "name"),
      getString(accessHub, "displayName"),
      getString(accessHub, "display_name"),
      getString(uaHub, "name"),
      getString(uaHub, "displayName"),
      getString(uaHub, "display_name"),
      getString(accessDevice, "name"),
      getString(accessDevice, "displayName"),
      getString(accessDevice, "display_name"),
      getString(access, "name"),
      getString(access, "displayName"),
      getString(access, "display_name"),
      getString(reader, "name"),
      getString(reader, "displayName"),
      getString(door, "name"),
      getString(door, "displayName"),
      getString(lldp, "systemName"),
      getString(lldp, "system_name"),
      getString(macEntry, "name"),
      getString(macEntry, "hostname"),
    ) ||
    (hasEndpointEvidence
      ? accessEndpointName ||
        getSpecificManagedEndpointName(
          getString(port, "uaHubName"),
          getString(port, "ua_hub_name"),
          getString(port, "accessHubName"),
          getString(port, "access_hub_name"),
          getString(port, "accessDeviceName"),
          getString(port, "access_device_name"),
          getString(port, "readerName"),
          getString(port, "reader_name"),
          getString(port, "doorName"),
          getString(port, "door_name"),
          getString(port, "connectedTo"),
          getString(port, "connected_to"),
          getString(port, "connectedDeviceName"),
          getString(port, "connected_device_name"),
          getString(port, "clientName"),
          getString(port, "client_name"),
          getString(port, "hostname"),
          getAccessEndpointName(port),
          getConfiguredPortEndpointName(port, state),
        )
      : "") ||
    macs[0] ||
    formatUnknownPortEndpoint(state)
  );
}

function hasPortEndpointEvidence(
  port: Record<string, unknown>,
  client: Record<string, unknown> | undefined,
  macs: string[],
  state: string,
): boolean {
  if (client || macs.length > 0) return true;
  if (!isPortActiveState(state)) return false;

  const evidenceRecords = [
    asRecord(port.connectedDevice),
    asRecord(port.connectedClient),
    asRecord(port.lldp),
    asRecord(port.access),
    asRecord(port.accessDevice),
    asRecord(port.accessHub),
    asRecord(port.uaHub),
    asRecord(port.door),
    asRecord(port.reader),
  ];
  if (evidenceRecords.some((record) => Object.keys(record).length > 0)) return true;

  return hasActivePoeDraw(port) || hasActiveLinkSpeed(port);
}

function getSpecificManagedEndpointName(...values: string[]): string {
  return values.find((value) => value && !isGenericManagedEndpointName(value)) || "";
}

function getConfiguredPortEndpointName(port: Record<string, unknown>, state: string): string {
  if (!isPortActiveState(state)) return "";

  const candidates = [
    getString(port, "name"),
    getString(port, "portName"),
    getString(port, "port_name"),
    getString(port, "label"),
    getString(port, "alias"),
    getString(port, "description"),
    getString(port, "comment"),
    getString(port, "notes"),
  ].filter(Boolean);

  return candidates.find((candidate) => !isGenericPortName(candidate)) || "";
}

function isPortActiveState(state: string): boolean {
  const normalized = state.toLowerCase();
  return Boolean(normalized) && !normalized.includes("down") && !normalized.includes("disabled");
}

function hasActivePoeDraw(port: Record<string, unknown>): boolean {
  const poe = asRecord(port.poe);
  const values = [
    getString(port, "poe_power"),
    getString(port, "poePower"),
    getString(port, "poe_power_mw"),
    getString(port, "poePowerMw"),
    getString(port, "power"),
    getString(port, "powerDraw"),
    getString(port, "power_draw"),
    getString(poe, "power"),
    getString(poe, "powerDraw"),
    getString(poe, "power_draw"),
    getString(poe, "powerMw"),
    getString(poe, "power_mw"),
  ];

  return values.some((value) => Number(value) > 0);
}

function hasActiveLinkSpeed(port: Record<string, unknown>): boolean {
  const values = [
    getString(port, "speed"),
    getString(port, "speedMbps"),
    getString(port, "speed_mbps"),
    getString(port, "linkSpeed"),
    getString(port, "link_speed"),
  ];

  return values.some((value) => {
    const speed = Number(value);
    return Number.isFinite(speed) && speed > 0;
  });
}

function isGenericPortName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    !normalized ||
    /^port\s*\d+$/.test(normalized) ||
    /^\d+$/.test(normalized) ||
    /^sfp\+?\s*\d*$/.test(normalized) ||
    ["lan", "wan", "uplink", "downlink", "mgmt", "management"].includes(normalized)
  );
}

function getClientName(client: Record<string, unknown> | undefined): string {
  if (!client) return "";
  const ucoreDevice = asRecord(client.unifi_device_info_from_ucore);
  const user = asRecord(client.user);
  const device = asRecord(client.device);
  const display = asRecord(client.display);
  const access = asRecord(client.access);
  const accessDevice = asRecord(client.accessDevice);
  const accessHub = asRecord(client.accessHub);
  const uaHub = asRecord(client.uaHub);
  const door = asRecord(client.door);
  const reader = asRecord(client.reader);
  const accessEndpointName = getPreferredAccessEndpointName(
    client,
    accessHub,
    uaHub,
    accessDevice,
    access,
    reader,
    door,
    device,
    display,
  );

  const candidates = [
    accessEndpointName ||
      getString(client, "fixedName") ||
    getString(client, "fixed_name") ||
    getString(client, "userName") ||
    getString(client, "user_name") ||
    getString(client, "uiName") ||
    getString(client, "ui_name") ||
    getString(client, "nickname") ||
    getString(ucoreDevice, "name") ||
    getString(ucoreDevice, "displayName") ||
    getString(ucoreDevice, "display_name") ||
    getString(client, "name") ||
    getString(client, "display_name") ||
    getString(client, "displayName") ||
    getString(client, "label") ||
    getString(client, "alias") ||
    getString(client, "hostname") ||
    getString(client, "hostnameOrIp") ||
    getString(client, "host_name") ||
    getString(client, "hostName") ||
    getString(client, "clientName") ||
    getString(client, "client_name") ||
    getString(client, "deviceName") ||
    getString(client, "device_name") ||
    getAccessEndpointName(client) ||
    getString(client, "uaHubName") ||
    getString(client, "ua_hub_name") ||
    getString(client, "accessHubName") ||
    getString(client, "access_hub_name") ||
    getString(client, "accessDeviceName") ||
    getString(client, "access_device_name") ||
    getString(client, "readerName") ||
    getString(client, "reader_name") ||
    getString(client, "doorName") ||
    getString(client, "door_name") ||
    getString(user, "name") ||
    getString(user, "displayName") ||
    getString(device, "name") ||
    getString(device, "displayName") ||
    getString(display, "name") ||
    getString(display, "label") ||
    getString(ucoreDevice, "computed_model") ||
    getString(ucoreDevice, "product_model") ||
    getString(ucoreDevice, "product_shortname") ||
    getString(accessHub, "name") ||
    getString(accessHub, "displayName") ||
    getString(accessHub, "display_name") ||
    getString(uaHub, "name") ||
    getString(uaHub, "displayName") ||
    getString(uaHub, "display_name") ||
    getString(accessDevice, "name") ||
    getString(accessDevice, "displayName") ||
    getString(accessDevice, "display_name") ||
    getString(access, "name") ||
    getString(access, "displayName") ||
    getString(access, "display_name") ||
    getString(reader, "name") ||
    getString(reader, "displayName") ||
    getString(door, "name") ||
    getString(door, "displayName") ||
    getString(client, "userFriendlyName") ||
    getString(client, "user_friendly_name")
  ].filter(Boolean);

  return candidates.find((candidate) => !isGenericManagedEndpointName(candidate)) || "";
}

function getPreferredAccessEndpointName(...sources: Array<Record<string, unknown> | undefined>): string {
  const candidates = uniqueStrings(
    sources
      .filter((source): source is Record<string, unknown> => Boolean(source && Object.keys(source).length))
      .flatMap((source) => collectAccessNameCandidates(source)),
  ).map(normalizeAccessDisplayName);
  const specificName = candidates.find((candidate) => candidate && !isGenericAccessDisplayName(candidate));

  return specificName || "";
}

function collectAccessNameCandidates(source: Record<string, unknown>): string[] {
  const directCandidates = getAccessNameCandidateStrings(source, recordLooksLikeAccess(source, "root"));
  const nestedCandidates = findNestedAccessNames(source);

  return [...directCandidates, ...nestedCandidates];
}

function getAccessEndpointName(source: Record<string, unknown>): string {
  const directName =
    getFirstString(source, [
      "uaHubName",
      "ua_hub_name",
      "accessHubName",
      "access_hub_name",
      "accessDeviceName",
      "access_device_name",
      "accessName",
      "access_name",
      "readerName",
      "reader_name",
      "doorName",
      "door_name",
    ]) ||
    (recordLooksLikeAccess(source)
      ? getFirstString(source, [
      "deviceName",
      "device_name",
      "displayName",
      "display_name",
      "modelDisplayName",
      "model_display_name",
      "productName",
      "product_name",
      "friendlyName",
      "friendly_name",
      "userFriendlyName",
      "user_friendly_name",
      "name",
      "model",
      "shortname",
      "type",
        ])
      : "") ||
    findNestedAccessName(source);

  if (!directName) return "";
  return normalizeAccessDisplayName(directName);
}

function getAccessNameCandidateStrings(record: Record<string, unknown>, includeGenericKeys: boolean): string[] {
  const directKeys = [
    "doorName",
    "door_name",
    "readerName",
    "reader_name",
    "accessDeviceName",
    "access_device_name",
    "accessHubName",
    "access_hub_name",
    "uaHubName",
    "ua_hub_name",
    "friendlyName",
    "friendly_name",
    "userFriendlyName",
    "user_friendly_name",
    "label",
    "alias",
  ];
  const genericKeys = includeGenericKeys
    ? [
        "name",
        "displayName",
        "display_name",
        "deviceName",
        "device_name",
        "modelDisplayName",
        "model_display_name",
        "productName",
        "product_name",
      ]
    : [];

  return [...directKeys, ...genericKeys].map((key) => getString(record, key)).filter(Boolean);
}

function findNestedAccessNames(source: Record<string, unknown>): string[] {
  const queue: Array<{ keyPath: string; value: unknown }> = Object.entries(source).map(([key, value]) => ({
    keyPath: key,
    value,
  }));
  const seen = new Set<unknown>();
  const candidates: string[] = [];

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    if (!item.value || seen.has(item.value)) continue;
    seen.add(item.value);

    if (Array.isArray(item.value)) {
      item.value.forEach((value, index) => queue.push({ keyPath: `${item.keyPath}.${index}`, value }));
      continue;
    }

    if (typeof item.value !== "object") continue;
    const record = asRecord(item.value);
    const looksLikeAccess = recordLooksLikeAccess(record, item.keyPath);
    candidates.push(...getAccessNameCandidateStrings(record, looksLikeAccess));

    Object.entries(record).forEach(([key, value]) => {
      if (value && typeof value === "object") {
        queue.push({ keyPath: `${item.keyPath}.${key}`, value });
      }
    });
  }

  return candidates;
}

function findNestedAccessName(source: Record<string, unknown>): string {
  const queue: Array<{ keyPath: string; value: unknown }> = Object.entries(source).map(([key, value]) => ({
    keyPath: key,
    value,
  }));
  const seen = new Set<unknown>();

  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    if (!item.value || seen.has(item.value)) continue;
    seen.add(item.value);

    if (Array.isArray(item.value)) {
      item.value.forEach((value, index) => queue.push({ keyPath: `${item.keyPath}.${index}`, value }));
      continue;
    }

    if (typeof item.value !== "object") continue;
    const record = asRecord(item.value);
    const looksLikeAccess = recordLooksLikeAccess(record, item.keyPath);

    if (looksLikeAccess) {
      const name = getFirstString(record, [
        "name",
        "displayName",
        "display_name",
        "label",
        "alias",
        "deviceName",
        "device_name",
        "modelDisplayName",
        "model_display_name",
        "productName",
        "product_name",
        "friendlyName",
        "friendly_name",
        "shortname",
        "model",
        "type",
      ]);
      if (name) return name;
    }

    Object.entries(record).forEach(([key, value]) => {
      if (value && typeof value === "object") {
        queue.push({ keyPath: `${item.keyPath}.${key}`, value });
      }
    });
  }

  return "";
}

function recordLooksLikeAccess(record: Record<string, unknown>, keyPath = ""): boolean {
  const objectText = [
    keyPath,
    getString(record, "type"),
    getString(record, "deviceType"),
    getString(record, "device_type"),
    getString(record, "model"),
    getString(record, "shortname"),
    getString(record, "productName"),
    getString(record, "product_name"),
    getString(record, "modelDisplayName"),
    getString(record, "model_display_name"),
    getString(record, "displayName"),
    getString(record, "display_name"),
    getString(record, "name"),
  ]
    .join(" ")
    .toLowerCase();

  return (
    /\bua\b/.test(objectText) ||
    objectText.includes("access") ||
    objectText.includes("reader") ||
    objectText.includes("door") ||
    objectText.includes("hub") ||
    objectText.includes("ultra") ||
    objectText.includes("mini")
  );
}

function getFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = getString(record, key);
    if (value) return value;
  }

  return "";
}

function normalizeAccessDisplayName(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase().replace(/[\s_-]+/g, " ");

  if (normalized === "ua hub door mini" || normalized === "uahubdoormini") return "UA Hub Door Mini";
  if (normalized === "ua ultra" || normalized === "ua reader ultra" || normalized === "uareaderultra") return "UA Ultra";
  if (normalized.includes("hub door mini")) return trimmed.replace(/ua[-_\s]*/i, "UA ");
  if (normalized.includes("reader ultra") || normalized.includes("ua ultra")) return trimmed.replace(/ua[-_\s]*/i, "UA ");

  return trimmed;
}

function isGenericAccessDisplayName(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  const genericNames = new Set([
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

function isGenericManagedEndpointName(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/[^a-z0-9+ ]/g, "")
    .trim();
  const compact = normalized.replace(/\s+/g, "");

  return (
    isGenericAccessDisplayName(value) ||
    [
      "access point",
      "ap",
      "camera",
      "protect camera",
      "unifi camera",
      "u6+",
      "u6 plus",
      "u6plus",
      "u7 pro",
      "u7 pro outdoor",
      "u7pro",
      "u7prooutdoor",
      "ua ultra",
      "uaultra",
      "ua hub door mini",
      "uahubdoormini",
    ].includes(normalized) ||
    [
      "accesspoint",
      "protectcamera",
      "unificamera",
      "u6plus",
      "u7pro",
      "u7prooutdoor",
      "uaultra",
      "uahubdoormini",
    ].includes(compact)
  );
}

function getClientMac(client: Record<string, unknown> | undefined): string {
  if (!client) return "";
  return getMacCandidates(client)[0] || "";
}

function getClientIp(client: Record<string, unknown> | undefined): string {
  if (!client) return "";
  return getString(client, "ip") || getString(client, "ipAddress") || getString(client, "ip_address");
}

function inferEndpointType(name: string, source: Record<string, unknown>): string {
  const ucoreDevice = asRecord(source.unifi_device_info_from_ucore);
  const value = [
    name,
    getString(source, "type"),
    getString(source, "deviceType"),
    getString(source, "devCat"),
    getString(source, "category"),
    getString(source, "model"),
    getString(source, "osName"),
    getString(source, "uaHubName"),
    getString(source, "accessHubName"),
    getString(source, "readerName"),
    getString(source, "doorName"),
    getAccessEndpointName(source),
    getString(ucoreDevice, "name"),
    getString(ucoreDevice, "product_line"),
    getString(ucoreDevice, "computed_model"),
    getString(ucoreDevice, "product_model"),
    getString(ucoreDevice, "product_shortname"),
  ]
    .join(" ")
    .toLowerCase();

  if (!value || value.includes("open") || value.includes("no client")) return "";
  if (
    value.includes("door reader") ||
    value.includes("reader") ||
    value.includes("ua-reader") ||
    value.includes("ua reader") ||
    value.includes("g2 reader") ||
    value.includes("door access") ||
    value.includes("access ultra") ||
    value.includes("ua ultra") ||
    value.includes("product_line access")
  ) {
    return "door-reader";
  }
  if (
    value.includes("card terminal") ||
    value.includes("payment terminal") ||
    value.includes("credit card") ||
    value.includes("clover") ||
    value.includes("stripe") ||
    value.includes("verifone")
  ) {
    return "card-terminal";
  }
  if (value.includes("printer") || value.includes("print")) return "printer";
  if (value.includes("phone") || value.includes("voip") || value.includes("sip")) return "phone";
  if (value.includes("camera") || value.includes("protect") || value.includes("viewport")) return "camera";
  if (value.includes("access point") || value.includes("ap ") || value.includes("u7") || value.includes("u6")) return "access-point";
  if (value.includes("server") || value.includes("nas") || value.includes("docker")) return "server";
  if (value.includes("pos") || value.includes("register") || value.includes("terminal")) return "pos";
  if (value.includes("switch") || value.includes("gateway") || value.includes("router") || value.includes("uplink")) return "network";
  if (value.includes("thermostat") || value.includes("sensor") || value.includes("iot")) return "iot";
  if (value.includes("desktop") || value.includes("laptop") || value.includes("macbook") || value.includes("pc")) {
    return "workstation";
  }
  return "unknown";
}

function getEndpointLocation(source: Record<string, unknown>): string {
  return (
    getString(source, "location") ||
    getString(source, "room") ||
    getString(source, "siteName") ||
    getString(source, "site_name")
  );
}

function getEndpointOwner(source: Record<string, unknown>): string {
  return (
    getString(source, "owner") ||
    getString(source, "user") ||
    getString(source, "username") ||
    getString(source, "userName")
  );
}

function getEndpointVendor(source: Record<string, unknown>): string {
  return (
    getString(source, "manufacturer") ||
    getString(source, "vendor") ||
    getString(source, "oui") ||
    getString(source, "brand")
  );
}

function getPortEndpointIp(port: Record<string, unknown>): string {
  const connectedDevice = asRecord(port.connectedDevice);
  const connectedClient = asRecord(port.connectedClient);
  return (
    getString(port, "connectedIp") ||
    getString(port, "connected_ip") ||
    getString(port, "ip") ||
    getString(connectedDevice, "ip") ||
    getString(connectedDevice, "ipAddress") ||
    getString(connectedClient, "ip") ||
    getString(connectedClient, "ipAddress")
  );
}

function makePortClientKey(deviceId: string, portIndex: string): string {
  return `${normalizeMac(deviceId) || toId(deviceId)}:${toId(portIndex)}`;
}

function formatUnknownPortEndpoint(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "down") return "Open";
  if (normalized === "up") return "Link up, no client reported";
  return state || "Open";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeMac(value: string): string {
  return value.toLowerCase().replace(/[^a-f0-9]/g, "");
}

function buildDeviceConnections(
  deviceRecords: unknown[],
  rackAliases: Map<string, string>,
): InventoryState["connections"] {
  const deviceNamesById = new Map<string, string>();
  const rackIdsByDeviceId = new Map<string, string>();

  deviceRecords.forEach((device, index) => {
    const record = asRecord(device);
    const id = getString(record, "id");
    if (!id) return;

    const name =
      getString(record, "name") ||
      getString(record, "displayName") ||
      getString(record, "model") ||
      `UniFi device ${index + 1}`;
    deviceNamesById.set(id, name);
    rackIdsByDeviceId.set(id, findRackIdForDevice(record, rackAliases) ?? "rack-unassigned");
  });

  return deviceRecords.flatMap((device, index) => {
    const record = asRecord(device);
    const id = getString(record, "id");
    const uplink = asRecord(record.uplink);
    const uplinkDeviceId = getString(uplink, "deviceId");

    if (!id || !uplinkDeviceId || !deviceNamesById.has(uplinkDeviceId)) return [];

    const childName = deviceNamesById.get(id) ?? `UniFi device ${index + 1}`;
    const parentName = deviceNamesById.get(uplinkDeviceId) ?? "Uplink device";

    return [
      {
        id: `uplink-${toId(uplinkDeviceId)}-${toId(id)}`,
        fromRackId: rackIdsByDeviceId.get(uplinkDeviceId) ?? "rack-default",
        toRackId: rackIdsByDeviceId.get(id) ?? "rack-default",
        fromDevice: parentName,
        toDevice: childName,
        medium: "UniFi uplink",
        status: inferDeviceStatus(record) === "online" ? "active" : "constrained",
      },
    ];
  });
}

function formatSpeed(value: string): string {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed <= 0) return "Auto";
  if (speed >= 1000) return `${speed / 1000}G`;
  return `${speed}M`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstRecordWithValues(...records: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return records.find((record) => record && Object.keys(record).length > 0) ?? {};
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function getHostIdentifier(record: Record<string, unknown>): string {
  return (
    getString(record, "hostId") ||
    getString(record, "host_id") ||
    getString(record, "consoleId") ||
    getString(record, "console_id") ||
    getString(record, "ucoreId") ||
    getString(record, "ucore_id") ||
    getString(record, "id")
  );
}

function toId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "default";
}

function normalizeControllerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
