import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  Activity,
  Cable,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  DatabaseZap,
  Download,
  EthernetPort,
  FileJson,
  Filter,
  KeyRound,
  Layers3,
  LockKeyhole,
  Network,
  Plus,
  Power,
  Printer,
  RefreshCw,
  Route,
  Save,
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  businesses as sampleBusinesses,
  connections as sampleConnections,
  devices as sampleDevices,
  racks as sampleRacks,
} from "./data";
import {
  applyLayoutOverrides,
  clearLocalPlanningData,
  deleteCustomDevice,
  moveDeviceInInventory,
  saveDeviceEdits,
  saveBusinessEdits,
  saveCustomDevice,
  saveCustomRack,
  saveRackEdits,
} from "./layoutOverrides";
import {
  clearUniFiAccount,
  loadUniFiAccount,
  maskToken,
  saveUniFiAccount,
  syncUniFiInventory,
  testUniFiConnection,
} from "./unifiAuth";
import {
  createPlanSnapshot,
  downloadPlanSnapshot,
  listSavedPlans,
  loadSavedPlan,
  parsePlanSnapshot,
  savePlanSnapshot,
  type PlanSnapshot,
  type SavedPlanSummary,
} from "./planPersistence";
import type {
  Device,
  DeviceType,
  DeviceStatus,
  InventoryState,
  Rack as RackType,
  UniFiAccountProfile,
} from "./types";

const statusLabels: Record<DeviceStatus, string> = {
  online: "Online",
  attention: "Needs review",
  planned: "Planned",
};

const wireUseOptions = [
  { label: "Data", value: "data", color: "#69e0a3" },
  { label: "Voice", value: "voice", color: "#38a5ff" },
  { label: "Camera", value: "camera", color: "#f0c84b" },
  { label: "AP", value: "access-point", color: "#38a5ff" },
  { label: "Printer", value: "printer", color: "#f59e0b" },
  { label: "Door Reader", value: "door-reader", color: "#a78bfa" },
  { label: "Card Terminal", value: "card-terminal", color: "#22d3ee" },
  { label: "Uplink", value: "uplink", color: "#c084fc" },
  { label: "Guest", value: "guest", color: "#fb923c" },
  { label: "Server", value: "server", color: "#f472b6" },
  { label: "POS", value: "pos", color: "#22d3ee" },
  { label: "Custom", value: "custom", color: "#69e0a3" },
];

const endpointTypeOptions = [
  { label: "Unknown", value: "", color: "transparent" },
  { label: "Workstation", value: "workstation", color: "#94a3b8" },
  { label: "AP", value: "access-point", color: "#38a5ff" },
  { label: "Printer", value: "printer", color: "#f59e0b" },
  { label: "Door Reader", value: "door-reader", color: "#a78bfa" },
  { label: "Card Terminal", value: "card-terminal", color: "#22d3ee" },
  { label: "Phone", value: "phone", color: "#7dd3fc" },
  { label: "Camera", value: "camera", color: "#facc15" },
  { label: "Server", value: "server", color: "#f472b6" },
  { label: "POS", value: "pos", color: "#2dd4bf" },
  { label: "IoT", value: "iot", color: "#86efac" },
  { label: "Network gear", value: "network", color: "#60a5fa" },
  { label: "Uplink", value: "uplink", color: "#c084fc" },
  { label: "Other", value: "other", color: "#c8d7d0" },
];

const INVENTORY_STORAGE_KEY = "unifi-rack-planner.last-inventory";
const initialInventory = loadInitialInventory();

type PendingPortLink = {
  deviceId: string;
  portId: string;
};

type ActivePage = "rack" | "reports";

