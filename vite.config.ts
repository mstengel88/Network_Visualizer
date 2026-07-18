import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";
import https from "node:https";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

export default defineConfig({
  server: {
    allowedHosts: ["networkrack.ghstickets.com"],
  },
  plugins: [
    react(),
    {
      name: "unifi-dev-proxy",
      configureServer(server) {
        registerAccessRoutes(server.middlewares);
        const accessSessions = new Map<string, number>();

        server.middlewares.use("/api/unifi/test", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for UniFi connection tests" });
            return;
          }

          try {
            const profile = await readJsonBody<{
              mode: "cloud" | "local";
              controllerUrl: string;
              siteId: string;
              apiToken: string;
            }>(req);

            if (!profile.controllerUrl || !profile.apiToken) {
              sendJson(res, 400, {
                ok: false,
                message: "Controller URL and API token are required",
              });
              return;
            }

            const result = await testUniFiProfile(profile);
            sendJson(res, result.ok ? 200 : 502, result);
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "UniFi connection test failed",
            });
          }
        });

        server.middlewares.use("/api/unifi/inventory", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for UniFi inventory sync" });
            return;
          }

          try {
            const profile = await readJsonBody<{
              mode: "cloud" | "local";
              controllerUrl: string;
              siteId: string;
              apiToken: string;
              label?: string;
            }>(req);

            if (profile.mode !== "cloud") {
              sendJson(res, 400, {
                ok: false,
                message: "Inventory sync currently supports UniFi Site Manager cloud mode",
              });
              return;
            }

            if (!profile.apiToken) {
              sendJson(res, 400, {
                ok: false,
                message: "API token is required for UniFi inventory sync",
              });
              return;
            }

            const result = await syncCloudInventory(profile);
            sendJson(res, result.ok ? 200 : 502, result);
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "UniFi inventory sync failed",
            });
          }
        });

        server.middlewares.use("/api/plans/save", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for plan saves" });
            return;
          }

          try {
            const snapshot = await readJsonBody<{
              profile?: {
                tenantId?: string;
                businessId?: string;
                siteId?: string;
                businessName?: string;
                siteName?: string;
              };
            }>(req);
            const result = await savePlanSnapshotToDisk(snapshot);
            sendJson(res, 200, {
              ok: true,
              message: `Saved plan to ${result.relativePath}`,
              data: result,
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not save plan",
            });
          }
        });

        server.middlewares.use("/api/plans/list", async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, message: "Use GET for saved plan lists" });
            return;
          }

          try {
            const plans = await listSavedPlanSnapshots();
            sendJson(res, 200, {
              ok: true,
              message: `Found ${plans.length} saved plans`,
              data: plans,
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not list saved plans",
            });
          }
        });

        server.middlewares.use("/api/plans/load", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for saved plan loads" });
            return;
          }

          try {
            const request = await readJsonBody<{ relativePath?: string }>(req);
            const snapshot = await loadSavedPlanSnapshot(request.relativePath ?? "");
            sendJson(res, 200, {
              ok: true,
              message: "Loaded saved plan",
              data: snapshot,
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not load saved plan",
            });
          }
        });

        server.middlewares.use("/api/access/login", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for door access login" });
            return;
          }

          try {
            const request = await readJsonBody<{ password?: string }>(req);
            const configuredPassword = getDoorAccessPassword();

            if (!configuredPassword) {
              sendJson(res, 503, {
                ok: false,
                message: "Door access password is not configured. Set DOOR_ACCESS_PASSWORD on the server.",
              });
              return;
            }

            if (!passwordsMatch(request.password ?? "", configuredPassword)) {
              sendJson(res, 401, { ok: false, message: "Door access password is incorrect" });
              return;
            }

            const token = randomUUID();
            const expiresAt = Date.now() + 15 * 60 * 1000;
            accessSessions.set(token, expiresAt);
            sendJson(res, 200, {
              ok: true,
              message: "Door access page unlocked for this browser session",
              data: { token, expiresAt },
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not unlock door access page",
            });
          }
        });

        server.middlewares.use("/api/access/doors", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for door access door lists" });
            return;
          }

          try {
            const request = await readJsonBody<{ token?: string }>(req);
            if (!isDoorAccessSessionValid(accessSessions, request.token ?? "")) {
              sendJson(res, 401, { ok: false, message: "Door access session expired. Unlock the page again." });
              return;
            }

            const config = getUniFiAccessConfig();
            if (!config.baseUrl || !config.apiToken) {
              sendJson(res, 503, {
                ok: false,
                message: "UniFi Access API is not configured. Set UNIFI_ACCESS_URL and UNIFI_ACCESS_TOKEN on the server.",
              });
              return;
            }

            const result = await requestUniFiAccessJson(
              `${config.baseUrl}/api/v1/developer/doors`,
              "GET",
              config.apiToken,
            );

            if (!result.ok) {
              sendJson(res, 502, {
                ok: false,
                message: `Could not load UniFi Access doors: ${result.message}`,
                data: result.data,
              });
              return;
            }

            sendJson(res, 200, {
              ok: true,
              message: "Loaded UniFi Access doors",
              data: getAccessDoorArray(result.data).map(normalizeAccessDoor),
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not load UniFi Access doors",
            });
          }
        });

        server.middlewares.use("/api/access/buzz", async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, message: "Use POST for door buzz actions" });
            return;
          }

          try {
            const request = await readJsonBody<{ token?: string; doorId?: string; doorName?: string }>(req);
            if (!isDoorAccessSessionValid(accessSessions, request.token ?? "")) {
              sendJson(res, 401, { ok: false, message: "Door access session expired. Unlock the page again." });
              return;
            }

            const config = getUniFiAccessConfig();
            if (!config.baseUrl || !config.apiToken) {
              sendJson(res, 503, {
                ok: false,
                message: "UniFi Access API is not configured. Set UNIFI_ACCESS_URL and UNIFI_ACCESS_TOKEN on the server.",
              });
              return;
            }

            if (!request.doorId) {
              sendJson(res, 400, { ok: false, message: "Door ID is required" });
              return;
            }

            const result = await requestUniFiAccessJson(
              `${config.baseUrl}/api/v1/developer/doors/${encodeURIComponent(request.doorId)}/unlock`,
              "PUT",
              config.apiToken,
            );

            sendJson(res, result.ok ? 200 : 502, {
              ok: result.ok,
              message: result.ok
                ? `Buzzed ${request.doorName || "door"}`
                : `Could not buzz ${request.doorName || "door"}: ${result.message}`,
              data: result.data,
            });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : "Could not run door buzz action",
            });
          }
        });
      },
      configurePreviewServer(server) {
        registerAccessRoutes(server.middlewares);
      },
    },
  ],
});

