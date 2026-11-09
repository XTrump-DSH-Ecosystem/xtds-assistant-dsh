import { readFileSync } from "node:fs";
import { removeFile, writeJsonAtomic } from "./fs-utils.js";

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function readEndpoint(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.name !== "string") return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) return null;
  if (typeof parsed.host !== "string") return null;
  return parsed;
}

export function writeEndpoint(filePath, endpoint) {
  writeJsonAtomic(filePath, endpoint);
}

export function removeEndpointIfOwned(filePath, { pid, instanceId } = {}) {
  const endpoint = readEndpoint(filePath);
  if (endpoint === null) return false;
  if (pid !== undefined && endpoint.pid !== pid) return false;
  if (instanceId !== undefined && endpoint.instanceId !== instanceId) return false;
  removeFile(filePath);
  return true;
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "::ffff:7f00:1";
}

export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

async function readBoundedBody(response, maxBytes) {
  if (response.body === null) return { text: "", tooLarge: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { text: "", tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

function parseHealthBody(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { online: null, bodyState: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { online: null, bodyState: "invalid" };
  }
  if (typeof parsed.online !== "boolean") {
    return { online: null, bodyState: "missing" };
  }
  return { online: parsed.online, bodyState: "ok" };
}

export async function probeHealth(url, timeoutMs, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HEALTH_BODY_BYTES;
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, status: response.status, online: null, bodyState: "skipped" };
    }
    const body = await readBoundedBody(response, maxBodyBytes);
    if (body.tooLarge) {
      return { ok: true, status: response.status, online: null, bodyState: "too_large" };
    }
    return { ok: true, status: response.status, ...parseHealthBody(body.text) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      online: null,
      bodyState: "error",
      error: error.name === "TimeoutError" ? "timeout" : error.message
    };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
