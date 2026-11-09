import { fileExists, readJson, removeFile, writeJsonAtomic } from "./fs-utils.js";
import { isPidAlive } from "./process.js";

export const EXPECTED_VERSION = "2.2.0";
export const ENDPOINT_NAME = "open-websearch";
export const ENDPOINT_HOST = "127.0.0.1";
export const ENDPOINT_FILE_NAME = "open-websearch.endpoint.json";

const SENSITIVE_KEY = /(token|secret|password|authorization|api[-_]?key|credential)/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function endpointBaseUrl(port) {
  return `http://${ENDPOINT_HOST}:${port}`;
}

export function isEndpoint(value) {
  if (!isPlainObject(value)) return false;
  if (value.v !== 1) return false;
  if (value.name !== ENDPOINT_NAME) return false;
  if (value.host !== ENDPOINT_HOST) return false;
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
  if (typeof value.instanceId !== "string" || value.instanceId.length === 0 || value.instanceId.length > 128) {
    return false;
  }
  if (
    typeof value.startedAt !== "string"
    || value.startedAt.length === 0
    || value.startedAt.length > 64
    || Number.isNaN(Date.parse(value.startedAt))
  ) {
    return false;
  }
  if (value.version !== EXPECTED_VERSION) return false;
  if (value.baseUrl !== endpointBaseUrl(value.port)) return false;
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) return false;
  }
  return true;
}

export function createEndpoint({ port, pid, instanceId, startedAt }) {
  return {
    v: 1,
    name: ENDPOINT_NAME,
    host: ENDPOINT_HOST,
    port,
    pid,
    instanceId,
    startedAt,
    version: EXPECTED_VERSION,
    baseUrl: endpointBaseUrl(port)
  };
}

export function readEndpoint(filePath) {
  const parsed = readJson(filePath, null);
  return isEndpoint(parsed) ? parsed : null;
}

export function inspectEndpoint(filePath) {
  if (!fileExists(filePath)) return { state: "none" };
  const parsed = readJson(filePath, undefined);
  if (parsed === undefined || !isPlainObject(parsed)) return { state: "invalid" };
  const pid = parsed.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { state: "invalid" };
  if (!isPidAlive(pid)) return { state: "stale", endpoint: parsed };
  if (!isEndpoint(parsed)) return { state: "mismatch", endpoint: parsed };
  return { state: "live", endpoint: parsed };
}

export function writeEndpointAtomic(filePath, endpoint) {
  if (!isEndpoint(endpoint)) {
    throw new Error("refusing to write invalid open-websearch endpoint");
  }
  writeJsonAtomic(filePath, endpoint, 0o600);
}

export function removeEndpoint(filePath) {
  removeFile(filePath);
}

export function removeEndpointIfOwned(filePath, { pid, instanceId } = {}) {
  const endpoint = readEndpoint(filePath);
  if (endpoint === null) return false;
  if (pid !== undefined && endpoint.pid !== pid) return false;
  if (instanceId !== undefined && endpoint.instanceId !== instanceId) return false;
  removeFile(filePath);
  return true;
}
