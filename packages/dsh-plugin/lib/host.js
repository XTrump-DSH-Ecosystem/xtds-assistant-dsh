import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const name = "xtds-assistant-dsh-host";
export const inject = ["webServer"];

const DEFAULT_HOME = "E:\\workspace\\xtds-assistant-dsh";
const ROUTES = [
  "/xtds/api/status",
  "/xtds/api/autostart",
  "/xtds/api/processes/ds-memory/start",
  "/xtds/api/processes/ds-memory/stop",
  "/xtds/api/processes/ds-memory/restart",
  "/xtds/api/processes/qq-gateway/start",
  "/xtds/api/processes/qq-gateway/stop",
  "/xtds/api/processes/qq-gateway/restart",
  "/xtds/api/processes/open-websearch/start",
  "/xtds/api/processes/open-websearch/stop",
  "/xtds/api/processes/open-websearch/restart",
  "/xtds/api/processes/code-bridge/start",
  "/xtds/api/processes/code-bridge/stop",
  "/xtds/api/processes/code-bridge/restart"
];

let ensureInFlight = null;

function log(message) {
  try {
    console.error(`[xtds-assistant-dsh] ${message}`);
  } catch {
    // Logging must never break the host plugin.
  }
}

function expandEnv(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let expanded = value;
  expanded = expanded.replace(/%([^%]+)%/g, (match, key) => process.env[key] ?? match);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (match, key) => process.env[key] ?? match);
  if (expanded === "~") expanded = process.env.USERPROFILE ?? process.env.HOME ?? expanded;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = resolve(process.env.USERPROFILE ?? process.env.HOME ?? "~", expanded.slice(2));
  }
  return expanded;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonResult(filePath) {
  try {
    const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    if (error?.name === "SyntaxError") return { ok: false, reason: "invalid" };
    return { ok: false, reason: "unreadable" };
  }
}

function snowlumaFailure(reason, checkedAt) {
  return { available: false, checkedAt, reason };
}

function parseSnowlumaHost(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253 || /\s/.test(trimmed) || trimmed.includes("\0")) {
    return null;
  }

  let host = trimmed;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0) return null;

  const family = isIP(host);
  if (family === 6) {
    return { host, loopback: host.toLowerCase() === "::1" };
  }
  if (family === 4) {
    return { host, loopback: host.startsWith("127.") };
  }

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split(".");
  if (labels.some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    return null;
  }
  return { host, loopback: name.toLowerCase() === "localhost" };
}

function formatUrlHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function readSnowlumaStatus(configPath) {
  const checkedAt = new Date().toISOString();
  try {
    const config = readJsonResult(configPath);
    if (!config.ok) {
      const reason = config.reason === "missing"
        ? "config_missing"
        : config.reason === "invalid"
          ? "config_invalid"
          : "config_unreadable";
      return snowlumaFailure(reason, checkedAt);
    }
    if (!isPlainObject(config.value)) {
      return snowlumaFailure("config_invalid", checkedAt);
    }
    if (typeof config.value.home !== "string"
      || config.value.home.length === 0
      || config.value.home.includes("\0")
      || !isAbsolute(config.value.home)) {
      return snowlumaFailure("home_invalid", checkedAt);
    }

    const runtime = readJsonResult(join(config.value.home, "config", "runtime.json"));
    if (!runtime.ok) {
      const reason = runtime.reason === "missing"
        ? "runtime_missing"
        : runtime.reason === "invalid"
          ? "runtime_invalid"
          : "runtime_unreadable";
      return snowlumaFailure(reason, checkedAt);
    }
    if (!isPlainObject(runtime.value)) {
      return snowlumaFailure("runtime_invalid", checkedAt);
    }

    const parsedHost = parseSnowlumaHost(runtime.value.webuiHost);
    if (parsedHost === null) return snowlumaFailure("host_invalid", checkedAt);

    const webUiPort = runtime.value.webuiPort;
    if (!Number.isInteger(webUiPort) || webUiPort < 1 || webUiPort > 65535) {
      return snowlumaFailure("port_invalid", checkedAt);
    }

    const tls = runtime.value.webuiTls?.enabled;
    if (typeof tls !== "boolean") return snowlumaFailure("runtime_invalid", checkedAt);

    if (!parsedHost.loopback) {
      return {
        available: true,
        webUiHost: parsedHost.host,
        webUiPort,
        tls,
        checkedAt,
        reason: "non_loopback_host"
      };
    }
    const protocol = tls ? "https" : "http";
    return {
      available: true,
      webUiHost: parsedHost.host,
      webUiPort,
      webUiUrl: `${protocol}://${formatUrlHost(parsedHost.host)}:${webUiPort}/`,
      tls,
      checkedAt
    };
  } catch {
    return snowlumaFailure("internal_error", checkedAt);
  }
}

function enrichStatusBody(body, snowlumaConfigPath) {
  try {
    const status = JSON.parse(body.toString("utf8"));
    if (!isPlainObject(status)) return body;
    status.snowluma = readSnowlumaStatus(snowlumaConfigPath);
    return Buffer.from(JSON.stringify(status));
  } catch {
    return body;
  }
}

