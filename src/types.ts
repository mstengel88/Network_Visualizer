export type DeviceStatus = "online" | "attention" | "planned";

export type DeviceType =
  | "gateway"
  | "switch"
  | "patch"
  | "server"
  | "power"
  | "fan"
  | "blank"
  | "raspberry-pi"
  | "nvr"
  | "modem"
  | "shelf";

export type Business = {
  id: string;
  name: string;
  sites: string[];
};

export type Rack = {
  id: string;
  businessId: string;
  site: string;
  name: string;
  sizeU: number;
  role: string;
};

export type Port = {
  id: string;
  label: string;
  speed: string;
  vlan?: string;
  connectedTo?: string;
  importedEndpointName?: string;
  patchConnection?: string;
  connectedMac?: string;
  connectedIp?: string;
  endpointType?: string;
  endpointLocation?: string;
  endpointOwner?: string;
  endpointVendor?: string;
  endpointNotes?: string;
  poeMode?: string;
  stp?: string;
  wireUse?: string;
  wireColor?: string;
};

export type Device = {
  id: string;
  rackId: string;
  name: string;
  model: string;
  type: DeviceType;
  uStart: number;
  heightU: number;
  status: DeviceStatus;
  locked?: boolean;
  ip?: string;
  ports: Port[];
};

export type Connection = {
  id: string;
  fromRackId: string;
  toRackId: string;
  fromDevice: string;
  toDevice: string;
  medium: string;
  status: "active" | "constrained" | "planned";
};

export type InventoryState = {
  businesses: Business[];
  racks: Rack[];
  devices: Device[];
  connections: Connection[];
};

export type UniFiConnectionMode = "cloud" | "local";

export type UniFiAccountProfile = {
  id: string;
  label: string;
  mode: UniFiConnectionMode;
  controllerUrl: string;
  siteId: string;
  apiToken: string;
  lastTestedAt?: string;
  status: "not-tested" | "connected" | "failed";
  statusMessage?: string;
};
