import { createServer } from "node:http";
import {
  HOST,
  NAME,
  DEFAULT_SESSION_LIMIT,
  MAX_BODY_BYTES,
  MAX_SESSION_LIMIT,
  VERSION
} from "./constants.js";
import { ApiError } from "./errors.js";
import { constantTimeTokenMatch, isLoopbackAddress } from "./runtime.js";

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

function requestToken(req) {
  const direct = req.headers["x-code-bridge-token"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

async function readJsonBody(req) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "request_too_large");
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, "request_too_large");
    chunks.push(chunk);
  }
  if (total === 0) throw new ApiError(400, "invalid_request");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_request");
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
    if (preferredPort === 0 || (error.code !== "EADDRINUSE" && error.code !== "EACCES")) {
      throw error;
    }
    await listenOnce(server, 0, host);
    return { port: server.address().port, fellBack: true };
  }
}

export function createApiServer({ manager, token, startedAt, port }) {
  const server = createServer(async (req, res) => {
    try {
      const remote = req.socket.remoteAddress ?? "";
      if (!isLoopbackAddress(remote)) {
        sendJson(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/health" && req.method === "GET") {
        const counts = manager.counts();
        sendJson(res, 200, {
          ok: true,
          name: NAME,
          version: VERSION,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          running: counts.running,
          queued: counts.queued
        });
        return;
      }

      if (!constantTimeTokenMatch(requestToken(req), token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (url.pathname === "/v1/sessions" && req.method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        let limit = DEFAULT_SESSION_LIMIT;
        if (rawLimit !== null) {
          if (!/^[0-9]+$/.test(rawLimit)) throw new ApiError(400, "invalid_request");
          limit = Number(rawLimit);
          if (limit < 1 || limit > MAX_SESSION_LIMIT) throw new ApiError(400, "invalid_request");
        }
        const sessions = manager.listSessions({
          q: url.searchParams.get("q") ?? undefined,
          limit
        });
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (url.pathname === "/v1/tasks" && req.method === "POST") {
        const body = await readJsonBody(req);
        const result = manager.submit(body);
        sendJson(res, result.statusCode, {
          ok: true,
          duplicate: result.duplicate,
          task: result.task
        });
        return;
      }

      const taskMatch = /^\/v1\/tasks\/(ct-[0-9a-f-]+)$/.exec(url.pathname);
      if (taskMatch !== null && req.method === "GET") {
        const task = manager.get(taskMatch[1]);
        if (task === null) {
          sendJson(res, 404, { ok: false, error: "not_found" });
          return;
        }
        sendJson(res, 200, { ok: true, task });
        return;
      }

      const cancelMatch = /^\/v1\/tasks\/(ct-[0-9a-f-]+)\/cancel$/.exec(url.pathname);
      if (cancelMatch !== null && req.method === "POST") {
        const task = manager.cancel(cancelMatch[1]);
        if (task === null) {
          sendJson(res, 404, { ok: false, error: "not_found" });
          return;
        }
        sendJson(res, 200, { ok: true, task });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { ok: false, error: error.code });
        return;
      }
      sendJson(res, 500, { ok: false, error: "internal_error" });
    }
  });
  return {
    server,
    listen: () => listenWithFallback(server, port, HOST),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}