function supervisorPaths() {
  const home = resolve(expandEnv(process.env.XTDS_ASSISTANT_HOME) || DEFAULT_HOME);
  const configPath = process.env.XTDS_SUPERVISOR_CONFIG
    ? resolve(expandEnv(process.env.XTDS_SUPERVISOR_CONFIG))
    : join(home, "config", "supervisor.json");
  const config = readJson(configPath) ?? {};
  const runtimeSetting = typeof config.runtimeDir === "string" && config.runtimeDir.length > 0
    ? expandEnv(config.runtimeDir)
    : "runtime";
  const runtimeDir = isAbsolute(runtimeSetting)
    ? resolve(runtimeSetting)
    : resolve(dirname(configPath), runtimeSetting);
  return {
    home,
    configPath,
    config,
    runtimeDir,
    endpointPath: join(runtimeDir, "supervisor.endpoint.json"),
    tokenPath: join(runtimeDir, "config.json"),
    cliPath: join(home, "packages", "supervisor", "bin", "supervisor.js"),
    snowlumaConfigPath: join(home, "config", "snowluma.json")
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function liveEndpoint(paths) {
  const endpoint = readJson(paths.endpointPath);
  if (endpoint === null || endpoint.name !== "xtds-assistant-supervisor") return null;
  if (!Number.isInteger(endpoint.port) || endpoint.port <= 0) return null;
  if (!isPidAlive(endpoint.pid)) return null;
  return endpoint;
}

function resolveNodePath(paths) {
  const configured = typeof paths.config.nodePath === "string"
    ? expandEnv(paths.config.nodePath)
    : null;
  if (configured && existsSync(configured)) return configured;
  if (process.env.XTDS_NODE && existsSync(process.env.XTDS_NODE)) return process.env.XTDS_NODE;
  return process.execPath;
}

async function ensureSupervisor() {
  const paths = supervisorPaths();
  const existing = liveEndpoint(paths);
  if (existing !== null) return { ...paths, endpoint: existing };
  if (ensureInFlight !== null) return ensureInFlight;

  ensureInFlight = (async () => {
    if (!existsSync(paths.cliPath) || !existsSync(paths.configPath)) {
      log(`supervisor files not found under ${paths.home}`);
      return null;
    }
    try {
      const child = spawn(resolveNodePath(paths), [paths.cliPath, "--config", paths.configPath], {
        cwd: paths.home,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.on("error", (error) => log(`cannot launch supervisor: ${error.message}`));
      child.unref();
    } catch (error) {
      log(`cannot launch supervisor: ${error.message}`);
      return null;
    }
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const endpoint = liveEndpoint(paths);
      if (endpoint !== null) return { ...paths, endpoint };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    }
    log("supervisor did not publish an endpoint in time");
    return null;
  })().finally(() => {
    ensureInFlight = null;
  });

  return ensureInFlight;
}

function readControlToken(paths) {
  const config = readJson(paths.tokenPath);
  return config !== null && typeof config.controlToken === "string" && config.controlToken.length >= 32
    ? config.controlToken
    : null;
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "::ffff:7f00:1";
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]";
}

function originFence(req) {
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopbackAddress(remote)) return false;
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  let requestHost;
  try {
    requestHost = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(requestHost.hostname)) return false;

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== hostHeader) return false;
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0 && site !== "same-origin" && site !== "none") {
    return false;
  }
  return true;
}

function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forward(endpoint, token, req, body, targetPath) {
  return new Promise((resolveForward, rejectForward) => {
    const proxyReq = httpRequest({
      hostname: "127.0.0.1",
      port: endpoint.port,
      path: targetPath,
      method: req.method,
      headers: {
        "x-xtds-token": token,
        accept: "application/json",
        ...(body.length > 0 ? {
          "content-type": "application/json",
          "content-length": String(body.length)
        } : {})
      },
      timeout: 35000
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        resolveForward({
          status: proxyRes.statusCode ?? 502,
          contentType: proxyRes.headers["content-type"] ?? "application/json; charset=utf-8",
          body: Buffer.concat(chunks)
        });
      });
    });
    proxyReq.on("timeout", () => proxyReq.destroy(new Error("supervisor request timed out")));
    proxyReq.on("error", rejectForward);
    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

async function handleRequest(req, res) {
  if (!originFence(req)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    sendJson(res, 413, { ok: false, error: error.message });
    return;
  }
  const ensured = await ensureSupervisor();
  if (ensured === null) {
    sendJson(res, 503, { ok: false, error: "supervisor is not available" });
    return;
  }
  const token = readControlToken(ensured);
  if (token === null) {
    sendJson(res, 503, { ok: false, error: "supervisor control token is not available" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const targetPath = `${url.pathname.slice("/xtds".length)}${url.search}`;
  try {
    const response = await forward(ensured.endpoint, token, req, body, targetPath);
    const responseBody = url.pathname === "/xtds/api/status" && response.status === 200
      ? enrichStatusBody(response.body, ensured.snowlumaConfigPath)
      : response.body;
    res.writeHead(response.status, {
      "content-type": response.contentType,
      "content-length": responseBody.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    res.end(responseBody);
  } catch (error) {
    log(`proxy failed: ${error.message}`);
    sendJson(res, 502, { ok: false, error: "supervisor proxy failed" });
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = ROUTES.map((path) => ctx.webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => {
        handleRequest(req, res).catch((error) => {
          log(`request failed: ${error.message}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
          else res.destroy();
        });
      }
    }));
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") dispose();
      }
    };
  }, "xtds-assistant-dsh: /xtds/api routes");

  if (process.env.XTDS_PLUGIN_NO_BOOTSTRAP !== "1") {
    const timer = setTimeout(() => {
      ensureSupervisor().catch((error) => log(`bootstrap failed: ${error.message}`));
    }, 1200);
    timer.unref?.();
    ctx.effect(() => () => clearTimeout(timer), "xtds-assistant-dsh: supervisor bootstrap");
  }
}