function App() {
  const [inventory, setInventory] = useState<InventoryState>(() => initialInventory);
  const [businessId, setBusinessId] = useState(initialInventory.businesses[0]?.id ?? "");
  const [selectedRackId, setSelectedRackId] = useState(initialInventory.racks[0]?.id ?? "");
  const [activePage, setActivePage] = useState<ActivePage>("rack");
  const [query, setQuery] = useState("");
  const [importNotice, setImportNotice] = useState("No account data imported yet");
  const [account, setAccount] = useState<UniFiAccountProfile | null>(() => loadUniFiAccount());
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [pendingPortLink, setPendingPortLink] = useState<PendingPortLink | null>(null);
  const [portLinkNotice, setPortLinkNotice] = useState("Click one port, then another port to link them.");
  const [showWireVisualizer, setShowWireVisualizer] = useState(false);
  const [saveNotice, setSaveNotice] = useState("Plan has not been saved to server yet");
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [showPortPanel, setShowPortPanel] = useState(false);
  const [showPlanLibrary, setShowPlanLibrary] = useState(false);
  const [savedPlans, setSavedPlans] = useState<SavedPlanSummary[]>([]);
  const [isLoadingPlans, setIsLoadingPlans] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const business = inventory.businesses.find((item) => item.id === businessId) ?? inventory.businesses[0];
  const visibleRacks = inventory.racks.filter((rack) => rack.businessId === business.id);
  const selectedRack = visibleRacks.find((rack) => rack.id === selectedRackId) ?? visibleRacks[0];
  const rackDevices = selectedRack
    ? inventory.devices.filter((device) => device.rackId === selectedRack.id)
    : [];
  const selectedDevice = selectedDeviceId
    ? inventory.devices.find((device) => device.id === selectedDeviceId) ?? null
    : null;

  useEffect(() => {
    window.localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
  }, [inventory]);

  const filteredPorts = useMemo(() => {
    const lower = query.toLowerCase();
    return rackDevices.flatMap((device) =>
      device.ports
        .filter((port) => {
          if (!lower) return true;
          const displayPort = getPhysicalFaceplatePort(device, port);
          return [
            device.name,
            device.model,
            port.label,
            displayPort.label,
            port.vlan,
            port.connectedTo,
            port.connectedIp,
            port.connectedMac,
            port.endpointType,
            port.endpointLocation,
            port.endpointOwner,
            port.endpointVendor,
            port.endpointNotes,
          ]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(lower));
        })
        .map((port) => ({ ...getPhysicalFaceplatePort(device, port), device })),
    );
  }, [query, rackDevices]);

  const portConnections = buildPortConnections(inventory.devices);

  const activeConnections = [...inventory.connections, ...portConnections].filter(
    (connection) =>
      visibleRacks.some((rack) => rack.id === connection.fromRackId) &&
      visibleRacks.some((rack) => rack.id === connection.toRackId),
  );
  const rackConnections = selectedRack
    ? activeConnections.filter(
        (connection) => connection.fromRackId === selectedRack.id || connection.toRackId === selectedRack.id,
      )
    : [];

  function handleInventorySynced(nextInventory: InventoryState, message: string) {
    const mergedInventory = mergeSyncedInventoryIntoCurrentPlan(
      inventory,
      nextInventory,
      business.id,
      selectedRack?.id,
    );
    const inventoryWithLayout = applyLayoutOverrides(mergedInventory);
    const nextBusinessId = inventoryWithLayout.businesses.some((item) => item.id === business.id)
      ? business.id
      : inventoryWithLayout.businesses[0]?.id ?? "";
    const nextRackId = selectedRack && inventoryWithLayout.racks.some((rack) => rack.id === selectedRack.id)
      ? selectedRack.id
      : inventoryWithLayout.racks.find((rack) => rack.businessId === nextBusinessId)?.id ?? "";

    persistInventory(inventoryWithLayout);
    setInventory(inventoryWithLayout);
    setBusinessId(nextBusinessId);
    setSelectedRackId(nextRackId);
    setImportNotice(`${message}; updated the currently loaded site instead of creating a new one`);
  }

  function handleDeviceMoved(deviceId: string, rackId: string, uStart: number) {
    setInventory((currentInventory) => {
      if (!canMoveDeviceToUnit(currentInventory.devices, deviceId, rackId, uStart)) return currentInventory;
      return moveDeviceInInventory(currentInventory, deviceId, rackId, uStart);
    });
    setSelectedRackId(rackId);
    setPendingPortLink(null);
  }

  function handleDeviceUpdated(updatedDevice: Device) {
    saveDeviceEdits(updatedDevice.id, {
      name: updatedDevice.name,
      model: updatedDevice.model,
      type: updatedDevice.type,
      heightU: updatedDevice.heightU,
      status: updatedDevice.status,
      locked: updatedDevice.locked,
      ports: updatedDevice.ports,
    });
    setInventory((currentInventory) => ({
      ...currentInventory,
      devices: currentInventory.devices.map((device) =>
        device.id === updatedDevice.id ? updatedDevice : device,
      ),
    }));
  }

  function handleDeviceDeleted(deviceId: string) {
    const device = inventory.devices.find((item) => item.id === deviceId);
    if (!device || !isCustomDevice(device)) return;
    const confirmed = window.confirm(`Delete ${device.name} from this plan?`);
    if (!confirmed) return;

    deleteCustomDevice(deviceId);
    setInventory((currentInventory) => ({
      ...currentInventory,
      devices: currentInventory.devices.filter((item) => item.id !== deviceId),
      connections: currentInventory.connections.filter(
        (connection) => connection.fromDevice !== device.name && connection.toDevice !== device.name,
      ),
    }));
    setSelectedDeviceId(null);
    setPendingPortLink(null);
  }

  function handleRackPortClicked(device: Device, port: Device["ports"][number]) {
    const clickedPort = device.ports.find((item) => item.id === port.id) ?? port;

    if (!pendingPortLink) {
      if (!canStartPortLinkFromDevice(device)) {
        setPortLinkNotice("Select a port on a patch panel, switch, router, server, Raspberry Pi, modem, NVR, or shelf item.");
        return;
      }

      setPendingPortLink({ deviceId: device.id, portId: clickedPort.id });
      setPortLinkNotice(
        `Selected ${device.name} port ${getPhysicalFaceplatePort(device, clickedPort).label}. Now click another port to link it.`,
      );
      return;
    }

    if (pendingPortLink.deviceId === device.id && pendingPortLink.portId === clickedPort.id) {
      setPendingPortLink(null);
      setPortLinkNotice("Port selection cleared.");
      return;
    }

    const sourceDevice = inventory.devices.find((item) => item.id === pendingPortLink.deviceId);
    const sourcePort = sourceDevice?.ports.find((item) => item.id === pendingPortLink.portId);

    if (!sourceDevice || !sourcePort) {
      setPendingPortLink(null);
      setPortLinkNotice("That starting port is no longer available. Select a port again.");
      return;
    }

    if (sourceDevice.type === "patch" && device.type === "patch") {
      setPendingPortLink({ deviceId: device.id, portId: clickedPort.id });
      setPortLinkNotice(
        `Selected ${device.name} port ${getPhysicalFaceplatePort(device, clickedPort).label}. Now click another port to link it.`,
      );
      return;
    }

    if (!canRackPortsLink(sourceDevice, device)) {
      setPortLinkNotice("Those two ports cannot be linked from the rack view.");
      return;
    }

    const sourceLabel = getPhysicalFaceplatePort(sourceDevice, sourcePort).label;
    const targetLabel = getPhysicalFaceplatePort(device, clickedPort).label;
    const sourceValue = `${sourceDevice.name} / ${sourceLabel}`;
    const targetValue = `${device.name} / ${targetLabel}`;
    const existingLink =
      portPatchPointsTo(sourcePort, targetValue) || portPatchPointsTo(clickedPort, sourceValue);
    const previousSourceLink = getPortPatchLink(sourcePort);
    const previousTargetLink = getPortPatchLink(clickedPort);
    const staleLinkValues = uniqueLinkValues([
      sourceValue,
      targetValue,
      previousSourceLink,
      previousTargetLink,
    ]);

    setInventory((currentInventory) => {
      const nextDevices = currentInventory.devices.map((currentDevice) => {
        if (currentDevice.id !== sourceDevice.id && currentDevice.id !== device.id) {
          return {
            ...currentDevice,
            ports: currentDevice.ports.map((currentPort) =>
              shouldClearAnyPortLink(currentPort, staleLinkValues)
                ? clearPatchLink(currentPort, staleLinkValues)
                : currentPort,
            ),
          };
        }

        return {
          ...currentDevice,
          ports: currentDevice.ports.map((currentPort) => {
            if (currentDevice.id === sourceDevice.id && currentPort.id === sourcePort.id) {
              return existingLink
                ? clearPatchLink(currentPort, staleLinkValues)
                : enrichPatchPortFromTarget(
                    {
                      ...currentPort,
                      connectedTo: currentDevice.type === "patch" ? targetValue : currentPort.connectedTo,
                      patchConnection: targetValue,
                      wireUse: currentPort.wireUse || "data",
                      wireColor: currentPort.wireColor || wireUseOptions[0].color,
                    },
                    clickedPort,
                    device,
                  );
            }

            if (currentDevice.id === device.id && currentPort.id === clickedPort.id) {
              return existingLink
                ? clearPatchLink(currentPort, staleLinkValues)
                : {
                    ...currentPort,
                    patchConnection: sourceValue,
                    wireUse: currentPort.wireUse || sourcePort.wireUse || "data",
                    wireColor: currentPort.wireColor || sourcePort.wireColor || wireUseOptions[0].color,
                  };
            }

            return shouldClearAnyPortLink(currentPort, staleLinkValues)
              ? clearPatchLink(currentPort, staleLinkValues)
              : currentPort;
          }),
        };
      });

      const updatedSourceDevice = nextDevices.find((item) => item.id === sourceDevice.id);
      const updatedTargetDevice = nextDevices.find((item) => item.id === device.id);
      if (updatedSourceDevice) {
        saveDeviceEdits(updatedSourceDevice.id, {
          name: updatedSourceDevice.name,
          model: updatedSourceDevice.model,
          type: updatedSourceDevice.type,
          heightU: updatedSourceDevice.heightU,
          status: updatedSourceDevice.status,
          locked: updatedSourceDevice.locked,
          ports: updatedSourceDevice.ports,
        });
      }
      if (updatedTargetDevice) {
        saveDeviceEdits(updatedTargetDevice.id, {
          name: updatedTargetDevice.name,
          model: updatedTargetDevice.model,
          type: updatedTargetDevice.type,
          heightU: updatedTargetDevice.heightU,
          status: updatedTargetDevice.status,
          locked: updatedTargetDevice.locked,
          ports: updatedTargetDevice.ports,
        });
      }

      return {
        ...currentInventory,
        devices: nextDevices,
      };
    });

    setPendingPortLink(null);
    setPortLinkNotice(
      existingLink
        ? `Removed link between ${sourceDevice.name} port ${sourceLabel} and ${device.name} port ${targetLabel}.`
        : `Linked ${sourceDevice.name} port ${sourceLabel} to ${device.name} port ${targetLabel}.`,
    );
  }

  function handleAddRack() {
    if (!selectedRack) return;

    const rackName = window.prompt("Rack name", `Rack ${visibleRacks.length + 1}`);
    if (!rackName) return;

    const sizeInput = window.prompt("Rack size in U", String(selectedRack.sizeU));
    const sizeU = Number(sizeInput);
    const rack: RackType = {
      id: `rack-${businessId}-${Date.now()}`,
      businessId,
      site: selectedRack.site,
      name: rackName,
      sizeU: Number.isFinite(sizeU) && sizeU > 0 ? sizeU : selectedRack.sizeU,
      role: "User-created rack",
    };

    saveCustomRack(rack);
    setInventory((currentInventory) => ({
      ...currentInventory,
      racks: [...currentInventory.racks, rack],
    }));
    setSelectedRackId(rack.id);
  }

  function createCurrentPlanSnapshot() {
    return createPlanSnapshot({
      inventory,
      businessId: business.id,
      businessName: business.name,
      siteId: selectedRack?.site ?? business.sites[0] ?? "default",
      siteName: selectedRack?.site ?? business.sites[0] ?? "Default",
      rackId: selectedRack?.id,
    });
  }

  async function handleSavePlan() {
    try {
      const message = await savePlanSnapshot(createCurrentPlanSnapshot());
      setSaveNotice(message);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Could not save plan");
    }
  }

  function handleExportPlan() {
    downloadPlanSnapshot(createCurrentPlanSnapshot());
    setSaveNotice("Downloaded plan JSON export");
  }

  async function handleOpenSavedPlans() {
    setShowPlanLibrary(true);
    setIsLoadingPlans(true);
    setSaveNotice("Loading saved plans from server...");

    try {
      const plans = await listSavedPlans();
      setSavedPlans(plans);
      setSaveNotice(plans.length ? `Found ${plans.length} saved plan${plans.length === 1 ? "" : "s"}` : "No saved server plans found yet");
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Could not load saved plans");
    } finally {
      setIsLoadingPlans(false);
    }
  }

  async function handleLoadSavedPlan(plan: SavedPlanSummary) {
    const confirmed = window.confirm(
      `Load the saved plan for ${plan.businessName} / ${plan.siteName}? This replaces the current browser project.`,
    );
    if (!confirmed) return;

    setIsLoadingPlans(true);
    try {
      const snapshot = await loadSavedPlan(plan.relativePath);
      restorePlanSnapshot(snapshot, plan.relativePath);
      setShowPlanLibrary(false);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : "Could not load saved plan");
    } finally {
      setIsLoadingPlans(false);
    }
  }

  function handleEditLabels() {
    if (!business || !selectedRack) return;

    const companyName = window.prompt("Company / business name", business.name);
    if (companyName === null) return;

    const siteName = window.prompt("Site name", selectedRack.site);
    if (siteName === null) return;

    const rackName = window.prompt("Rack name", selectedRack.name);
    if (rackName === null) return;

    const rackSizeInput = window.prompt("Rack height in U", String(selectedRack.sizeU));
    if (rackSizeInput === null) return;

    const nextCompanyName = companyName.trim() || business.name;
    const nextSiteName = siteName.trim() || selectedRack.site;
    const nextRackName = rackName.trim() || selectedRack.name;
    const nextRackSize = parsePositiveNumber(rackSizeInput, selectedRack.sizeU);
    const affectedSiteRacks = visibleRacks.filter((rack) => rack.site === selectedRack.site);

    saveBusinessEdits(business.id, {
      name: nextCompanyName,
      sites: [nextSiteName],
    });
    affectedSiteRacks.forEach((rack) => {
      saveRackEdits(rack.id, {
        site: nextSiteName,
        ...(rack.id === selectedRack.id ? { name: nextRackName, sizeU: nextRackSize } : {}),
      });
    });

    setInventory((currentInventory) => ({
      ...currentInventory,
      businesses: currentInventory.businesses.map((item) =>
        item.id === business.id
          ? {
              ...item,
              name: nextCompanyName,
              sites: [nextSiteName],
            }
          : item,
      ),
      racks: currentInventory.racks.map((rack) =>
        rack.businessId === business.id && rack.site === selectedRack.site
          ? {
              ...rack,
              name: rack.id === selectedRack.id ? nextRackName : rack.name,
              sizeU: rack.id === selectedRack.id ? nextRackSize : rack.sizeU,
              site: nextSiteName,
            }
          : rack,
      ),
    }));
  }

  function handleAddDevice() {
    if (!selectedRack) return;

    const name = window.prompt("Item name", "New patch panel");
    if (!name) return;

    const typeInput = window.prompt(
      "Item type: patch, server, switch, gateway, power, fan, blank, shelf, raspberry pi, nvr, modem",
      "patch",
    );
    const type = normalizeDeviceType(typeInput);
    const model = window.prompt("Model / description", defaultModelForType(type)) ?? defaultModelForType(type);
    const defaultHeight = defaultHeightForType(type);
    const heightInput = window.prompt("Rack height in U", String(defaultHeight));
    const portInput = window.prompt("Number of ports", String(defaultPortCountForType(type)));
    const heightU = parsePositiveNumber(heightInput, defaultHeight);
    const portCount = parsePositiveNumber(portInput, defaultPortCountForType(type));
    const device: Device = {
      id: `custom-device-${Date.now()}`,
      rackId: selectedRack.id,
      name,
      model,
      type,
      uStart: findOpenUnit(selectedRack, inventory.devices),
      heightU,
      status: "planned",
      locked: false,
      ports: createPorts(portCount, type),
    };

    saveCustomDevice(device);
    setInventory((currentInventory) => ({
      ...currentInventory,
      devices: [...currentInventory.devices, device],
    }));
    setSelectedDeviceId(device.id);
  }

  async function handleImport(file: File | undefined) {
    if (!file) return;

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const snapshot = parsePlanSnapshot(payload);

      if (!snapshot) {
        setImportNotice(`Could not restore ${file.name}. Choose a rack-plan JSON export from this app.`);
        return;
      }

      const confirmed = window.confirm(
        `Restore ${file.name} and replace the current browser project? Export the current plan first if you need a backup.`,
      );
      if (!confirmed) return;

      restorePlanSnapshot(snapshot, file.name);
    } catch {
      setImportNotice(`Could not parse ${file.name}. Choose a valid JSON rack-plan export.`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function restorePlanSnapshot(snapshot: PlanSnapshot, sourceName: string) {
    const importedInventory = normalizeShelfPorts(snapshot.inventory);
    const nextBusinessId = importedInventory.businesses.some((item) => item.id === snapshot.profile.businessId)
      ? snapshot.profile.businessId
      : importedInventory.businesses[0]?.id ?? "";
    const nextRackId = snapshot.profile.rackId && importedInventory.racks.some((rack) => rack.id === snapshot.profile.rackId)
      ? snapshot.profile.rackId
      : importedInventory.racks.find((rack) => rack.businessId === nextBusinessId)?.id ?? importedInventory.racks[0]?.id ?? "";
    const importedPorts = importedInventory.devices.reduce((sum, device) => sum + device.ports.length, 0);

    clearLocalPlanningData();
    persistInventory(importedInventory);
    setInventory(importedInventory);
    setBusinessId(nextBusinessId);
    setSelectedRackId(nextRackId);
    setSelectedDeviceId(null);
    setPendingPortLink(null);
    setActivePage("rack");
    setQuery("");

    setImportNotice(
      `Restored ${importedInventory.racks.length} racks, ${importedInventory.devices.length} devices, and ${importedPorts} ports from ${sourceName}`,
    );
    setSaveNotice(`Loaded ${snapshot.profile.businessName} / ${snapshot.profile.siteName} into this browser`);
  }

  function handleClearLocalData() {
    const confirmed = window.confirm(
      "Clear imported inventory, custom racks/items, labels, and local port overrides? Your UniFi account stays saved.",
    );
    if (!confirmed) return;

    clearLocalPlanningData();
    window.localStorage.removeItem(INVENTORY_STORAGE_KEY);

    const freshInventory = normalizeShelfPorts(applyLayoutOverrides({
      businesses: sampleBusinesses,
      racks: sampleRacks,
      devices: sampleDevices,
      connections: sampleConnections,
    }));

    setInventory(freshInventory);
    setBusinessId(freshInventory.businesses[0]?.id ?? "");
    setSelectedRackId(freshInventory.racks[0]?.id ?? "");
    setSelectedDeviceId(null);
    setPendingPortLink(null);
    setImportNotice("Local imported data cleared. Run Sync inventory for a fresh UniFi import.");
    setPortLinkNotice("Click one port, then another port to link them.");
    setSaveNotice("Local data cleared; sync again to rebuild from UniFi.");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Network navigation">
        <div className="brand">
          <div className="brand-mark">
            <ServerCog size={22} />
          </div>
          <div>
            <p>UniFi Rack Planner</p>
            <span>Inventory, labels, and port maps</span>
          </div>
        </div>

        <label className="field-label" htmlFor="business">
          Business
        </label>
        <select id="business" value={businessId} onChange={(event) => {
          const nextId = event.target.value;
          setBusinessId(nextId);
          setSelectedRackId(inventory.racks.find((rack) => rack.businessId === nextId)?.id ?? "");
        }}>
          {inventory.businesses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>

        <nav className="page-nav" aria-label="Pages">
          <button
            className={activePage === "rack" ? "page-tab active" : "page-tab"}
            type="button"
            onClick={() => setActivePage("rack")}
          >
            <Layers3 size={16} />
            Racks
          </button>
          <button
            className={activePage === "reports" ? "page-tab active" : "page-tab"}
            type="button"
            onClick={() => setActivePage("reports")}
          >
            <Printer size={16} />
            Reports
          </button>
        </nav>

        <nav className="rack-list" aria-label="Racks">
          {visibleRacks.map((rack) => (
            <button
              className={rack.id === selectedRack?.id ? "rack-tab active" : "rack-tab"}
              key={rack.id}
              onClick={() => {
                setActivePage("rack");
                setSelectedRackId(rack.id);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const deviceId = event.dataTransfer.getData("text/plain");
                if (!deviceId) return;
                handleDeviceMoved(deviceId, rack.id, findOpenUnit(rack, inventory.devices));
              }}
            >
              <span>{rack.name}</span>
              <small>{rack.site}</small>
            </button>
          ))}
        </nav>

        <UniFiSyncPanel
          account={account}
          setAccount={setAccount}
          fileInputRef={fileInputRef}
          importNotice={importNotice}
          handleImport={handleImport}
          onInventorySynced={handleInventorySynced}
          onClearLocalData={handleClearLocalData}
        />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{business.name}</p>
            <h1>{activePage === "reports" ? "Reports" : "Network rack visualizer"}</h1>
          </div>
          <div className="toolbar" aria-label="Workspace tools">
            <button title="Filter view" aria-label="Filter view">
              <Filter size={18} />
            </button>
            <button title="Visualizer settings" aria-label="Visualizer settings">
              <Settings2 size={18} />
            </button>
            <button title="Save plan" aria-label="Save plan" onClick={() => void handleSavePlan()}>
              <Save size={18} />
            </button>
            <button title="Load saved plan" aria-label="Load saved plan" onClick={() => void handleOpenSavedPlans()}>
              <DatabaseZap size={18} />
            </button>
            <button title="Export plan JSON" aria-label="Export plan JSON" onClick={handleExportPlan}>
              <Download size={18} />
            </button>
            <button title="Restore plan JSON" aria-label="Restore plan JSON" onClick={() => fileInputRef.current?.click()}>
              <UploadCloud size={18} />
            </button>
          </div>
        </header>
        <p className="save-notice">{saveNotice}</p>

        {activePage === "reports" ? (
          <ReportsPage businessName={business.name} devices={inventory.devices} racks={visibleRacks} />
        ) : (
          <>
            <section className="metrics" aria-label="Network overview">
              <Metric icon={<Layers3 size={20} />} label="Racks" value={visibleRacks.length.toString()} />
              <Metric icon={<EthernetPort size={20} />} label="Mapped ports" value={String(rackDevices.reduce((sum, device) => sum + device.ports.length, 0))} />
              <Metric icon={<Cable size={20} />} label="Uplinks" value={String(activeConnections.length)} />
              <Metric icon={<Activity size={20} />} label="Devices" value={String(rackDevices.length)} />
            </section>

            <div className="main-grid">
              <section className="rack-area" aria-label="Rack elevation">
                <div className="section-title-row">
                  <div>
                    <p className="eyebrow">{selectedRack?.site ?? "No site"}</p>
                    <h2>{selectedRack?.name ?? "No rack selected"}</h2>
                  </div>
                  <button className="inline-action" onClick={handleAddRack}>
                    <Plus size={16} />
                    Add rack
                  </button>
                  <button className="inline-action" onClick={handleEditLabels}>
                    <Settings2 size={16} />
                    Edit labels
                  </button>
                  <button className="inline-action" onClick={handleAddDevice}>
                    <ServerCog size={16} />
                    Add item
                  </button>
                  <button
                    className={`inline-action ${showWireVisualizer ? "active" : ""}`}
                    onClick={() => setShowWireVisualizer((current) => !current)}
                  >
                    <Network size={16} />
                    Wires
                  </button>
                </div>
                <p className={`port-link-notice ${pendingPortLink ? "active" : ""}`}>{portLinkNotice}</p>
                {selectedRack ? (
                  <RackElevation
                    rack={selectedRack}
                    devices={rackDevices}
                    allDevices={inventory.devices}
                    showWires={showWireVisualizer}
                    onMoveDevice={handleDeviceMoved}
                    selectedDeviceId={selectedDeviceId ?? undefined}
                    onSelectDevice={setSelectedDeviceId}
                    pendingPortLink={pendingPortLink}
                    onPortClick={handleRackPortClicked}
                  />
                ) : null}
              </section>

              <section className="lower-panels">
                <ConnectionMap
                  rack={selectedRack}
                  connections={rackConnections}
                  collapsed={!showConnectionPanel}
                  onToggle={() => setShowConnectionPanel((current) => !current)}
                />
                <PortInspector
                  collapsed={!showPortPanel}
                  query={query}
                  rack={selectedRack}
                  rowCount={filteredPorts.length}
                  rows={filteredPorts}
                  setQuery={setQuery}
                  totalPorts={rackDevices.reduce((sum, device) => sum + device.ports.length, 0)}
                  onToggle={() => setShowPortPanel((current) => !current)}
                />
              </section>
            </div>
          </>
        )}
      </section>
      {selectedDevice ? (
        <DeviceModal onClose={() => setSelectedDeviceId(null)}>
          <DeviceEditor
            device={selectedDevice}
            racks={visibleRacks}
            devices={inventory.devices}
            onDeleteDevice={handleDeviceDeleted}
            onMoveDevice={handleDeviceMoved}
            onUpdateDevice={handleDeviceUpdated}
          />
        </DeviceModal>
      ) : null}
      {showPlanLibrary ? (
        <DeviceModal onClose={() => setShowPlanLibrary(false)}>
          <SavedPlansPanel
            isLoading={isLoadingPlans}
            plans={savedPlans}
            onLoad={(plan) => void handleLoadSavedPlan(plan)}
            onRefresh={() => void handleOpenSavedPlans()}
          />
        </DeviceModal>
      ) : null}
    </main>
  );
}

function loadInitialInventory(): InventoryState {
  const storedInventory = window.localStorage.getItem(INVENTORY_STORAGE_KEY);
  if (storedInventory) {
    try {
      return normalizeShelfPorts(applyLayoutOverrides(JSON.parse(storedInventory) as InventoryState));
    } catch {
      window.localStorage.removeItem(INVENTORY_STORAGE_KEY);
    }
  }

  return normalizeShelfPorts(applyLayoutOverrides({
    businesses: sampleBusinesses,
    racks: sampleRacks,
    devices: sampleDevices,
    connections: sampleConnections,
  }));
}

function normalizeShelfPorts(inventory: InventoryState): InventoryState {
  return {
    ...inventory,
    devices: inventory.devices.map((device) =>
      device.type === "shelf" && device.ports.length === 0
        ? { ...device, ports: createPorts(defaultPortCountForType("shelf"), "shelf") }
        : device,
    ),
  };
}

function mergeSyncedInventoryIntoCurrentPlan(
  currentInventory: InventoryState,
  syncedInventory: InventoryState,
  targetBusinessId: string,
  targetRackId?: string,
): InventoryState {
  const targetRack =
    currentInventory.racks.find((rack) => rack.id === targetRackId) ??
    currentInventory.racks.find((rack) => rack.businessId === targetBusinessId) ??
    currentInventory.racks[0];
  const nextDevices = [...currentInventory.devices];
  const updatedDeviceIndexes = new Set<number>();

  syncedInventory.devices.forEach((syncedDevice) => {
    const existingIndex = findMatchingSyncedDeviceIndex(nextDevices, syncedDevice, updatedDeviceIndexes);

    if (existingIndex >= 0) {
      nextDevices[existingIndex] = mergeSyncedDevice(nextDevices[existingIndex], syncedDevice);
      updatedDeviceIndexes.add(existingIndex);
      return;
    }

    if (!targetRack) return;
    nextDevices.push({
      ...syncedDevice,
      rackId: targetRack.id,
      uStart: findOpenUnit(targetRack, nextDevices),
    });
    updatedDeviceIndexes.add(nextDevices.length - 1);
  });

  return {
    ...currentInventory,
    devices: refreshPatchPortsFromLinkedTargets(nextDevices),
    connections: currentInventory.connections,
  };
}

function findMatchingSyncedDeviceIndex(
  devices: Device[],
  syncedDevice: Device,
  usedIndexes: Set<number>,
): number {
  const exactIdIndex = devices.findIndex((device, index) => !usedIndexes.has(index) && device.id === syncedDevice.id);
  if (exactIdIndex >= 0) return exactIdIndex;

  const syncedName = normalizeMatchText(syncedDevice.name);
  const syncedModel = normalizeMatchText(syncedDevice.model);
  const syncedIp = syncedDevice.ip?.trim();
  const nameAndModelIndex = devices.findIndex(
    (device, index) =>
      !usedIndexes.has(index) &&
      normalizeMatchText(device.name) === syncedName &&
      normalizeMatchText(device.model) === syncedModel,
  );
  if (nameAndModelIndex >= 0) return nameAndModelIndex;

  const nameIndex = devices.findIndex(
    (device, index) =>
      !usedIndexes.has(index) &&
      isRackNetworkDevice(device) &&
      normalizeMatchText(device.name) === syncedName,
  );
  if (nameIndex >= 0) return nameIndex;

  if (syncedIp) {
    return devices.findIndex(
      (device, index) => !usedIndexes.has(index) && isRackNetworkDevice(device) && device.ip === syncedIp,
    );
  }

  return -1;
}

function mergeSyncedDevice(existingDevice: Device, syncedDevice: Device): Device {
  return {
    ...existingDevice,
    name: syncedDevice.name || existingDevice.name,
    model: syncedDevice.model || existingDevice.model,
    type: syncedDevice.type || existingDevice.type,
    status: syncedDevice.status,
    ip: syncedDevice.ip || existingDevice.ip,
    ports: mergeSyncedPorts(existingDevice.ports, syncedDevice.ports),
  };
}

function mergeSyncedPorts(existingPorts: Device["ports"], syncedPorts: Device["ports"]): Device["ports"] {
  const existingByNumber = new Map(existingPorts.map((port) => [getPortSortNumber(port), port]));
  const syncedNumbers = new Set(syncedPorts.map((port) => getPortSortNumber(port)));
  const mergedPorts = syncedPorts.map((syncedPort) => {
    const existingPort = existingByNumber.get(getPortSortNumber(syncedPort));
    if (!existingPort) return syncedPort;
    const syncedPortIsOpen = isOpenSyncedPort(syncedPort);

    return {
      ...syncedPort,
      label: existingPort.label || syncedPort.label,
      connectedTo: getResolvedSyncedConnectedTo(existingPort, syncedPort),
      patchConnection: existingPort.patchConnection || syncedPort.patchConnection,
      wireUse: existingPort.wireUse ?? syncedPort.wireUse,
      wireColor: existingPort.wireColor ?? syncedPort.wireColor,
      endpointType: syncedPortIsOpen ? syncedPort.endpointType : existingPort.endpointType ?? syncedPort.endpointType,
      endpointLocation: syncedPortIsOpen ? syncedPort.endpointLocation : existingPort.endpointLocation ?? syncedPort.endpointLocation,
      endpointOwner: syncedPortIsOpen ? syncedPort.endpointOwner : existingPort.endpointOwner ?? syncedPort.endpointOwner,
      endpointNotes: syncedPortIsOpen ? syncedPort.endpointNotes : existingPort.endpointNotes ?? syncedPort.endpointNotes,
      importedEndpointName:
        getResolvedSyncedImportedEndpointName(existingPort, syncedPort),
    };
  });
  const existingOnlyPorts = existingPorts.filter((port) => !syncedNumbers.has(getPortSortNumber(port)));

  return [...mergedPorts, ...existingOnlyPorts];
}

function getUsefulSyncedEndpointName(port: Device["ports"][number]): string | undefined {
  const candidates = [port.importedEndpointName, port.connectedTo].filter(Boolean);
  return candidates.find((candidate) => !isGenericLinkEndpoint(candidate));
}

function getResolvedSyncedConnectedTo(
  existingPort: Device["ports"][number],
  syncedPort: Device["ports"][number],
): string | undefined {
  if (isOpenSyncedPort(syncedPort)) return syncedPort.connectedTo || "Open";
  return getUsefulSyncedEndpointName(syncedPort) ?? existingPort.connectedTo ?? syncedPort.connectedTo;
}

function getResolvedSyncedImportedEndpointName(
  existingPort: Device["ports"][number],
  syncedPort: Device["ports"][number],
): string | undefined {
  if (isOpenSyncedPort(syncedPort)) return syncedPort.importedEndpointName || syncedPort.connectedTo || "Open";
  return getUsefulSyncedEndpointName(syncedPort) ?? existingPort.importedEndpointName;
}

function isOpenSyncedPort(port: Device["ports"][number]): boolean {
  const value = `${port.connectedTo ?? ""} ${port.importedEndpointName ?? ""} ${port.speed ?? ""}`.toLowerCase();
  return value.includes("open") || value.includes("down") || value.includes("no client reported");
}

function isGenericLinkEndpoint(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return (
    normalized === "open" ||
    normalized === "unknown" ||
    normalized === "down" ||
    normalized.includes("no client reported") ||
    normalized === "link up"
  );
}

function isRackNetworkDevice(device: Device): boolean {
  return ["gateway", "switch", "server", "nvr"].includes(device.type);
}

function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function refreshPatchPortsFromLinkedTargets(devices: Device[]): Device[] {
  return devices.map((device) => {
    if (device.type !== "patch") return device;

    let changed = false;
    const ports = device.ports.map((port) => {
      const patchLink = getPortPatchLink(port);
      if (!patchLink) return port;

      const target = findPortTarget(patchLink, devices, device.id);
      if (!target?.port) return port;

      const refreshedPort = enrichPatchPortFromTarget(port, target.port, target.device);
      if (patchPortEndpointChanged(port, refreshedPort)) changed = true;
      return refreshedPort;
    });

    return changed ? { ...device, ports } : device;
  });
}

function patchPortEndpointChanged(
  previousPort: Device["ports"][number],
  nextPort: Device["ports"][number],
): boolean {
  return (
    previousPort.connectedTo !== nextPort.connectedTo ||
    previousPort.importedEndpointName !== nextPort.importedEndpointName ||
    previousPort.connectedMac !== nextPort.connectedMac ||
    previousPort.connectedIp !== nextPort.connectedIp ||
    previousPort.endpointType !== nextPort.endpointType ||
    previousPort.endpointLocation !== nextPort.endpointLocation ||
    previousPort.endpointOwner !== nextPort.endpointOwner ||
    previousPort.endpointVendor !== nextPort.endpointVendor ||
    previousPort.endpointNotes !== nextPort.endpointNotes ||
    previousPort.speed !== nextPort.speed ||
    previousPort.vlan !== nextPort.vlan
  );
}

function persistInventory(inventory: InventoryState): void {
  window.localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
}

function findOpenUnit(rack: RackType, devices: Device[]): number {
  const occupiedUnits = new Set(
    devices
      .filter((device) => device.rackId === rack.id)
      .flatMap((device) =>
        Array.from({ length: device.heightU }, (_, index) => device.uStart - index),
      ),
  );

  for (let unit = rack.sizeU; unit >= 1; unit -= 1) {
    if (!occupiedUnits.has(unit)) return unit;
  }

  return 1;
}

function canMoveDeviceToUnit(devices: Device[], deviceId: string, rackId: string, uStart: number): boolean {
  const movingDevice = devices.find((device) => device.id === deviceId);
  if (!movingDevice || movingDevice.locked) return false;

  const movingRange = getDeviceUnitRange({ uStart, heightU: movingDevice.heightU });
  return !devices.some((device) => {
    if (device.id === deviceId || device.rackId !== rackId || !device.locked) return false;
    return rangesOverlap(movingRange, getDeviceUnitRange(device));
  });
}

function getDeviceUnitRange(device: Pick<Device, "uStart" | "heightU">): { high: number; low: number } {
  return {
    high: device.uStart,
    low: device.uStart - device.heightU + 1,
  };
}

function rangesOverlap(
  left: { high: number; low: number },
  right: { high: number; low: number },
): boolean {
  return left.low <= right.high && right.low <= left.high;
}

function isCustomDevice(device: Device): boolean {
  return device.id.startsWith("custom-device-");
}

function normalizeDeviceType(value: string | null): DeviceType {
  const normalized = value?.toLowerCase().trim() ?? "";
  if (normalized.includes("blank") || normalized.includes("plate") || normalized.includes("panel")) {
    return normalized.includes("patch") ? "patch" : "blank";
  }
  if (normalized.includes("fan") || normalized.includes("cool")) return "fan";
  if (normalized.includes("switch")) return "switch";
  if (normalized.includes("gateway") || normalized.includes("router")) return "gateway";
  if (normalized.includes("power") || normalized.includes("pdu") || normalized.includes("ups")) return "power";
  if (normalized.includes("raspberry") || normalized.includes("rpi") || normalized === "pi") return "raspberry-pi";
  if (normalized.includes("nvr") || normalized.includes("recorder") || normalized.includes("protect")) return "nvr";
  if (normalized.includes("modem") || normalized.includes("inseego") || normalized.includes("cellular")) return "modem";
  if (normalized.includes("shelf") || normalized.includes("tray")) return "shelf";
  if (normalized.includes("server") || normalized.includes("nas")) return "server";
  return "patch";
}

function defaultModelForType(type: DeviceType): string {
  const defaults: Record<DeviceType, string> = {
    gateway: "Router / gateway",
    switch: "Network switch",
    patch: "Patch panel",
    server: "Server",
    power: "Power / UPS",
    fan: "Rack fan panel",
    blank: "Blank panel",
    "raspberry-pi": "Raspberry Pi tray",
    nvr: "UniFi NVR",
    modem: "Inseego Wavemaker FX4100",
    shelf: "Rack shelf",
  };

  return defaults[type];
}

function defaultPortCountForType(type: DeviceType): number {
  const defaults: Record<DeviceType, number> = {
    gateway: 4,
    switch: 24,
    patch: 24,
    server: 2,
    power: 1,
    fan: 0,
    blank: 0,
    "raspberry-pi": 2,
    nvr: 2,
    modem: 2,
    shelf: 2,
  };

  return defaults[type];
}

function defaultHeightForType(type: DeviceType): number {
  if (type === "server") return 2;
  if (type === "fan") return 3;
  if (type === "shelf") return 2;
  return 1;
}

function parsePositiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createPorts(count: number, type: DeviceType): Device["ports"] {
  if (isPortlessDeviceType(type)) return [];

  return Array.from({ length: count }, (_, index) => ({
    id: `custom-port-${Date.now()}-${index + 1}`,
    label: getDefaultPortLabel(type, index + 1),
    speed: type === "patch" ? "Passive" : "Auto",
    connectedTo: "",
    patchConnection: "",
    endpointType: "",
    endpointLocation: "",
    endpointOwner: "",
    endpointVendor: "",
    endpointNotes: "",
    wireUse: "data",
    wireColor: wireUseOptions[0].color,
  }));
}

function getRenderableCustomPorts(device: Device, count: number): Device["ports"] {
  const portsByIndex = new Map(
    device.ports.map((port, index) => {
      const number = getPortSortNumber(port);
      return [number === Number.MAX_SAFE_INTEGER ? index + 1 : number, port];
    }),
  );

  return Array.from({ length: count }, (_, index) => {
    const portNumber = index + 1;
    return (
      portsByIndex.get(portNumber) ?? {
        id: `placeholder-${device.id}-${portNumber}`,
        label: getDefaultPortLabel(device.type, portNumber),
        speed: "Auto",
        connectedTo: "Open",
        patchConnection: "",
        wireUse: "data",
        wireColor: wireUseOptions[0].color,
      }
    );
  });
}

function getDefaultPortLabel(type: DeviceType, index: number): string {
  if (type === "server") return `NIC ${index}`;
  if (type === "raspberry-pi") return `Pi ${index}`;
  if (type === "nvr") return index === 1 ? "RJ45" : "SFP";
  if (type === "modem") return index === 1 ? "LAN" : "WAN";
  if (type === "shelf") return index === 1 ? "Modem" : "Light controller";
  return String(index);
}

function isPortlessDeviceType(type: DeviceType): boolean {
  return type === "fan" || type === "blank";
}

function shouldResetPortsForTypeChange(previousType: DeviceType, nextType: DeviceType): boolean {
  if (previousType === nextType) return false;
  return (
    nextType === "nvr" ||
    nextType === "raspberry-pi" ||
    nextType === "power" ||
    nextType === "modem" ||
    nextType === "shelf" ||
    isPortlessDeviceType(nextType)
  );
}

function canPatchPanelLinkToDevice(device: Device): boolean {
  return (
    device.type === "switch" ||
    device.type === "gateway" ||
    device.type === "server" ||
    device.type === "raspberry-pi" ||
    device.type === "nvr" ||
    device.type === "modem" ||
    device.type === "shelf"
  );
}

function canStartPortLinkFromDevice(device: Device): boolean {
  return device.type === "patch" || canPatchPanelLinkToDevice(device);
}

function canRackPortsLink(sourceDevice: Device, targetDevice: Device): boolean {
  if (sourceDevice.id === targetDevice.id) return false;
  if (!canStartPortLinkFromDevice(sourceDevice) || !canStartPortLinkFromDevice(targetDevice)) return false;
  if (sourceDevice.type === "patch" && targetDevice.type === "patch") return false;
  return true;
}

function buildPortConnections(devices: Device[]): InventoryState["connections"] {
  return devices.flatMap((device) =>
    device.ports
      .filter((port) => getPortPatchLink(port).trim())
      .map((port) => {
        const patchLink = getPortPatchLink(port);
        const target = findPortTarget(patchLink, devices, device.id);

        return {
          id: `port-link-${device.id}-${port.id}`,
          fromRackId: device.rackId,
          toRackId: target?.device.rackId ?? device.rackId,
          fromDevice: device.name,
          toDevice: target
            ? `${target.device.name} ${target.port?.label ?? ""}`.trim()
            : patchLink || "Connected endpoint",
          medium: target ? `${port.label} patch link` : port.label,
          status: "planned" as const,
        };
      }),
  );
}

function enrichPatchPortFromTarget(
  patchPort: Device["ports"][number],
  targetPort: Device["ports"][number],
  targetDevice: Device,
): Device["ports"][number] {
  const endpointName = getPortEndpointDisplay(targetPort);
  const connectedTo = endpointName && endpointName !== "Open" ? endpointName : targetPort.connectedTo || targetDevice.name;

  return {
    ...patchPort,
    connectedTo,
    importedEndpointName: connectedTo || targetPort.importedEndpointName || targetPort.connectedTo || patchPort.importedEndpointName,
    connectedMac: targetPort.connectedMac ?? patchPort.connectedMac,
    connectedIp: targetPort.connectedIp ?? patchPort.connectedIp,
    endpointType: targetPort.endpointType ?? patchPort.endpointType,
    endpointLocation: targetPort.endpointLocation ?? patchPort.endpointLocation,
    endpointOwner: targetPort.endpointOwner ?? patchPort.endpointOwner,
    endpointVendor: targetPort.endpointVendor ?? patchPort.endpointVendor,
    endpointNotes: targetPort.endpointNotes ?? patchPort.endpointNotes,
    poeMode: targetPort.poeMode ?? patchPort.poeMode,
    stp: targetPort.stp ?? patchPort.stp,
    speed: targetPort.speed || patchPort.speed,
    vlan: targetPort.vlan ?? patchPort.vlan,
    wireUse: targetPort.wireUse || patchPort.wireUse,
    wireColor: targetPort.wireColor || patchPort.wireColor,
  };
}

function findPortTarget(
  connectedTo: string,
  devices: Device[],
  sourceDeviceId: string,
): { device: Device; port?: Device["ports"][number] } | undefined {
  const normalized = normalizeLinkText(connectedTo);
  const candidates = devices
    .filter((device) => device.id !== sourceDeviceId)
    .sort((left, right) => right.name.length - left.name.length);

  for (const device of candidates) {
    if (!normalized.includes(normalizeLinkText(device.name))) continue;
    const displayPorts = getDisplayPortsForLinks(device);
    const requestedPort = getRequestedPortLabel(connectedTo, device.name);
    const port = requestedPort
      ? displayPorts.find((item) => portLabelsMatch(item.label, requestedPort))
      : displayPorts
          .slice()
          .sort((left, right) => normalizeLinkText(right.label).length - normalizeLinkText(left.label).length)
          .find((item) => normalized.includes(normalizeLinkText(item.label)));
    return { device, port };
  }

  return undefined;
}

function getDisplayPortsForLinks(device: Device): Device["ports"] {
  if (device.type === "server") return getRenderableCustomPorts(device, Math.max(device.ports.length, 2));
  if (device.type === "raspberry-pi") return device.ports;
  if (device.type === "nvr") return getRenderableCustomPorts(device, Math.max(device.ports.length, 2));
  if (device.type === "modem") return getRenderableCustomPorts(device, Math.max(device.ports.length, 2));
  if (device.type === "shelf") return device.ports;
  if (!isFaceplateDevice(device)) return device.ports;
  const { topPorts, bottomPorts } = buildFaceplateRows(device);
  return [...topPorts, ...bottomPorts];
}

function getRequestedPortLabel(connectedTo: string, deviceName: string): string {
  const deviceIndex = connectedTo.toLowerCase().indexOf(deviceName.toLowerCase());
  const afterDevice = deviceIndex >= 0 ? connectedTo.slice(deviceIndex + deviceName.length) : connectedTo;
  const portMatch =
    afterDevice.match(/(?:port|\/)\s*(sfp\s*)?(\d+)/i) ||
    afterDevice.match(/-\s*(sfp\s*)?(\d+)$/i);

  if (!portMatch) return "";

  return portMatch[2];
}

function portLabelsMatch(displayLabel: string, requestedLabel: string): boolean {
  const displayNumber = getPortSortNumber({ id: "display", label: displayLabel, speed: "" });
  const requestedNumber = getPortSortNumber({ id: "requested", label: requestedLabel, speed: "" });

  return displayNumber === requestedNumber;
}

function normalizeLinkText(value: string): string {
  return value.toLowerCase().replace(/\bsfp\s*(\d+)/g, "$1").replace(/[^a-z0-9]+/g, " ").trim();
}

function formatConnectionLabel(value: string | undefined): string {
  return value?.replace(/\bSFP\s*(\d+)\b/gi, "$1") || "Open";
}

function getPortEndpointDisplay(port: Device["ports"][number]): string {
  const connectedTo = getConnectedEndpointDisplay(port);
  const endpoint =
    connectedTo
      ? connectedTo
      : port.endpointOwner || port.endpointLocation || port.connectedIp || port.connectedMac || "";

  return compactEndpointLabel(endpoint);
}

function getPortTooltip(port: Device["ports"][number]): string {
  const endpoint = getConnectedEndpointDisplay(port);
  const patchLink = formatConnectionLabel(port.patchConnection);
  const connection =
    endpoint ||
    (patchLink !== "Open" ? patchLink : "") ||
    formatConnectionLabel(port.connectedTo);

  return `${port.label}: ${connection || "Open"} (${port.speed})`;
}

function getConnectedEndpointDisplay(port: Device["ports"][number]): string {
  const connectedTo = formatConnectionLabel(port.connectedTo);
  const importedEndpoint = formatConnectionLabel(port.importedEndpointName);
  if (!isUsableEndpointLabel(connectedTo)) return "";
  if (isGenericAccessEndpointName(connectedTo) && isUsableEndpointLabel(importedEndpoint) && !isGenericAccessEndpointName(importedEndpoint)) {
    return importedEndpoint;
  }
  return connectedTo;
}

function isUsableEndpointLabel(value: string): boolean {
  const normalized = value.toLowerCase();
  return Boolean(value) && !["open", "down", "unknown", "-"].includes(normalized) && !normalized.includes("no client reported");
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

function compactEndpointLabel(value: string): string {
  return value
    .replace(/\bport\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
}

function UniFiSyncPanel({
  account,
  setAccount,
  fileInputRef,
  importNotice,
  handleImport,
  onInventorySynced,
  onClearLocalData,
}: {
  account: UniFiAccountProfile | null;
  setAccount: (account: UniFiAccountProfile | null) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  importNotice: string;
  handleImport: (file: File | undefined) => Promise<void>;
  onInventorySynced: (inventory: InventoryState, message: string) => void;
  onClearLocalData: () => void;
}) {
  const [label, setLabel] = useState(account?.label ?? "Primary UniFi account");
  const [mode, setMode] = useState<UniFiAccountProfile["mode"]>(account?.mode ?? "cloud");
  const [controllerUrl, setControllerUrl] = useState(
    account?.controllerUrl ?? "https://api.ui.com",
  );
  const [siteId, setSiteId] = useState(account?.siteId ?? "default");
  const [apiToken, setApiToken] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  function buildAccountProfile() {
    return saveUniFiAccount({
      label,
      mode,
      controllerUrl,
      siteId,
      apiToken: apiToken || account?.apiToken || "",
    });
  }

  function handleSaveAccount() {
    const saved = buildAccountProfile();
    setAccount(saved);
    setApiToken("");
  }

  async function handleTestAccount() {
    if (!canSave) return;
    setIsTesting(true);
    const accountToTest = buildAccountProfile();
    setAccount(accountToTest);
    setApiToken("");
    const testedAccount = await testUniFiConnection(accountToTest);
    setAccount(testedAccount);
    setIsTesting(false);
  }

  function handleDisconnect() {
    clearUniFiAccount();
    setAccount(null);
    setApiToken("");
  }

  async function handleSyncInventory() {
    if (!account || account.status !== "connected") return;
    setIsSyncing(true);

    try {
      const result = await syncUniFiInventory(account);
      setSyncNotice(result.message);
      onInventorySynced(result.inventory, result.message);
    } catch (error) {
      setSyncNotice(error instanceof Error ? error.message : "Could not sync UniFi inventory");
    } finally {
      setIsSyncing(false);
    }
  }

  const canSave = controllerUrl.trim().length > 0 && siteId.trim().length > 0 && Boolean(apiToken || account?.apiToken);

  return (
    <section className="sync-panel">
      <div className="section-heading">
        <DatabaseZap size={18} />
        <h2>Ubiquiti Sync</h2>
      </div>
      <p>
        Add a UniFi API token or controller connection profile. Password sign-in is intentionally
        avoided here; a backend OAuth/proxy layer can be added next.
      </p>

      <div className="auth-status">
        <span className={`status-dot status-${account?.status ?? "not-tested"}`} />
        <span>
          {account
            ? `${account.label} - ${account.statusMessage ?? maskToken(account.apiToken)}`
            : "No UniFi account connected"}
        </span>
      </div>

      <div className="auth-form">
        <label>
          <span>Profile name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>

        <label>
          <span>Connection mode</span>
          <select
            value={mode}
            onChange={(event) => {
              const nextMode = event.target.value as UniFiAccountProfile["mode"];
              setMode(nextMode);
              setControllerUrl(nextMode === "cloud" ? "https://api.ui.com" : "https://192.168.1.1");
            }}
          >
            <option value="cloud">UniFi Site Manager cloud</option>
            <option value="local">Local UniFi OS console</option>
          </select>
        </label>

        <label>
          <span>Controller URL</span>
          <input
            value={controllerUrl}
            onChange={(event) => setControllerUrl(event.target.value)}
            placeholder={mode === "cloud" ? "https://api.ui.com" : "https://192.168.1.1"}
          />
        </label>

        <label>
          <span>Site ID</span>
          <input value={siteId} onChange={(event) => setSiteId(event.target.value)} />
        </label>

        <label>
          <span>API token</span>
          <input
            type="password"
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder={account ? maskToken(account.apiToken) : "Paste token"}
          />
        </label>
      </div>

      <button className="primary-action" disabled={!canSave} onClick={handleSaveAccount}>
        <KeyRound size={17} />
        Save account
      </button>

      <div className="button-grid">
        <button className="secondary-action" disabled={!canSave || isTesting} onClick={() => void handleTestAccount()}>
          <ShieldCheck size={17} />
          {isTesting ? "Testing" : "Save & test"}
        </button>
        <button className="secondary-action" disabled={!account} onClick={handleDisconnect}>
          <Power size={17} />
          Disconnect
        </button>
      </div>

      <button
        className="secondary-action"
        disabled={!account || account.status !== "connected" || isSyncing}
        onClick={() => void handleSyncInventory()}
      >
        <RefreshCw size={17} />
        {isSyncing ? "Syncing" : "Sync inventory"}
      </button>
      <button className="secondary-action" onClick={onClearLocalData}>
        <CircleAlert size={17} />
        Clear local data
      </button>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        onChange={(event) => void handleImport(event.target.files?.[0])}
      />
      <button className="secondary-action" onClick={() => fileInputRef.current?.click()}>
        <UploadCloud size={17} />
        Restore plan JSON
      </button>
      <span className="import-notice">{syncNotice ?? importNotice}</span>
      <button className="secondary-action">
        <FileJson size={17} />
        Review schema
      </button>
    </section>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <article className="metric">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SavedPlansPanel({
  isLoading,
  plans,
  onLoad,
  onRefresh,
}: {
  isLoading: boolean;
  plans: SavedPlanSummary[];
  onLoad: (plan: SavedPlanSummary) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="saved-plans-panel">
      <div className="modal-heading-row">
        <div>
          <p className="eyebrow">Server library</p>
          <h2>Saved plans on this Pi</h2>
        </div>
        <button className="inline-action" disabled={isLoading} onClick={onRefresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {isLoading ? <p className="empty-state">Loading saved plans...</p> : null}
      {!isLoading && plans.length === 0 ? (
        <p className="empty-state">No saved plans yet. Click Save plan first, then refresh this list.</p>
      ) : null}

      <div className="saved-plan-list">
        {plans.map((plan) => (
          <article className="saved-plan-card" key={plan.relativePath}>
            <div>
              <strong>{plan.businessName}</strong>
              <span>{plan.siteName}</span>
              <small>{formatSavedAt(plan.savedAt)}</small>
            </div>
            <div className="saved-plan-meta">
              <span>{plan.rackCount} racks</span>
              <span>{plan.deviceCount} devices</span>
            </div>
            <button className="primary-action" disabled={isLoading} onClick={() => onLoad(plan)}>
              <DatabaseZap size={16} />
              Load
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeviceModal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Device details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" title="Close" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}

function RackElevation({
  rack,
  devices: rackDevices,
  allDevices,
  showWires,
  onMoveDevice,
  selectedDeviceId,
  onSelectDevice,
  pendingPortLink,
  onPortClick,
}: {
  rack: RackType;
  devices: Device[];
  allDevices: Device[];
  showWires: boolean;
  onMoveDevice: (deviceId: string, rackId: string, uStart: number) => void;
  selectedDeviceId?: string;
  onSelectDevice: (deviceId: string) => void;
  pendingPortLink: PendingPortLink | null;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
}) {
  const units = Array.from({ length: rack.sizeU }, (_, index) => rack.sizeU - index);
  const rackStyle = { "--rack-units": rack.sizeU } as CSSProperties;
  const wireLinks = showWires ? buildRackWireLinks(rackDevices, allDevices) : [];

  return (
    <div className="rack-frame">
      <div className="rack-rail" aria-hidden="true" style={rackStyle}>
        {units.map((unit) => (
          <span key={unit}>{unit}</span>
        ))}
      </div>
      <div className="rack-slots" style={rackStyle}>
        {showWires ? <WireOverlay links={wireLinks} rackSizeU={rack.sizeU} /> : null}
        {units.map((unit) => {
          const device = rackDevices.find((item) => item.uStart === unit);
          const occupied = rackDevices.some(
            (item) => unit <= item.uStart && unit > item.uStart - item.heightU,
          );

          if (device) {
            return (
              <article
                key={unit}
                className={`device device-${device.type} status-${device.status} ${
                  device.id === selectedDeviceId ? "selected" : ""
                } ${device.locked ? "locked" : ""}`}
                style={{ gridRow: `span ${device.heightU}` }}
                draggable={!device.locked}
                onDragStart={(event) => {
                  if (device.locked) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.setData("text/plain", device.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
              >
                {device.locked ? (
                  <span className="device-lock-badge" title="Locked in rack">
                    <LockKeyhole size={14} />
                  </span>
                ) : null}
                <DeviceRackFace
                  device={device}
                  onOpenSettings={() => onSelectDevice(device.id)}
                  onPortClick={onPortClick}
                  pendingPortLink={pendingPortLink}
                />
              </article>
            );
          }

          if (occupied) return null;

          return (
            <div
              className="empty-u"
              key={unit}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const deviceId = event.dataTransfer.getData("text/plain");
                if (!deviceId) return;
                if (!canMoveDeviceToUnit(allDevices, deviceId, rack.id, unit)) return;
                onMoveDevice(deviceId, rack.id, unit);
              }}
            >
              Open
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeviceRackFace({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  if (isFaceplateDevice(device)) {
    return (
      <NetworkFaceplate
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  if (device.type === "fan") {
    return <RackFanPanel device={device} onOpenSettings={onOpenSettings} />;
  }

  if (device.type === "blank") {
    return <BlankRackPanel device={device} onOpenSettings={onOpenSettings} />;
  }

  if (device.type === "shelf") {
    return (
      <RackShelfPanel
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  if (device.type === "server") {
    return (
      <ServerRackPanel
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  if (device.type === "power") {
    return <UpsRackPanel device={device} onOpenSettings={onOpenSettings} />;
  }

  if (device.type === "raspberry-pi") {
    return (
      <RaspberryPiRackPanel
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  if (device.type === "nvr") {
    return (
      <NvrRackPanel
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  if (device.type === "modem") {
    return (
      <ModemRackPanel
        device={device}
        onOpenSettings={onOpenSettings}
        onPortClick={onPortClick}
        pendingPortLink={pendingPortLink}
      />
    );
  }

  return (
    <>
      <div className="device-summary">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model}</span>
      </div>
      <DeviceStatusPill status={device.status} />
    </>
  );
}

function NvrRackPanel({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const ports = getRenderableCustomPorts(device, 2);

  return (
    <div className="visual-panel nvr-panel">
      <div className="nvr-ear nvr-ear-left" aria-hidden="true" />
      <div className="nvr-control">
        <span className="nvr-blue-screen" />
        <strong>NVR</strong>
      </div>
      <div className="nvr-drive-grid" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <div className="nvr-network">
        {ports.map((port, index) => {
          const tooltip = getPortTooltip(port);

          return (
            <button
              aria-label={`${device.name} ${tooltip}`}
              className={`nvr-port ${index === 0 ? "nvr-rj45" : "nvr-sfp"} ${getFaceplatePortClass(port, device)} ${
                port.patchConnection ? "has-patch-link" : ""
              } ${pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id ? "pending-link" : ""}`}
              data-tooltip={tooltip}
              data-wire-anchor={getWireAnchorKey(device, port)}
              key={port.id}
              style={{ "--wire-color": getWireColor(port) } as CSSProperties}
              title={tooltip}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPortClick(device, port);
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {port.label}
            </button>
          );
        })}
      </div>
      <div className="nvr-ear nvr-ear-right" aria-hidden="true" />
      <div className="nvr-label">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model}</span>
      </div>
    </div>
  );
}

function RaspberryPiRackPanel({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const slots = Array.from({ length: 4 }, (_, index) => device.ports[index]);

  return (
    <div className="visual-panel pi-panel">
      <div className="pi-ear pi-ear-left" aria-hidden="true" />
      <div className="pi-control-plate" aria-hidden="true" />
      {slots.map((port, index) => (
        <div className={`pi-slot ${port ? "loaded" : "empty"}`} key={port?.id ?? `empty-pi-${index}`}>
          <div className="pi-board">
            <span className="pi-card-slot" aria-hidden="true" />
            {port ? (
              (() => {
                const tooltip = getPortTooltip(port);

                return (
                  <button
                    aria-label={`${device.name} ${tooltip}`}
                    className={`pi-ethernet ${getFaceplatePortClass(port, device)} ${
                      port.patchConnection ? "has-patch-link" : ""
                    } ${pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id ? "pending-link" : ""}`}
                    data-tooltip={tooltip}
                    data-wire-anchor={getWireAnchorKey(device, port)}
                    style={{ "--wire-color": getWireColor(port) } as CSSProperties}
                    title={tooltip}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPortClick(device, port);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <span />
                  </button>
                );
              })()
            ) : (
              <span className="pi-ethernet empty-jack" aria-hidden="true" />
            )}
            <span className="pi-usb pi-usb-blue" aria-hidden="true" />
            <span className="pi-usb" aria-hidden="true" />
            <span className="pi-hdmi" aria-hidden="true" />
            <span className="pi-power-light" aria-hidden="true" />
            <span className="pi-usbc" aria-hidden="true" />
          </div>
        </div>
      ))}
      <div className="pi-ear pi-ear-right" aria-hidden="true" />
      <div className="pi-label">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model}</span>
      </div>
    </div>
  );
}

function UpsRackPanel({
  device,
  onOpenSettings,
}: {
  device: Device;
  onOpenSettings: () => void;
}) {
  return (
    <div className="visual-panel ups-panel">
      <div className="ups-ear ups-ear-left" aria-hidden="true">
        <span />
      </div>
      <div className="ups-grille" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="ups-badge">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model}</span>
      </div>
      <div className="ups-display" aria-label={`${device.name} UPS display`}>
        <span className="ups-display-label">INPUT</span>
        <strong>119</strong>
        <span className="ups-display-unit">V</span>
        <span className="ups-battery">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="ups-ear ups-ear-right" aria-hidden="true">
        <span />
      </div>
      <DeviceStatusPill status={device.status} />
    </div>
  );
}

function ModemRackPanel({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const ports = getRenderableCustomPorts(device, 2);

  return (
    <div className="visual-panel modem-panel">
      <div className="modem-body">
        <div className="modem-top" aria-hidden="true" />
        <div className="modem-front">
          <span className="modem-light blue" />
          <span className="modem-light blue" />
          <span className="modem-light green" />
          <div className="modem-brand">
            <div className="device-name-row">
              <strong>{device.name}</strong>
              <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
            </div>
            <span>{device.model}</span>
          </div>
          <div className="modem-ports" aria-label={`${device.name} ports`}>
            {ports.map((port) => (
              <CustomVisualPort
                className="modem-port"
                device={device}
                isPending={pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id}
                key={port.id}
                port={port}
                onPortClick={onPortClick}
              />
            ))}
          </div>
        </div>
      </div>
      <DeviceStatusPill status={device.status} />
    </div>
  );
}

function RackShelfPanel({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const shelfItems = getShelfItems(device);

  return (
    <div className="visual-panel shelf-panel">
      <div className="shelf-lip" aria-hidden="true" />
      <div className="shelf-surface">
        <div className="shelf-label">
          <div className="device-name-row">
            <strong>{device.name}</strong>
            <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
          </div>
          <span>{device.model}</span>
        </div>
        <div className="shelf-items" aria-label={`${device.name} shelf items`}>
          {shelfItems.map((item) => (
            <div className={`shelf-item shelf-item-${item.kind}`} key={item.port.id}>
              <span className="shelf-item-name">{item.label}</span>
              <CustomVisualPort
                className="shelf-item-port"
                device={device}
                isPending={pendingPortLink?.deviceId === device.id && pendingPortLink.portId === item.port.id}
                port={item.port}
                onPortClick={onPortClick}
              />
            </div>
          ))}
        </div>
      </div>
      <DeviceStatusPill status={device.status} />
    </div>
  );
}

function getShelfItems(device: Device): Array<{ label: string; kind: string; port: Device["ports"][number] }> {
  const labels =
    device.model && device.model !== defaultModelForType("shelf")
      ? device.model
    .split(/[,/]+/)
    .map((item) => item.trim())
    .filter(Boolean)
          .slice(0, 4)
      : ["Modem", "Light controller"];
  const fallbackPorts: Device["ports"] = labels.map((label, index) => ({
    id: `placeholder-${device.id}-shelf-${index + 1}`,
    label,
    speed: "Auto",
    connectedTo: "Open",
    patchConnection: "",
    wireUse: "data",
    wireColor: wireUseOptions[0].color,
  }));
  const ports: Device["ports"] =
    device.ports.length > 0
      ? device.ports
      : fallbackPorts;

  return ports.slice(0, 4).map((port, index) => {
      const label = port.label || labels[index] || `Shelf item ${index + 1}`;
      const value = `${label} ${port.connectedTo ?? ""} ${port.endpointType ?? ""}`.toLowerCase();
      const kind = value.includes("modem") || value.includes("cell") ? "modem" : value.includes("light") ? "light" : "generic";
      return {
        label,
        kind,
        port: {
          ...port,
          label,
        },
      };
    });
}

function ServerRackPanel({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const ports = getRenderableCustomPorts(device, 2);

  return (
    <div className="visual-panel server-panel">
      <div className="server-status-rail" aria-hidden="true">
        <span />
      </div>
      <div className="server-face">
        <div className="server-bay server-bay-left" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="server-grille" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="server-brand">
          <div className="device-name-row">
            <strong>{device.name}</strong>
            <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
          </div>
          <span>{device.model}</span>
        </div>
        <div className="server-network" aria-label={`${device.name} network ports`}>
          {ports.map((port) => (
            <CustomVisualPort
              className="server-nic"
              device={device}
              isPending={pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id}
              key={port.id}
              port={port}
              onPortClick={onPortClick}
            />
          ))}
        </div>
        <div className="server-drive-strip" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="server-bay server-bay-right" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
      <div className="server-handle" aria-hidden="true">
        <span />
      </div>
      <DeviceStatusPill status={device.status} />
    </div>
  );
}

function CustomVisualPort({
  className,
  device,
  port,
  isPending,
  onPortClick,
  children,
}: {
  className: string;
  device: Device;
  port: Device["ports"][number];
  isPending: boolean;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  children?: ReactNode;
}) {
  const patchLink = getPortPatchLink(port);
  const tooltip = getPortTooltip(port);

  return (
    <button
      aria-label={tooltip}
      className={`${className} ${getFaceplatePortClass(port, device)} ${patchLink ? "has-patch-link" : ""} ${
        isPending ? "pending-link" : ""
      }`}
      data-tooltip={tooltip}
      data-wire-anchor={getWireAnchorKey(device, port)}
      style={{ "--wire-color": getWireColor(port) } as CSSProperties}
      title={tooltip}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onPortClick(device, port);
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children ?? compactPortLabel(port.label)}
    </button>
  );
}

function RackFanPanel({
  device,
  onOpenSettings,
}: {
  device: Device;
  onOpenSettings: () => void;
}) {
  return (
    <div className="visual-panel fan-panel">
      <div className="fan-ear fan-ear-left" aria-hidden="true" />
      <div className="fan-module">
        <FanGuard />
      </div>
      <div className="fan-center-vent" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="fan-module">
        <FanGuard />
      </div>
      <div className="fan-center-vent" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="fan-module">
        <FanGuard />
      </div>
      <div className="fan-ear fan-ear-right" aria-hidden="true" />
      <div className="fan-label">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model}</span>
      </div>
    </div>
  );
}

function FanGuard() {
  return (
    <div className="fan-guard" aria-hidden="true">
      <span className="fan-blades" />
      <span className="fan-honeycomb" />
      <span className="fan-hub" />
    </div>
  );
}

function BlankRackPanel({
  device,
  onOpenSettings,
}: {
  device: Device;
  onOpenSettings: () => void;
}) {
  return (
    <div className="visual-panel blank-panel">
      <div className="device-name-row">
        <strong>{device.name}</strong>
        <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
      </div>
      <div className="blank-panel-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span>{device.model}</span>
    </div>
  );
}

type WireLink = {
  id: string;
  fromDevice: Device;
  fromPort: Device["ports"][number];
  toDevice: Device;
  toPort?: Device["ports"][number];
};

type MeasuredWire = {
  id: string;
  color: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
};

function WireOverlay({ links }: { links: WireLink[]; rackSizeU: number }) {
  const overlayRef = useRef<SVGSVGElement>(null);
  const [measuredWires, setMeasuredWires] = useState<MeasuredWire[]>([]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const overlayBounds = overlay.getBoundingClientRect();
    const nextWires = links.flatMap((link) => {
      const from = document.querySelector<HTMLElement>(getWireAnchorSelector(link.fromDevice, link.fromPort));
      const to = link.toPort
        ? document.querySelector<HTMLElement>(getWireAnchorSelector(link.toDevice, link.toPort))
        : null;
      if (!from || !to) return [];

      const fromBounds = from.getBoundingClientRect();
      const toBounds = to.getBoundingClientRect();

      return [
        {
          id: link.id,
          color: getWireColor(link.fromPort),
          start: {
            x: fromBounds.left + fromBounds.width / 2 - overlayBounds.left,
            y: fromBounds.top + fromBounds.height / 2 - overlayBounds.top,
          },
          end: {
            x: toBounds.left + toBounds.width / 2 - overlayBounds.left,
            y: toBounds.top + toBounds.height / 2 - overlayBounds.top,
          },
        },
      ];
    });

    setMeasuredWires(nextWires);
  }, [links]);

  return (
    <svg ref={overlayRef} className="wire-overlay" aria-hidden="true">
      {measuredWires.map((wire, index) => {
        const rowOffset = 12 + (index % 5) * 5;
        const routeY =
          wire.start.y < wire.end.y
            ? Math.min(wire.end.y - 8, wire.start.y + rowOffset)
            : Math.max(wire.end.y + 8, wire.start.y - rowOffset);

        return (
          <path
            className="wire-path"
            d={`M ${wire.start.x} ${wire.start.y} L ${wire.start.x} ${routeY} L ${wire.end.x} ${routeY} L ${wire.end.x} ${wire.end.y}`}
            key={wire.id}
            style={{ "--wire-color": wire.color } as CSSProperties}
          />
        );
      })}
    </svg>
  );
}

function getWireColor(port: Device["ports"][number]): string {
  if (port.wireColor) return port.wireColor;
  return wireUseOptions.find((option) => option.value === port.wireUse)?.color ?? wireUseOptions[0].color;
}

function getWireAnchorKey(device: Device, port: Device["ports"][number]): string {
  return `${device.id}:${port.id}:${port.label}`;
}

function getWireAnchorSelector(device: Device, port: Device["ports"][number]): string {
  return `[data-wire-anchor="${cssEscape(getWireAnchorKey(device, port))}"]`;
}

function cssEscape(value: string): string {
  if ("CSS" in window && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function buildRackWireLinks(rackDevices: Device[], allDevices: Device[]): WireLink[] {
  const links: WireLink[] = [];
  const usedPairs = new Set<string>();
  const usedAnchors = new Set<string>();

  rackDevices.forEach((device) => {
    device.ports.forEach((port) => {
      const patchLink = getPortPatchLink(port);
      if (!patchLink.trim()) return;
      const target = findPortTarget(patchLink, allDevices, device.id);
      if (!target?.port || target.device.rackId !== device.rackId) return;

      const fromPort = getPhysicalFaceplatePort(device, port);
      const toPort = getPhysicalFaceplatePort(target.device, target.port);
      const fromAnchor = getWireAnchorKey(device, fromPort);
      const toAnchor = getWireAnchorKey(target.device, toPort);
      const pairKey = [fromAnchor, toAnchor].sort().join("::");
      if (usedPairs.has(pairKey) || usedAnchors.has(fromAnchor) || usedAnchors.has(toAnchor)) return;

      usedPairs.add(pairKey);
      usedAnchors.add(fromAnchor);
      usedAnchors.add(toAnchor);
      links.push({
        id: `wire-${pairKey}`,
        fromDevice: device,
        fromPort,
        toDevice: target.device,
        toPort,
      });
    });
  });

  return links;
}

function shouldClearPortLink(
  port: Device["ports"][number],
  sourceValue: string,
  targetValue: string,
): boolean {
  return portPatchPointsTo(port, sourceValue) || portPatchPointsTo(port, targetValue);
}

function shouldClearAnyPortLink(port: Device["ports"][number], targetValues: string[]): boolean {
  return targetValues.some((targetValue) => portPatchPointsTo(port, targetValue));
}

function portPatchPointsTo(port: Device["ports"][number], targetValue: string): boolean {
  return normalizeLinkText(getPortPatchLink(port)) === normalizeLinkText(targetValue);
}

function getPortPatchLink(port: Device["ports"][number]): string {
  return port.patchConnection || "";
}

function clearPatchLink(
  port: Device["ports"][number],
  targetValues: string[],
): Device["ports"][number] {
  const nextPort = { ...port, patchConnection: "" };
  if (targetValues.some((targetValue) => portPointsToEndpoint(nextPort.connectedTo, targetValue))) {
    nextPort.connectedTo = "";
  }
  return nextPort;
}

function uniqueLinkValues(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeLinkText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function portPointsToEndpoint(value: string | undefined, targetValue: string): boolean {
  return normalizeLinkText(value ?? "") === normalizeLinkText(targetValue);
}

function getWirePoint(device: Device, rackSizeU: number, port?: Device["ports"][number]): { x: number; y: number } {
  const portPosition = getFaceplatePortPosition(device, port);
  const x = portPosition.x;
  const y = getDeviceCenterY(device, rackSizeU) + portPosition.yOffset;

  return { x, y };
}

function getFaceplatePortPosition(
  device: Device,
  port?: Device["ports"][number],
): { x: number; yOffset: number } {
  if (!port || !isFaceplateDevice(device)) return { x: 50, yOffset: 0 };

  const { topPorts, bottomPorts } = buildFaceplateRows(device);
  const topIndex = findMatchingFaceplatePortIndex(topPorts, port);
  const bottomIndex = findMatchingFaceplatePortIndex(bottomPorts, port);
  const rowPorts = topIndex >= 0 || bottomIndex < 0 ? topPorts : bottomPorts;
  const index = topIndex >= 0 ? topIndex : Math.max(0, bottomIndex);
  const columns = Math.max(topPorts.length, bottomPorts.length, rowPorts.length, 1);
  const portAreaStart = 3;
  const portAreaWidth = 89;
  const x = portAreaStart + ((index + 0.5) / columns) * portAreaWidth;
  const yOffset = bottomPorts.length
    ? rowPorts === topPorts
      ? -0.7
      : 0.7
    : 0.1;

  return { x, yOffset };
}

function findMatchingFaceplatePortIndex(
  ports: Device["ports"],
  target: Device["ports"][number],
): number {
  const targetNumber = getPortSortNumber(target);
  const idIndex = ports.findIndex((port) => port.id === target.id);
  if (idIndex >= 0 && ports[idIndex].label === target.label) return idIndex;

  const labelIndex = ports.findIndex((port) => port.label === target.label);
  if (labelIndex >= 0) return labelIndex;

  return ports.findIndex((port) => getPortSortNumber(port) === targetNumber);
}

function getDeviceCenterY(device: Device, rackUnits: number): number {
  const topUnit = device.uStart;
  const centerFromTop = rackUnits - topUnit + device.heightU / 2;
  return Math.max(2, Math.min(98, (centerFromTop / rackUnits) * 100));
}

function isFaceplateDevice(device: Device): boolean {
  if (device.type === "switch" || device.type === "gateway" || device.type === "patch") return true;
  const value = `${device.name} ${device.model}`.toLowerCase();
  return /\bus-?\d{1,2}/.test(value) || /\busl?\d{1,2}/.test(value) || value.includes("usw");
}

function NetworkFaceplate({
  device,
  onOpenSettings,
  onPortClick,
  pendingPortLink,
}: {
  device: Device;
  onOpenSettings: () => void;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
  pendingPortLink: PendingPortLink | null;
}) {
  const { topPorts, bottomPorts } = buildFaceplateRows(device);
  const renderedPortCount = topPorts.length + bottomPorts.length;

  return (
    <div className={`faceplate ${device.type === "patch" ? "faceplate-patch" : ""}`}>
      <div className="faceplate-label">
        <div className="device-name-row">
          <strong>{device.name}</strong>
          <SettingsButton onOpenSettings={onOpenSettings} label={`Open settings for ${device.name}`} />
        </div>
        <span>{device.model} · {renderedPortCount} ports</span>
      </div>
      <div
        className="faceplate-ports"
        aria-label={`${device.name} ports`}
        style={{ "--faceplate-columns": String(Math.max(topPorts.length, bottomPorts.length, 1)) } as CSSProperties}
      >
        {device.type !== "patch" ? <FaceplateEndpointRow ports={topPorts} position="top" /> : null}
        <div className="faceplate-port-row">
          {topPorts.map((port) => (
            <FaceplatePort
              device={device}
              port={port}
              isPending={pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id}
              key={port.id}
              onPortClick={onPortClick}
            />
          ))}
        </div>
        {bottomPorts.length ? (
          <>
            <div className="faceplate-port-row">
              {bottomPorts.map((port) => (
                <FaceplatePort
                  device={device}
                  port={port}
                  isPending={pendingPortLink?.deviceId === device.id && pendingPortLink.portId === port.id}
                  key={port.id}
                  onPortClick={onPortClick}
                />
              ))}
            </div>
            {device.type !== "patch" ? <FaceplateEndpointRow ports={bottomPorts} position="bottom" /> : null}
          </>
        ) : null}
      </div>
      <DeviceStatusPill status={device.status} />
    </div>
  );
}

function FaceplateEndpointRow({
  ports,
  position,
}: {
  ports: Device["ports"];
  position: "top" | "bottom";
}) {
  return (
    <div className={`faceplate-endpoint-row endpoint-${position}`}>
      {ports.map((port) => {
        const endpoint = getPortEndpointDisplay(port);
        const endpointColor = getEndpointTypeColor(port.endpointType);

        return (
          <span
            className={`${endpoint ? "endpoint-label" : "endpoint-empty"} ${port.endpointType ? "typed" : ""}`}
            key={port.id}
            style={{ "--endpoint-color": endpointColor } as CSSProperties}
            title={endpoint}
          >
            {endpoint}
          </span>
        );
      })}
    </div>
  );
}

function SettingsButton({
  label,
  onOpenSettings,
}: {
  label: string;
  onOpenSettings: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="device-settings-button"
      draggable={false}
      title="Settings"
      onClick={(event) => {
        event.stopPropagation();
        onOpenSettings();
      }}
      onDragStart={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Settings2 size={13} />
    </button>
  );
}

function FaceplatePort({
  device,
  port,
  isPending,
  onPortClick,
}: {
  device: Device;
  port: Device["ports"][number];
  isPending: boolean;
  onPortClick: (device: Device, port: Device["ports"][number]) => void;
}) {
  const patchLink = getPortPatchLink(port);
  const tooltip = getPortTooltip(port);
  const endpointColor = getEndpointTypeColor(port.endpointType);
  const wireColor = getWireColor(port);

  return (
    <button
      aria-label={tooltip}
      className={`faceplate-port ${getFaceplatePortClass(port, device)} ${
        port.endpointType ? "has-endpoint-type" : ""
      } ${patchLink ? "has-patch-link" : ""} ${isPending ? "pending-link" : ""}`}
      data-wire-anchor={getWireAnchorKey(device, port)}
      data-tooltip={tooltip}
      style={{ "--endpoint-color": endpointColor, "--wire-color": wireColor } as CSSProperties}
      title={tooltip}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onPortClick(device, port);
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {compactPortLabel(port.label)}
    </button>
  );
}

function buildFaceplateRows(device: Device): {
  topPorts: Device["ports"];
  bottomPorts: Device["ports"];
} {
  const orderedPorts = getPhysicalFaceplatePorts(device);

  if (device.type === "patch") {
    return {
      topPorts: orderedPorts,
      bottomPorts: [],
    };
  }

  return {
    topPorts: orderedPorts.filter((_, index) => index % 2 === 0),
    bottomPorts: orderedPorts.filter((_, index) => index % 2 === 1),
  };
}

function getPhysicalFaceplatePorts(device: Device): Device["ports"] {
  const ports = getRenderableFaceplatePorts(device);
  if (inferExpectedPortCount(device) === 52 && device.type !== "patch") {
    return createPhysical52PortFaceplatePorts(device, ports);
  }

  const copperPorts = ports
    .filter((port) => !isSfpPortForLayout(port, device))
    .sort((left, right) => getPortSortNumber(left) - getPortSortNumber(right));
  const sfpPorts = ports
    .filter((port) => isSfpPortForLayout(port, device))
    .sort((left, right) => getPortSortNumber(left) - getPortSortNumber(right));

  return [...copperPorts, ...sfpPorts];
}

function createPhysical52PortFaceplatePorts(device: Device, ports: Device["ports"]): Device["ports"] {
  const portsByNumber = new Map(
    ports
      .filter((port) => port.label.toLowerCase() !== "mgmt")
      .map((port) => [getPortSortNumber(port), port]),
  );

  return Array.from({ length: 52 }, (_, index) => {
    const portNumber = index + 1;
    const port = portsByNumber.get(portNumber) ?? {
          id: `placeholder-${device.id}-${portNumber}`,
          label: String(portNumber),
          speed: portNumber >= 49 ? "SFP" : "Auto",
          connectedTo: "Open",
          patchConnection: "",
        };

    return {
      ...port,
      label: String(portNumber),
      speed: port.speed || (portNumber >= 49 ? "SFP" : "Auto"),
    };
  });
}

function getPhysicalFaceplatePort(
  device: Device,
  port: Device["ports"][number],
): Device["ports"][number] {
  if (!isFaceplateDevice(device)) return port;
  return getPhysicalFaceplatePorts(device).find((physicalPort) => physicalPort.id === port.id) ?? port;
}

function getRenderableFaceplatePorts(device: Device): Device["ports"] {
  const meaningfulPorts = device.ports.filter((port) => port.label.toLowerCase() !== "mgmt");
  const count = inferExpectedPortCount(device);
  const portsByNumber = new Map(
    meaningfulPorts.map((port) => [getPortSortNumber(port), port]),
  );

  if (device.type === "patch") {
    return createPlaceholderFaceplatePorts(device, count).map((placeholder) => {
      const portNumber = getPortSortNumber(placeholder);
      return portsByNumber.get(portNumber) ?? placeholder;
    });
  }

  const hasEveryExpectedPort = Array.from({ length: count }, (_, index) => index + 1).every(
    (portNumber) => portsByNumber.has(portNumber),
  );
  if (meaningfulPorts.length >= count && hasEveryExpectedPort) return meaningfulPorts;

  return createPlaceholderFaceplatePorts(device, count).map((placeholder) => {
    const portNumber = getPortSortNumber(placeholder);
    return portsByNumber.get(portNumber) ?? placeholder;
  });
}

function createPlaceholderFaceplatePorts(device: Device, count: number): Device["ports"] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const sfpStart = count > 48 ? 49 : count > 24 ? 25 : count > 16 ? 17 : count > 8 ? 9 : count + 1;
    const isSfp = number >= sfpStart;

    return {
      id: `placeholder-${device.id}-${number}`,
      label: String(number),
      speed: isSfp ? "SFP" : "Auto",
      connectedTo: "Open",
      patchConnection: "",
    };
  });
}

function inferExpectedPortCount(device: Device): number {
  const value = `${device.name} ${device.model}`.toLowerCase();
  if (/(^|[^0-9])52([^0-9]|$)/.test(value)) return 52;
  if (/(^|[^0-9])48([^0-9]|$)|48p|48-poe|48port|48-port/.test(value)) return 52;
  if (/(^|[^0-9])24([^0-9]|$)|24p|24-poe|24port|24-port/.test(value)) return 26;
  if (/(^|[^0-9])16([^0-9]|$)|16p|16port|16-port/.test(value)) return 18;
  if (/(^|[^0-9])8([^0-9]|$)|8p|8port|8-port/.test(value)) return 10;

  if (device.type === "patch") return 24;
  return device.type === "gateway" ? 11 : 26;
}

function getFaceplatePortClass(port: Device["ports"][number], device?: Device): string {
  const value = `${port.connectedTo ?? ""} ${port.speed} ${port.poeMode ?? ""}`.toLowerCase();
  const expectedPortCount = device ? inferExpectedPortCount(device) : 0;
  if (getPortPatchLink(port) && device?.type === "patch" && !isFastEthernetPort(port) && !isGigabitEthernetPort(port)) {
    return "port-patch-linked";
  }
  if (value.includes("down")) return "port-open";
  if (isSfpPortForLayout(port, device) || (value.includes("10g") && expectedPortCount <= 48)) {
    return "port-uplink";
  }
  if (isFastEthernetPort(port)) return "port-fe";
  if (isGigabitEthernetPort(port)) return "port-gbe";
  if (value.includes("open")) return "port-open";
  if (value.includes("poe")) return "port-poe";
  if (port.connectedTo && !value.includes("no client reported")) return "port-active";
  if (value.includes("link up")) return "port-link";
  return "port-open";
}

function isFastEthernetPort(port: Device["ports"][number]): boolean {
  const value = `${port.speed} ${port.connectedTo ?? ""}`.toLowerCase();
  return /\bfe\b/.test(value) || /\b100m\b/.test(value) || /\b100\s?mb/.test(value);
}

function isGigabitEthernetPort(port: Device["ports"][number]): boolean {
  const value = `${port.speed} ${port.connectedTo ?? ""}`.toLowerCase();
  return /\bgbe\b/.test(value) || /\b1g\b/.test(value) || /\b1000m\b/.test(value);
}

function isSfpPortForLayout(port: Device["ports"][number], device?: Device): boolean {
  const value = port.label.toLowerCase();
  const portNumber = getPortSortNumber(port);
  const expectedPortCount = device ? inferExpectedPortCount(device) : 0;

  if (expectedPortCount > 48 && Number.isFinite(portNumber)) {
    return portNumber >= 49 && portNumber <= 52;
  }

  const isFinalSfpBlock =
    Boolean(device) && expectedPortCount > 48 && portNumber >= 49 && portNumber <= 52;

  return value.includes("sfp") || value.includes("sfpplus") || isFinalSfpBlock;
}

function getPortSortNumber(port: Device["ports"][number]): number {
  const match = port.label.match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function compactPortLabel(label: string): string {
  const match = label.match(/\d+/);
  if (match) return match[0];
  if (label.toLowerCase().includes("sfp")) return "S";
  return label.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "-";
}

function DeviceStatusPill({ status }: { status: DeviceStatus }) {
  const Icon = status === "online" ? CheckCircle2 : status === "attention" ? CircleAlert : Route;

  return (
    <span className={`status-pill status-${status}`}>
      <Icon size={14} />
      {statusLabels[status]}
    </span>
  );
}

function DeviceEditor({
  device,
  racks,
  devices,
  onDeleteDevice,
  onMoveDevice,
  onUpdateDevice,
}: {
  device: Device;
  racks: RackType[];
  devices: Device[];
  onDeleteDevice: (deviceId: string) => void;
  onMoveDevice: (deviceId: string, rackId: string, uStart: number) => void;
  onUpdateDevice: (device: Device) => void;
}) {
  const linkTargets = getLinkTargetOptions(device, devices, racks);
  const editorPorts = device.type === "patch" ? getRenderableFaceplatePorts(device) : device.ports;
  const canDeleteDevice = isCustomDevice(device);

  function updatePort(portId: string, patch: Partial<Device["ports"][number]>) {
    const existingPort = device.ports.find((port) => port.id === portId);
    const editorPort = editorPorts.find((port) => port.id === portId);
    let nextPort = {
      ...(editorPort ?? { id: portId, label: "Port", speed: "Auto" }),
      ...(existingPort ?? {}),
      ...patch,
    };
    if (device.type === "patch" && typeof patch.patchConnection === "string" && patch.patchConnection) {
      const target = findPortTarget(patch.patchConnection, devices, device.id);
      if (target?.port) {
        nextPort = enrichPatchPortFromTarget(nextPort, target.port, target.device);
      }
    }

    onUpdateDevice({
      ...device,
      ports: existingPort
        ? device.ports.map((port) => (port.id === portId ? nextPort : port))
        : [...device.ports, nextPort].sort((left, right) => getPortSortNumber(left) - getPortSortNumber(right)),
    });
  }

  function addPort() {
    const nextIndex = device.ports.length + 1;
    onUpdateDevice({
      ...device,
      ports: [
        ...device.ports,
        {
          id: `custom-port-${device.id}-${Date.now()}`,
          label: getDefaultPortLabel(device.type, nextIndex),
          speed: device.type === "patch" ? "Passive" : "Auto",
          connectedTo: "",
          patchConnection: "",
          endpointType: "",
          endpointLocation: "",
          endpointOwner: "",
          endpointVendor: "",
          endpointNotes: "",
          wireUse: "data",
          wireColor: wireUseOptions[0].color,
        },
      ],
    });
  }

  function removePort(portId: string) {
    const port = device.ports.find((item) => item.id === portId);
    if (port && !window.confirm(`Delete ${port.label} from ${device.name}?`)) return;

    onUpdateDevice({
      ...device,
      ports: device.ports.filter((port) => port.id !== portId),
    });
  }

  return (
    <section className="panel device-editor">
      <div className="section-heading">
        <Settings2 size={18} />
        <h2>Device details</h2>
      </div>
      {canDeleteDevice ? (
        <div className="editor-danger-row">
          <span>This item was manually added to the rack plan.</span>
          <button className="danger-action" type="button" onClick={() => onDeleteDevice(device.id)}>
            <Trash2 size={15} />
            Delete item
          </button>
        </div>
      ) : null}

      <div className="editor-grid">
        <label>
          <span>Name</span>
          <input
            value={device.name}
            onChange={(event) => onUpdateDevice({ ...device, name: event.target.value })}
          />
        </label>

        <label>
          <span>Status</span>
          <select
            value={device.status}
            onChange={(event) =>
              onUpdateDevice({ ...device, status: event.target.value as DeviceStatus })
            }
          >
            <option value="online">Online</option>
            <option value="attention">Needs review</option>
            <option value="planned">Planned</option>
          </select>
        </label>

        <label>
          <span>Type</span>
          <select
            value={device.type}
            onChange={(event) => {
              const nextType = event.target.value as DeviceType;
              const typeChanged = nextType !== device.type;
              const shouldResetPorts = typeChanged && shouldResetPortsForTypeChange(device.type, nextType);
              const nextPorts = isPortlessDeviceType(nextType)
                ? []
                : device.ports.length && !shouldResetPorts
                  ? device.ports
                  : createPorts(defaultPortCountForType(nextType), nextType);

              return (
              onUpdateDevice({
                ...device,
                type: nextType,
                ports: nextPorts,
              })
              );
            }}
          >
            <option value="patch">Patch panel</option>
            <option value="server">Server</option>
            <option value="switch">Switch</option>
            <option value="gateway">Router / gateway</option>
            <option value="power">Power / UPS</option>
            <option value="fan">Fan panel</option>
            <option value="blank">Blank panel</option>
            <option value="shelf">Rack shelf</option>
            <option value="raspberry-pi">Raspberry Pi tray</option>
            <option value="nvr">NVR</option>
            <option value="modem">Modem</option>
          </select>
        </label>

        <label>
          <span>Model</span>
          <input
            value={device.model}
            onChange={(event) => onUpdateDevice({ ...device, model: event.target.value })}
          />
        </label>

        <label>
          <span>Rack</span>
          <select
            value={device.rackId}
            onChange={(event) => onMoveDevice(device.id, event.target.value, device.uStart)}
          >
            {racks.map((rack) => (
              <option key={rack.id} value={rack.id}>
                {rack.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Rack U</span>
          <input
            type="number"
            min={1}
            max={racks.find((rack) => rack.id === device.rackId)?.sizeU ?? 48}
            value={device.uStart}
            onChange={(event) =>
              onMoveDevice(device.id, device.rackId, Number(event.target.value))
            }
          />
        </label>

        <label>
          <span>Height U</span>
          <input
            type="number"
            min={1}
            max={8}
            value={device.heightU}
            onChange={(event) =>
              onUpdateDevice({ ...device, heightU: parsePositiveNumber(event.target.value, 1) })
            }
          />
        </label>

        <label className="checkbox-label">
          <span>Lock item</span>
          <input
            type="checkbox"
            checked={Boolean(device.locked)}
            onChange={(event) => onUpdateDevice({ ...device, locked: event.target.checked })}
          />
        </label>
      </div>

      {isPortlessDeviceType(device.type) ? null : (
        <>
          <div className="editor-subhead">
            <strong>Ports</strong>
            <button className="inline-action" onClick={addPort}>
              <Plus size={15} />
              Add port
            </button>
          </div>

          <div className="editor-port-list">
            {editorPorts.map((port) => (
          <article className="editor-port-card" key={port.id}>
            <div className="editor-port-card-head">
              <strong>{port.label || "Port"}</strong>
              <button
                className="icon-danger-action"
                title="Delete port"
                aria-label={`Delete ${port.label || "port"}`}
                type="button"
                onClick={() => removePort(port.id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="editor-port-row">
              <input
                aria-label="Port label"
                value={port.label}
                onChange={(event) => updatePort(port.id, { label: event.target.value })}
              />
              <select
                aria-label="Link target"
                value={linkTargets.some((target) => target.value === port.patchConnection) ? port.patchConnection : ""}
                onChange={(event) => updatePort(port.id, { patchConnection: event.target.value })}
              >
                <option value="">Manual / no target</option>
                {linkTargets.map((target) => {
                  const assigned = isLinkTargetAssigned(target.value, devices, device.id, port.id);

                  return (
                    <option
                      className={assigned ? "assigned-target" : ""}
                      disabled={assigned}
                      key={target.value}
                      value={target.value}
                    >
                      {assigned ? `${target.label} - assigned` : target.label}
                    </option>
                  );
                })}
              </select>
              <input
                aria-label="Connected endpoint"
                value={getConnectedEndpointDisplay(port)}
                onChange={(event) => updatePort(port.id, { connectedTo: event.target.value })}
                placeholder="Connected device"
              />
              <select
                aria-label="Wire use"
                value={port.wireUse ?? "data"}
                onChange={(event) => {
                  const option = wireUseOptions.find((item) => item.value === event.target.value);
                  updatePort(port.id, {
                    wireUse: event.target.value,
                    wireColor: option?.color ?? port.wireColor,
                  });
                }}
              >
                {wireUseOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Wire color"
                type="color"
                value={getWireColor(port)}
                onChange={(event) =>
                  updatePort(port.id, {
                    wireUse: port.wireUse ?? "custom",
                    wireColor: event.target.value,
                  })
                }
              />
              <input
                aria-label="Speed"
                value={port.speed}
                onChange={(event) => updatePort(port.id, { speed: event.target.value })}
                placeholder="Speed"
              />
              <input
                aria-label="IP address"
                value={port.connectedIp ?? ""}
                onChange={(event) => updatePort(port.id, { connectedIp: event.target.value })}
                placeholder="IP"
              />
              <input
                aria-label="MAC address"
                value={port.connectedMac ?? ""}
                onChange={(event) => updatePort(port.id, { connectedMac: event.target.value })}
                placeholder="MAC"
              />
            </div>
            <details className="endpoint-details">
              <summary>Endpoint details</summary>
              <div className="endpoint-grid">
                <label>
                  <span>Type</span>
                  <select
                    value={port.endpointType ?? ""}
                    onChange={(event) => updatePort(port.id, { endpointType: event.target.value })}
                  >
                    {endpointTypeOptions.map((option) => (
                      <option key={option.value || "unknown"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Location</span>
                  <input
                    value={port.endpointLocation ?? ""}
                    onChange={(event) => updatePort(port.id, { endpointLocation: event.target.value })}
                    placeholder="Office, register, closet"
                  />
                </label>
                <label>
                  <span>Owner / use</span>
                  <input
                    value={port.endpointOwner ?? ""}
                    onChange={(event) => updatePort(port.id, { endpointOwner: event.target.value })}
                    placeholder="Sales, POS, camera"
                  />
                </label>
                <label>
                  <span>Vendor</span>
                  <input
                    value={port.endpointVendor ?? ""}
                    onChange={(event) => updatePort(port.id, { endpointVendor: event.target.value })}
                    placeholder="Vendor"
                  />
                </label>
                <label className="endpoint-notes">
                  <span>Notes</span>
                  <input
                    value={port.endpointNotes ?? ""}
                    onChange={(event) => updatePort(port.id, { endpointNotes: event.target.value })}
                    placeholder="Cable label, room jack, handoff notes"
                  />
                </label>
              </div>
            </details>
          </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function getLinkTargetOptions(
  sourceDevice: Device,
  devices: Device[],
  racks: RackType[],
): Array<{ label: string; value: string }> {
  const racksById = new Map(racks.map((rack) => [rack.id, rack.name]));

  return devices
    .filter(
      (device) =>
        device.id !== sourceDevice.id &&
        canDeviceAppearInPortTargetList(sourceDevice, device),
    )
    .flatMap((device) => {
      const sameRack = device.rackId === sourceDevice.rackId;
      const ports = getDisplayPortsForLinks(device).filter((port) =>
        sameRack ? true : canPortAppearAsCrossRackTarget(device, port),
      );
      const rackName = racksById.get(device.rackId) ?? device.rackId;

      return ports.map((port) => {
        const value = `${device.name} / ${port.label}`;

        return {
          value,
          label: sameRack ? `${device.name} - ${port.label}` : `${rackName} / ${device.name} - ${port.label}`,
        };
      });
    });
}

function canDeviceAppearInPortTargetList(sourceDevice: Device, targetDevice: Device): boolean {
  if (!targetDevice.ports.length && !isFaceplateDevice(targetDevice)) return false;
  if (isPortlessDeviceType(targetDevice.type)) return false;
  if (targetDevice.rackId !== sourceDevice.rackId) {
    return targetDevice.type === "switch" || targetDevice.type === "gateway";
  }
  if (sourceDevice.type === "patch" && targetDevice.type === "patch") return false;
  if (targetDevice.type === "switch" || targetDevice.type === "gateway") return true;
  if (
    targetDevice.type === "server" ||
    targetDevice.type === "raspberry-pi" ||
    targetDevice.type === "nvr" ||
    targetDevice.type === "modem" ||
    targetDevice.type === "shelf"
  ) {
    return true;
  }
  return targetDevice.type === "patch";
}

function canPortAppearAsCrossRackTarget(device: Device, port: Device["ports"][number]): boolean {
  if (isSfpPortForLayout(port, device)) return true;
  const label = port.label.toLowerCase();
  const value = `${port.speed} ${port.connectedTo ?? ""}`.toLowerCase();
  const portNumber = getPortSortNumber(port);
  return (
    label.includes("sfp") ||
    value.includes("sfp") ||
    value.includes("uplink") ||
    value.includes("10g") ||
    (inferExpectedPortCount(device) >= 48 && Number.isFinite(portNumber) && portNumber >= 49)
  );
}

function isLinkTargetAssigned(
  targetValue: string,
  devices: Device[],
  sourceDeviceId: string,
  sourcePortId: string,
): boolean {
  const target = normalizeLinkText(targetValue);

  return devices.some((device) =>
    device.ports.some((port) => {
      if (device.id === sourceDeviceId && port.id === sourcePortId) return false;
      return normalizeLinkText(getPortPatchLink(port)) === target;
    }),
  );
}

function ConnectionMap({
  rack,
  connections: visibleConnections,
  collapsed,
  onToggle,
}: {
  rack?: RackType;
  connections: InventoryState["connections"];
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="panel collapsible-panel">
      <div className="section-title-row compact">
        <div className="section-heading">
          <Route size={18} />
          <div>
            <h2>Connections</h2>
            <span className="panel-scope">
              {rack ? `${rack.name} only` : "No rack selected"} · {visibleConnections.length} links
            </span>
          </div>
        </div>
        <button className="collapse-action" type="button" onClick={onToggle}>
          <ChevronDown className={collapsed ? "" : "expanded"} size={16} />
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {collapsed ? null : (
        <>
          <div className="topology">
            {rack ? (
              <div className="topology-node" key={rack.id}>
                <strong>{rack.name}</strong>
                <span>{rack.site}</span>
              </div>
            ) : null}
          </div>
          <div className="connection-list">
            {visibleConnections.map((connection) => (
            <article className={`connection connection-${connection.status}`} key={connection.id}>
              <Cable size={17} />
              <div>
                <strong>
                  {connection.fromDevice} to {connection.toDevice}
                </strong>
                <span>{connection.medium}</span>
              </div>
            </article>
            ))}
            {!visibleConnections.length ? <p className="empty-panel-message">No links for this rack yet.</p> : null}
          </div>
        </>
      )}
    </section>
  );
}

function PortInspector({
  collapsed,
  query,
  rack,
  rowCount,
  setQuery,
  rows,
  totalPorts,
  onToggle,
}: {
  collapsed: boolean;
  query: string;
  rack?: RackType;
  rowCount: number;
  setQuery: (value: string) => void;
  totalPorts: number;
  onToggle: () => void;
  rows: Array<{
    id: string;
    label: string;
    speed: string;
    vlan?: string;
    connectedTo?: string;
    importedEndpointName?: string;
    connectedMac?: string;
    connectedIp?: string;
    endpointType?: string;
    endpointLocation?: string;
    endpointOwner?: string;
    endpointVendor?: string;
    endpointNotes?: string;
    poeMode?: string;
    stp?: string;
    device: Device;
  }>;
}) {
  return (
    <section className="panel port-panel collapsible-panel">
      <div className="section-title-row compact">
        <div className="section-heading">
          <EthernetPort size={18} />
          <div>
            <h2>Port map</h2>
            <span className="panel-scope">
              {rack ? `${rack.name} only` : "No rack selected"} · {rowCount} of {totalPorts} ports
            </span>
          </div>
        </div>
        <div className="panel-actions">
          {!collapsed ? (
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="Search ports"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}
          <button className="collapse-action" type="button" onClick={onToggle}>
            <ChevronDown className={collapsed ? "" : "expanded"} size={16} />
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>
      {collapsed ? null : <div className="port-table">
        <div className="port-row table-head">
          <span>Device</span>
          <span>Port</span>
          <span>UniFi reports</span>
          <span>Type</span>
          <span>Location</span>
          <span>IP</span>
          <span>MAC</span>
          <span>Speed</span>
        </div>
        {rows.map((row) => (
          <div className="port-row" key={row.id}>
            <span>{row.device.name}</span>
            <span>{row.label}</span>
            <span>{getConnectedEndpointDisplay(row)}</span>
            <span>{formatEndpointType(row.endpointType)}</span>
            <span>{row.endpointLocation || row.endpointOwner || "-"}</span>
            <span>{row.connectedIp ?? "-"}</span>
            <span>{row.connectedMac ?? "-"}</span>
            <span>{row.speed}</span>
          </div>
        ))}
        {!rows.length ? <p className="empty-panel-message">No matching ports in this rack.</p> : null}
      </div>}
    </section>
  );
}

function ReportsPage({
  businessName,
  devices,
  racks,
}: {
  businessName: string;
  devices: Device[];
  racks: RackType[];
}) {
  const rackIds = new Set(racks.map((rack) => rack.id));
  const racksById = new Map(racks.map((rack) => [rack.id, rack]));
  const switches = devices
    .filter((device) => device.type === "switch" && rackIds.has(device.rackId))
    .sort((left, right) => {
      const leftRack = racksById.get(left.rackId)?.name ?? "";
      const rightRack = racksById.get(right.rackId)?.name ?? "";
      return leftRack.localeCompare(rightRack) || left.name.localeCompare(right.name);
    });
  const totalPorts = switches.reduce((sum, device) => sum + getPhysicalFaceplatePorts(device).length, 0);
  const reportDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  return (
    <section className="reports-page" aria-label="Switch port reports">
      <div className="report-header">
        <div>
          <p className="eyebrow">{businessName}</p>
          <h2>Switch port report</h2>
          <span>
            {switches.length} switches · {totalPorts} ports · Generated {reportDate}
          </span>
        </div>
        <button className="inline-action report-print-button" type="button" onClick={() => window.print()}>
          <Printer size={16} />
          Print report
        </button>
      </div>

      {switches.map((device) => {
        const rack = racksById.get(device.rackId);
        const ports = getPhysicalFaceplatePorts(device);

        return (
          <article className="switch-report-card" key={device.id}>
            <div className="switch-report-title">
              <div>
                <h3>{device.name}</h3>
                <span>
                  {rack?.name ?? "Unknown rack"} · {device.model} · {ports.length} ports
                </span>
              </div>
            </div>
            <div className="report-table">
              <div className="report-row report-table-head">
                <span>Switch name</span>
                <span>Port</span>
                <span>Device name</span>
                <span>Speed</span>
                <span>IP</span>
                <span>MAC</span>
              </div>
              {ports.map((port) => (
                <div className="report-row" key={`${device.id}-${port.id}`}>
                  <span>{device.name}</span>
                  <span>{port.label}</span>
                  <span>{getReportDeviceName(port)}</span>
                  <span>{port.speed || "-"}</span>
                  <span>{port.connectedIp || "-"}</span>
                  <span>{port.connectedMac || "-"}</span>
                </div>
              ))}
            </div>
          </article>
        );
      })}

      {!switches.length ? (
        <div className="panel empty-report-panel">
          <p>No switches found for this business yet. Sync inventory or add switches to a rack first.</p>
        </div>
      ) : null}
    </section>
  );
}

function getReportDeviceName(port: Device["ports"][number]): string {
  const candidates = [
    port.importedEndpointName,
    port.connectedTo,
    port.patchConnection,
    port.endpointOwner,
    port.endpointLocation,
    port.connectedIp,
    port.connectedMac,
  ];
  const value = candidates.find((candidate) => {
    const formatted = formatConnectionLabel(candidate);
    const normalized = formatted.toLowerCase();
    return formatted && !["open", "down", "unknown", "-"].includes(normalized);
  });

  return formatConnectionLabel(value);
}

function formatEndpointType(value: string | undefined): string {
  if (!value) return "-";
  return endpointTypeOptions.find((option) => option.value === value)?.label ?? value;
}

function getEndpointTypeColor(value?: string): string {
  if (!value) return "transparent";
  return endpointTypeOptions.find((option) => option.value === value)?.color ?? "#c8d7d0";
}

function formatSavedAt(value: string): string {
  if (!value) return "Unknown save time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString();
}

export default App;
