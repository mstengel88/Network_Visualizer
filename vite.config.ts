import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";
import https from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
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
      },
    },
  ],
});

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
    const parsed = JSON.parse(body) as { message?: unknown; code?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : null;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    return [code, message].filter(Boolean).join(": ") || null;
  } catch {
    return null;
  }
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