function registerAccessRoutes(middlewares: {
  use: (
    path: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) => void;
}) {
  const accessSessions = new Map<string, number>();

  middlewares.use("/api/access/login", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, message: "Use POST for door access login" });
      return;
    }

    try {
      const request = await readJsonBody<{ password?: string }>(req);
      const configuredPassword = getDoorAccessPassword();

      if (!configuredPassword) {
        sendJson(res, 503, {
          ok: false,
          message: "Door access password is not configured. Set DOOR_ACCESS_PASSWORD on the server.",
        });
        return;
      }

      if (!passwordsMatch(request.password ?? "", configuredPassword)) {
        sendJson(res, 401, { ok: false, message: "Door access password is incorrect" });
        return;
      }

      const token = randomUUID();
      const expiresAt = Date.now() + 15 * 60 * 1000;
      accessSessions.set(token, expiresAt);
      sendJson(res, 200, {
        ok: true,
        message: "Door access page unlocked for this browser session",
        data: { token, expiresAt },
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Could not unlock door access page",
      });
    }
  });

  middlewares.use("/api/access/doors", async (req, res) => {
    await handleAccessDoorsRequest(req, res, accessSessions);
  });

  middlewares.use("/api/access-doors", async (req, res) => {
    await handleAccessDoorsRequest(req, res, accessSessions);
  });

  middlewares.use("/api/access/buzz", async (req, res) => {
    await handleAccessBuzzRequest(req, res, accessSessions);
  });

  middlewares.use("/api/access-buzz", async (req, res) => {
    await handleAccessBuzzRequest(req, res, accessSessions);
  });
}

