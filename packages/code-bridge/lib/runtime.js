import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAME, HOST } from "./constants.js";
import {
  readJson,
  removeFile,
  writeExclusive,
  writeFileAtomic,
  writeJsonAtomic
} from "./fs-utils.js";

export const TOKEN_FILE_NAME = "code-bridge.token";
export const ENDPOINT_FILE_NAME = "code-bridge.endpoint.json";
export const STATE_FILE_NAME = "code-bridge.state.json";
export const LOCK_FILE_NAME = "code-bridge.lock";

export function tokenFilePath(runtimeDir) {
  return join(runtimeDir, TOKEN_FILE_NAME);
}

export function endpointFilePath(runtimeDir) {
  return join(runtimeDir, ENDPOINT_FILE_NAME);
}

export function stateFilePath(runtimeDir) {
  return join(runtimeDir, STATE_FILE_NAME);
}

export function lockFilePath(runtimeDir) {
  return join(runtimeDir, LOCK_FILE_NAME);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function ensureToken(filePath) {
  if (existsSync(filePath)) {
    try {
      const existing = readFileSync(filePath, "utf8").trim();
      if (/^[0-9a-f]{32,}$/.test(existing)) return existing;
    } catch {
      // Regenerate below when the existing token cannot be read or validated.
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileAtomic(filePath, `${token}\n`, 0o600);
  return token;
}

export function readEndpoint(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== 1 || parsed.name !== NAME) return null;
  if (parsed.host !== HOST) return null;
  if (!Number.isInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (!Number.isInteger(parsed.startedAt) || parsed.startedAt <= 0) return null;
  if (typeof parsed.instanceId !== "string" || parsed.instanceId.length === 0) return null;
  return parsed;
}

export function writeEndpoint(filePath, { port, pid, startedAt, instanceId }) {
  writeJsonAtomic(filePath, {
    v: 1,
    name: NAME,
    host: HOST,
    port,
    pid,
    startedAt,
    instanceId
  });
}

export function removeEndpointIfOwned(filePath, { pid, instanceId } = {}) {
  const endpoint = readEndpoint(filePath);
  if (endpoint === null) return false;
  if (pid !== undefined && endpoint.pid !== pid) return false;
  if (instanceId !== undefined && endpoint.instanceId !== instanceId) return false;
  removeFile(filePath);
  return true;
}

export function assertNoLiveEndpoint(filePath) {
  const endpoint = readEndpoint(filePath);
  if (endpoint !== null && isPidAlive(endpoint.pid)) return endpoint;
  return null;
}

export function acquireInstanceLock(filePath, { pid, instanceId, startedAt }) {
  const payload = `${JSON.stringify({ pid, instanceId, startedAt })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusive(filePath, payload);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readJson(filePath, null);
      if (existing !== null && isPidAlive(existing.pid)) {
        const conflict = new Error(`code-bridge is already starting or running (pid ${existing.pid})`);
        conflict.code = "EALREADYLOCKED";
        throw conflict;
      }
      removeFile(filePath);
    }
  }
  const error = new Error("cannot acquire code-bridge instance lock");
  error.code = "EALREADYLOCKED";
  throw error;
}

export function releaseInstanceLock(filePath, instanceId) {
  const existing = readJson(filePath, null);
  if (existing !== null && existing.instanceId === instanceId) {
    removeFile(filePath);
    return true;
  }
  return false;
}

export function constantTimeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address === "::ffff:7f00:1";
}
