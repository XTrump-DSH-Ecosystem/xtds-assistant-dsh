import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isLoopbackAddress } from "./endpoint.js";
import { ApiError } from "./errors.js";

const MAX_BODY_BYTES = 64 * 1024;

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function requestToken(req) {
  const direct = req.headers["x-xtds-token"];
  if (typeof direct === "string") return direct;
  return readBearer(req);
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

async function readJsonBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, "request body too large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "JSON body must be an object");
  }
  return parsed;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function listenWithFallback(server, preferredPort, host) {
  try {
    await listenOnce(server, preferredPort, host);
    return { port: server.address().port, fellBack: false };
  } catch (error) {
    if (preferredPort === 0 || error.code !== "EADDRINUSE") throw error;
    await listenOnce(server, 0, host);
    return { port: server.address().port, fellBack: true };
  }
}

export function createApiServer({ config, manager, autostart, controlToken, onShutdown, version }) {
  const startedAt = Date.now();
  const server = createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress ?? "";
      if (!isLoopbackAddress(remote)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${config.host}`);
      if (!url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      if (!tokenMatches(requestToken(req), controlToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          supervisor: {
            pid: process.pid,
            port: server.address().port,
            startedAt,
            uptimeMs: Date.now() - startedAt,
            version
          },
          autostart: await autostart.status(),
          processes: await manager.status()
        });
        return;
      }

      if (url.pathname === "/api/autostart" && req.method === "GET") {
        sendJson(res, 200, { ok: true, autostart: await autostart.status() });
        return;
      }

      if (url.pathname === "/api/autostart" && req.method === "PUT") {
        const body = await readJsonBody(req);
        if (typeof body.enabled !== "boolean") {
          throw new ApiError(400, "enabled must be a boolean");
        }
        if (!autostart.supported) {
          throw new ApiError(501, "autostart is implemented on Windows only");
        }
        const result = body.enabled ? await autostart.enable() : await autostart.disable();
        sendJson(res, 200, { ok: true, autostart: result });
        return;
      }

      const processMatch = /^\/api\/processes\/([a-z0-9-]+)\/(start|stop|restart)$/.exec(url.pathname);
      if (processMatch !== null && req.method === "POST") {
        const [, id, action] = processMatch;
        const result = action === "start"
          ? await manager.start(id)
          : action === "stop"
            ? await manager.stop(id)
            : await manager.restart(id);
        sendJson(res, 200, { ok: true, process: result });
        return;
      }

      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        sendJson(res, 202, { ok: true, message: "shutdown scheduled" });
        if (typeof onShutdown === "function") setTimeout(() => onShutdown("api"), 50);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  return {
    server,
    listen: () => listenWithFallback(server, config.port, config.host),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