async function handleAccessDoorsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accessSessions: Map<string, number>,
) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, message: "Use POST for door access door lists" });
      return;
    }

    try {
      const request = await readJsonBody<{ token?: string }>(req);
      if (!isDoorAccessSessionValid(accessSessions, request.token ?? "")) {
        sendJson(res, 401, { ok: false, message: "Door access session expired. Unlock the page again." });
        return;
      }

      const config = getUniFiAccessConfig();
      if (!config.baseUrl || !config.apiToken) {
        sendJson(res, 503, {
          ok: false,
          message: "UniFi Access API is not configured. Set UNIFI_ACCESS_URL and UNIFI_ACCESS_TOKEN on the server.",
        });
        return;
      }

      const result = await requestUniFiAccessJson(
        `${config.baseUrl}/api/v1/developer/doors`,
        "GET",
        config.apiToken,
      );

      if (!result.ok) {
        sendJson(res, 502, {
          ok: false,
          message: `Could not load UniFi Access doors: ${result.message}`,
          data: result.data,
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        message: "Loaded UniFi Access doors",
        data: getAccessDoorArray(result.data).map(normalizeAccessDoor),
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Could not load UniFi Access doors",
      });
    }
}

async function handleAccessBuzzRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accessSessions: Map<string, number>,
) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, message: "Use POST for door buzz actions" });
      return;
    }

    try {
      const request = await readJsonBody<{ token?: string; doorId?: string; doorName?: string }>(req);
      if (!isDoorAccessSessionValid(accessSessions, request.token ?? "")) {
        sendJson(res, 401, { ok: false, message: "Door access session expired. Unlock the page again." });
        return;
      }

      const config = getUniFiAccessConfig();
      if (!config.baseUrl || !config.apiToken) {
        sendJson(res, 503, {
          ok: false,
          message: "UniFi Access API is not configured. Set UNIFI_ACCESS_URL and UNIFI_ACCESS_TOKEN on the server.",
        });
        return;
      }

      if (!request.doorId) {
        sendJson(res, 400, { ok: false, message: "Door ID is required" });
        return;
      }

      const result = await requestUniFiAccessJson(
        `${config.baseUrl}/api/v1/developer/doors/${encodeURIComponent(request.doorId)}/unlock`,
        "PUT",
        config.apiToken,
      );

      sendJson(res, result.ok ? 200 : 502, {
        ok: result.ok,
        message: result.ok
          ? `Buzzed ${request.doorName || "door"}`
          : `Could not buzz ${request.doorName || "door"}: ${result.message}`,
        data: result.data,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Could not run door buzz action",
      });
    }
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: { ok: boolean; message: string; data?: unknown },
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Could not parse UniFi connection request"));
      }
    });
    req.on("error", reject);
  });
}

function getDoorAccessPassword(): string {
  return process.env.DOOR_ACCESS_PASSWORD || process.env.ACCESS_PAGE_PASSWORD || "";
}

function passwordsMatch(input: string, expected: string): boolean {
  const inputHash = createHash("sha256").update(input).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(inputHash, expectedHash);
}

function isDoorAccessSessionValid(sessions: Map<string, number>, token: string): boolean {
  const expiresAt = sessions.get(token) ?? 0;
  if (!token || expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function getUniFiAccessConfig(): { baseUrl: string; apiToken: string } {
  return {
    baseUrl: (process.env.UNIFI_ACCESS_URL || process.env.DOOR_ACCESS_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    apiToken: process.env.UNIFI_ACCESS_TOKEN || process.env.DOOR_ACCESS_TOKEN || "",
  };
}

function normalizeAccessDoor(value: unknown): Record<string, string> {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id: getStringValue(record, "id") || getStringValue(record, "door_id") || getStringValue(record, "doorId"),
    name:
      getStringValue(record, "name") ||
      getStringValue(record, "display_name") ||
      getStringValue(record, "full_name") ||
      getStringValue(record, "alias") ||
      "Unnamed door",
    status: getStringValue(record, "status") || getStringValue(record, "door_status"),
    lockStatus: getStringValue(record, "lock_status") || getStringValue(record, "lockStatus"),
    rawType: getStringValue(record, "type") || getStringValue(record, "device_type"),
  };
}

function getAccessDoorArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record.data, record.doors, record.items, record.results];
  const arrayValue = candidates.find(Array.isArray);
  return Array.isArray(arrayValue) ? arrayValue : [];
}

