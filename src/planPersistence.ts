import type { InventoryState } from "./types";

export type PlanSnapshot = {
  version: 1;
  savedAt: string;
  profile: {
    tenantId: string;
    businessId: string;
    businessName: string;
    siteId: string;
    siteName: string;
    rackId?: string;
  };
  inventory: InventoryState;
};

export function createPlanSnapshot(input: {
  inventory: InventoryState;
  businessId: string;
  businessName: string;
  siteId: string;
  siteName: string;
  rackId?: string;
}): PlanSnapshot {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    profile: {
      tenantId: `tenant-${input.businessId}`,
      businessId: input.businessId,
      businessName: input.businessName,
      siteId: input.siteId,
      siteName: input.siteName,
      rackId: input.rackId,
    },
    inventory: input.inventory,
  };
}

export async function savePlanSnapshot(snapshot: PlanSnapshot): Promise<string> {
  const response = await fetch("/api/plans/save", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  const result = (await response.json()) as { ok: boolean; message: string };

  if (!response.ok || !result.ok) {
    throw new Error(result.message || "Could not save plan");
  }

  return result.message;
}

export function downloadPlanSnapshot(snapshot: PlanSnapshot): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slugify(snapshot.profile.businessName)}-${slugify(snapshot.profile.siteName)}-rack-plan.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function parsePlanSnapshot(value: unknown): PlanSnapshot | null {
  if (!isObject(value)) return null;

  const rawInventory = isInventoryState(value.inventory) ? value.inventory : isInventoryState(value) ? value : null;
  if (!rawInventory) return null;

  const firstBusiness = rawInventory.businesses[0];
  const firstRack = rawInventory.racks[0];
  const profile = isObject(value.profile) ? value.profile : {};
  const businessId = asString(profile.businessId) ?? firstBusiness?.id ?? "imported";
  const businessName = asString(profile.businessName) ?? firstBusiness?.name ?? "Imported Plan";
  const siteId = asString(profile.siteId) ?? firstRack?.site ?? firstBusiness?.sites[0] ?? "default";
  const siteName = asString(profile.siteName) ?? firstRack?.site ?? firstBusiness?.sites[0] ?? "Default";
  const rackId = asString(profile.rackId) ?? firstRack?.id;

  return {
    version: 1,
    savedAt: asString(value.savedAt) ?? new Date().toISOString(),
    profile: {
      tenantId: asString(profile.tenantId) ?? `tenant-${businessId}`,
      businessId,
      businessName,
      siteId,
      siteName,
      rackId,
    },
    inventory: rawInventory,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "rack-plan";
}

function isInventoryState(value: unknown): value is InventoryState {
  if (!isObject(value)) return false;
  if (!Array.isArray(value.businesses) || !Array.isArray(value.racks) || !Array.isArray(value.devices)) {
    return false;
  }

  return value.devices.every((device) => isObject(device) && Array.isArray(device.ports));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