async function savePlanSnapshotToDisk(snapshot: {
  profile?: {
    tenantId?: string;
    businessId?: string;
    siteId?: string;
    businessName?: string;
    siteName?: string;
  };
}): Promise<{ relativePath: string }> {
  const profile = snapshot.profile ?? {};
  const tenant = slugify(profile.tenantId || profile.businessId || profile.businessName || "tenant");
  const site = slugify(profile.siteId || profile.siteName || "site");
  const folder = path.join(process.cwd(), ".data", "plans", tenant, site);
  const filename = `plan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(folder, filename);

  await mkdir(folder, { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");

  return {
    relativePath: path.relative(process.cwd(), filePath),
  };
}

async function listSavedPlanSnapshots(): Promise<
  Array<{
    relativePath: string;
    savedAt: string;
    businessName: string;
    siteName: string;
    rackCount: number;
    deviceCount: number;
  }>
> {
  const baseFolder = getPlansFolder();
  const files = await listJsonFiles(baseFolder);
  const plans = await Promise.all(
    files.map(async (filePath) => {
      try {
        const snapshot = JSON.parse(await readFile(filePath, "utf8")) as {
          savedAt?: string;
          profile?: { businessName?: string; siteName?: string };
          inventory?: { racks?: unknown[]; devices?: unknown[] };
        };

        return {
          relativePath: path.relative(process.cwd(), filePath),
          savedAt: snapshot.savedAt ?? "",
          businessName: snapshot.profile?.businessName ?? "Unknown business",
          siteName: snapshot.profile?.siteName ?? "Unknown site",
          rackCount: snapshot.inventory?.racks?.length ?? 0,
          deviceCount: snapshot.inventory?.devices?.length ?? 0,
        };
      } catch {
        return null;
      }
    }),
  );

  return plans
    .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function loadSavedPlanSnapshot(relativePath: string): Promise<unknown> {
  const baseFolder = getPlansFolder();
  const requestedPath = path.resolve(process.cwd(), relativePath);

  if (!requestedPath.startsWith(`${baseFolder}${path.sep}`) || !requestedPath.endsWith(".json")) {
    throw new Error("Saved plan path is not allowed");
  }

  return JSON.parse(await readFile(requestedPath, "utf8"));
}

async function listJsonFiles(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(folder, entry.name);
        if (entry.isDirectory()) return listJsonFiles(entryPath);
        return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
      }),
    );

    return nested.flat();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

function getPlansFolder(): string {
  return path.resolve(process.cwd(), ".data", "plans");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";
}

async function testUniFiProfile(profile: {
  mode: "cloud" | "local";
  controllerUrl: string;
  siteId: string;
  apiToken: string;
}): Promise<{ ok: boolean; message: string }> {
  const baseUrl =
    profile.mode === "cloud"
      ? normalizeCloudApiUrl(profile.controllerUrl)
      : profile.controllerUrl.trim().replace(/\/+$/, "");
  const siteId = profile.siteId.trim() || "default";
  const paths =
    profile.mode === "local"
      ? [
          "/proxy/network/api/self/sites",
          `/proxy/network/api/s/${siteId}/stat/sysinfo`,
          "/api/self/sites",
          `/api/s/${siteId}/stat/sysinfo`,
        ]
      : ["/v1/hosts", "/v1/sites"];

  const failures: string[] = [];

  for (const path of paths) {
    const targetUrl = `${baseUrl}${path}`;
    const attempts =
      profile.mode === "cloud"
        ? [{ label: "site-manager-api-key", headers: { "X-API-Key": profile.apiToken } }]
        : [
            { label: "bearer", headers: { Authorization: `Bearer ${profile.apiToken}` } },
            { label: "x-api-key", headers: { "X-API-Key": profile.apiToken } },
            { label: "x-api-key-upper", headers: { "X-API-KEY": profile.apiToken } },
          ];

    for (const attempt of attempts) {
      const result = await requestUniFi(targetUrl, attempt.headers);

      if (result.ok) {
        return { ok: true, message: `Connected using ${path} with ${attempt.label}` };
      }

      failures.push(`${path} (${attempt.label}): ${result.message}`);
    }
  }

  return {
    ok: false,
    message: `Could not connect. Tried ${failures.join("; ")}`,
  };
}

async function syncCloudInventory(profile: {
  controllerUrl: string;
  apiToken: string;
  label?: string;
}): Promise<{
  ok: boolean;
  message: string;
  data?: {
    label: string;
    hosts: unknown[];
    sites: unknown[];
    devices: unknown[];
    networkSites: unknown[];
    networkDevices: unknown[];
    clients: unknown[];
    legacyDevices: unknown[];
    legacyClients: unknown[];
  };
}> {
  const baseUrl = normalizeCloudApiUrl(profile.controllerUrl);
  const headers = { "X-API-Key": profile.apiToken };
  const [hostsResult, sitesResult, devicesResult] = await Promise.all([
    requestUniFiJson(`${baseUrl}/v1/hosts`, headers),
    requestUniFiJson(`${baseUrl}/v1/sites`, headers),
    requestUniFiJson(`${baseUrl}/v1/devices`, headers),
  ]);

  const failures = [
    ["hosts", hostsResult],
    ["sites", sitesResult],
    ["devices", devicesResult],
  ].filter(([, result]) => !(result as { ok: boolean }).ok);

  if (failures.length) {
    return {
      ok: false,
      message: `Could not sync ${failures
        .map(([name, result]) => `${name}: ${(result as { message: string }).message}`)
        .join("; ")}`,
    };
  }

  const hosts = getResponseData(hostsResult.data);
  const sites = getResponseData(sitesResult.data);
  const devices = getResponseData(devicesResult.data);
  const enrichment = await syncConnectorInventory(baseUrl, headers, hosts, sites);
  const connectorNote = enrichment.networkDevices.length
    ? "connector detail active"
    : "connector detail unavailable; using Site Manager overview";
  const legacyNote = `${enrichment.legacyDevices.length} legacy devices, ${enrichment.legacyClients.length} legacy clients`;

  return {
    ok: true,
    message: `Synced ${hosts.length} hosts, ${sites.length} sites, ${devices.length} cloud devices, and ${enrichment.networkDevices.length} Network devices (${connectorNote}; ${legacyNote})`,
    data: {
      label: profile.label || "UniFi Cloud",
      hosts,
      sites,
      devices,
      networkSites: enrichment.networkSites,
      networkDevices: enrichment.networkDevices,
      clients: enrichment.clients,
      legacyDevices: enrichment.legacyDevices,
      legacyClients: enrichment.legacyClients,
    },
  };
}

async function syncConnectorInventory(
  baseUrl: string,
  headers: Record<string, string>,
  hosts: unknown[],
  siteManagerSites: unknown[],
): Promise<{
  networkSites: unknown[];
  networkDevices: unknown[];
  clients: unknown[];
  legacyDevices: unknown[];
  legacyClients: unknown[];
}> {
  const networkSites: unknown[] = [];
  const networkDevices: unknown[] = [];
  const clients: unknown[] = [];
  const legacyDevices: unknown[] = [];
  const legacyClients: unknown[] = [];
  const hostIds = uniqueStrings(
    hosts
      .map((host) => getHostIdentifier(host))
      .filter(Boolean),
  );

  for (const hostId of hostIds) {
    const sitesResult = await requestConnectorJson(baseUrl, hostId, "/v1/sites", headers);
    const hostSites = sitesResult.ok
      ? getResponseData(sitesResult.data).map((site) => annotateRecord(site, { hostId }))
      : siteManagerSites
          .filter((site) => getStringValue(site, "hostId") === hostId)
          .map((site) => annotateRecord(site, { hostId }));

    networkSites.push(...hostSites);

    for (const site of hostSites) {
      const siteId =
        getStringValue(site, "id") ||
        getStringValue(site, "siteId") ||
        getStringValue(site, "internalReference");
      if (!siteId) continue;

      const devicesResult = await requestConnectorJson(
        baseUrl,
        hostId,
        `/v1/sites/${encodeURIComponent(siteId)}/devices?limit=200`,
        headers,
      );
      const siteDevices = devicesResult.ok
        ? getResponseData(devicesResult.data).map((device) =>
            annotateRecord(device, { hostId, siteId }),
          )
        : [];

      const detailedDevices = await Promise.all(
        siteDevices.map(async (device) => {
          const deviceId = getStringValue(device, "id");
          if (!deviceId) return device;

          const detailResult = await requestConnectorJson(
            baseUrl,
            hostId,
            `/v1/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`,
            headers,
          );

          return detailResult.ok
            ? annotateRecord(detailResult.data, { hostId, siteId })
            : device;
        }),
      );
      networkDevices.push(...detailedDevices);

      const clientsResult = await requestConnectorJson(
        baseUrl,
        hostId,
        `/v1/sites/${encodeURIComponent(siteId)}/clients?limit=1000`,
        headers,
      );
      if (clientsResult.ok) {
        clients.push(
          ...getResponseData(clientsResult.data).map((client) =>
            annotateRecord(client, { hostId, siteId }),
          ),
        );
      }

      const siteKeys = uniqueStrings([
        getStringValue(site, "internalReference"),
        getStringValue(site, "name"),
        getStringValue(site, "siteId"),
        getStringValue(site, "id"),
        "default",
      ]);
      const legacyDevicesResult = await requestFirstLegacySitePath(
        baseUrl,
        hostId,
        siteKeys,
        "/stat/device",
        headers,
      );
      if (legacyDevicesResult.ok) {
        legacyDevices.push(
          ...getResponseData(legacyDevicesResult.data).map((device) =>
            annotateRecord(device, { hostId, siteId }),
          ),
        );
      }

      const legacyClientsResult = await requestFirstLegacySitePath(
        baseUrl,
        hostId,
        siteKeys,
        "/stat/sta",
        headers,
      );
      if (legacyClientsResult.ok) {
        legacyClients.push(
          ...getResponseData(legacyClientsResult.data).map((client) =>
            annotateRecord(client, { hostId, siteId }),
          ),
        );
      }
    }
  }

  return { networkSites, networkDevices, clients, legacyDevices, legacyClients };
}

function normalizeCloudApiUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "https://unifi.ui.com") return "https://api.ui.com";
  return trimmed;
}

function requestUniFi(
  targetUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === "http:" ? http : https;
    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        timeout: 10000,
        rejectUnauthorized: false,
        headers: {
          Accept: "application/json",
          ...authHeaders,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, message: `HTTP ${response.statusCode}` });
            return;
          }

          const redirectLocation = response.headers.location;
          const apiMessage = parseApiErrorMessage(body);
          const redirectMessage =
            response.statusCode && response.statusCode >= 300 && response.statusCode < 400
              ? `HTTP ${response.statusCode} redirect${redirectLocation ? ` to ${redirectLocation}` : ""}`
              : describeHttpError(response.statusCode, apiMessage);

          resolve({ ok: false, message: redirectMessage });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, message: error.message });
    });
    request.end();
  });
}

function requestUniFiJson(
  targetUrl: string,
  authHeaders: Record<string, string>,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  return new Promise((resolve) => {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === "http:" ? http : https;
    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        timeout: 15000,
        rejectUnauthorized: false,
        headers: {
          Accept: "application/json",
          ...authHeaders,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          const parsedBody = parseJsonBody(body);

          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, message: `HTTP ${response.statusCode}`, data: parsedBody });
            return;
          }

          resolve({
            ok: false,
            message: describeAccessHttpError(response.statusCode, parseApiErrorMessage(body)),
            data: parsedBody,
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, message: error.message });
    });
    request.end();
  });
}

function requestUniFiAccessJson(
  targetUrl: string,
  method: "GET" | "PUT",
  apiToken: string,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  return new Promise((resolve) => {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === "http:" ? http : https;
    const request = transport.request(
      parsedUrl,
      {
        method,
        timeout: 15000,
        rejectUnauthorized: false,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
          "X-API-Key": apiToken,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          const parsedBody = parseJsonBody(body);

          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ ok: true, message: `HTTP ${response.statusCode}`, data: parsedBody });
            return;
          }

          resolve({
            ok: false,
            message: describeHttpError(response.statusCode, parseApiErrorMessage(body)),
            data: parsedBody,
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, message: error.message });
    });
    request.end();
  });
}

async function requestConnectorJson(
  baseUrl: string,
  hostId: string,
  path: string,
  authHeaders: Record<string, string>,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const encodedHostId = encodeURIComponent(hostId);
  const candidates = path.startsWith("/api/")
    ? [
        `${baseUrl}/v1/connector/consoles/${encodedHostId}/network${path}`,
        `${baseUrl}/v1/connector/consoles/${encodedHostId}/proxy/network${path}`,
      ]
    : [
        `${baseUrl}/v1/connector/consoles/${encodedHostId}/network/integration${path}`,
        `${baseUrl}/v1/connector/consoles/${encodedHostId}/proxy/network/integration${path}`,
      ];

  let lastResult: { ok: boolean; message: string; data?: unknown } = {
    ok: false,
    message: "No connector request attempted",
  };

  for (const targetUrl of candidates) {
    lastResult = await requestUniFiJson(targetUrl, authHeaders);
    if (lastResult.ok) return lastResult;
  }

  return lastResult;
}

async function requestFirstLegacySitePath(
  baseUrl: string,
  hostId: string,
  siteKeys: string[],
  suffix: string,
  authHeaders: Record<string, string>,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  let lastResult: { ok: boolean; message: string; data?: unknown } = {
    ok: false,
    message: "No legacy site request attempted",
  };

  for (const siteKey of siteKeys) {
    lastResult = await requestConnectorJson(
      baseUrl,
      hostId,
      `/api/s/${encodeURIComponent(siteKey)}${suffix}`,
      authHeaders,
    );
    if (lastResult.ok) return lastResult;
  }

  return lastResult;
}

function parseJsonBody(body: string): unknown {
  if (!body.trim()) return null;

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function getResponseData(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }

  return [];
}

function getHostIdentifier(host: unknown): string {
  return (
    getStringValue(host, "id") ||
    getStringValue(host, "hostId") ||
    getStringValue(host, "host_id") ||
    getStringValue(host, "consoleId") ||
    getStringValue(host, "console_id") ||
    getStringValue(host, "ucoreId") ||
    getStringValue(host, "ucore_id")
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function annotateRecord(value: unknown, fields: Record<string, string>): Record<string, unknown> {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { ...record, ...fields };
}

function getStringValue(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const recordValue = (value as Record<string, unknown>)[key];
  if (typeof recordValue === "string") return recordValue;
  if (typeof recordValue === "number") return String(recordValue);
  return "";
}

function parseApiErrorMessage(body: string): string | null {
  if (!body.trim()) return null;

  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      detail?: unknown;
      description?: unknown;
      error?: unknown;
      message?: unknown;
      msg?: unknown;
    };
    const code = typeof parsed.code === "string" || typeof parsed.code === "number" ? String(parsed.code) : null;
    const message = [parsed.message, parsed.msg, parsed.error, parsed.detail, parsed.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return [code, message].filter(Boolean).join(": ") || null;
  } catch {
    return null;
  }
}

function describeAccessHttpError(statusCode: number | undefined, apiMessage: string | null): string {
  if (statusCode === 401) {
    return `HTTP 401 unauthorized${apiMessage ? ` - ${apiMessage}` : ""}. Check UNIFI_ACCESS_TOKEN from the UniFi Access developer/OpenAPI settings.`;
  }

  if (statusCode === 403) {
    return `HTTP 403 forbidden${apiMessage ? ` - ${apiMessage}` : ""}. The Access token may not have permission to read or unlock doors.`;
  }

  if (statusCode === 404) {
    return `HTTP 404 not found${apiMessage ? ` - ${apiMessage}` : ""}. Check UNIFI_ACCESS_URL and the Access OpenAPI port.`;
  }

  return `HTTP ${statusCode ?? "unknown"}${apiMessage ? ` - ${apiMessage}` : ""}`;
}

function describeHttpError(statusCode: number | undefined, apiMessage: string | null): string {
  if (statusCode === 401) {
    return `HTTP 401 unauthorized${apiMessage ? ` - ${apiMessage}` : ""}. Check that this is a Site Manager API key from https://unifi.ui.com/settings/api-keys.`;
  }

  if (statusCode === 403) {
    return `HTTP 403 forbidden${apiMessage ? ` - ${apiMessage}` : ""}. The key is valid but may not have access to this console or organization.`;
  }

  return `HTTP ${statusCode ?? "unknown"}${apiMessage ? ` - ${apiMessage}` : ""}`;
}
