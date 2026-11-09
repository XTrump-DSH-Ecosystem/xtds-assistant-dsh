import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AlreadyRunningError, LauncherError } from "./errors.js";
import { ensureDir, fileExists, readJson, removeFile } from "./fs-utils.js";
import { isPidAlive } from "./process.js";

export const LOCK_NAME = "open-websearch-launcher";
export const LOCK_FILE_NAME = "open-websearch.lock";

const SENSITIVE_KEY = /(token|secret|password|authorization|api[-_]?key|credential)/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLock(value) {
  if (!isPlainObject(value)) return false;
  if (value.v !== 1) return false;
  if (value.name !== LOCK_NAME) return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
  if (typeof value.instanceId !== "string" || value.instanceId.length === 0 || value.instanceId.length > 128) {
    return false;
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) return false;
  }
  return true;
}

export function readLock(lockPath) {
  if (!fileExists(lockPath)) return { state: "none" };
  const parsed = readJson(lockPath, undefined);
  if (parsed === undefined || !isPlainObject(parsed)) return { state: "invalid" };
  const pid = parsed.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { state: "invalid" };
  if (!isPidAlive(pid)) return { state: "stale", lock: parsed };
  if (!isLock(parsed)) return { state: "mismatch", lock: parsed };
  return { state: "live", lock: parsed };
}

export function acquireLock(
  lockPath,
  { instanceId, createdAt = new Date().toISOString(), pid = process.pid } = {}
) {
  ensureDir(dirname(lockPath));
  const metadata = {
    v: 1,
    name: LOCK_NAME,
    pid,
    instanceId,
    createdAt
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(metadata)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
        fd = undefined;
      }
      return metadata;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failures while unwinding.
        }
      }
      if (error.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing.state === "none") continue;
      if (existing.state === "live" || existing.state === "mismatch") {
        const holderPid = existing.lock && Number.isInteger(existing.lock.pid)
          ? existing.lock.pid
          : pid;
        throw new AlreadyRunningError(
          `open-websearch launcher is already running (pid ${holderPid})`,
          { pid: holderPid }
        );
      }
      removeFile(lockPath);
    }
  }
  throw new LauncherError("lock_contention", "could not acquire open-websearch launcher lock");
}

export function releaseLock(lockPath, { pid = process.pid, instanceId } = {}) {
  if (typeof instanceId !== "string" || instanceId.length === 0) return false;
  const existing = readLock(lockPath);
  if (existing.state !== "live") return false;
  if (existing.lock.pid !== pid || existing.lock.instanceId !== instanceId) return false;
  removeFile(lockPath);
  return true;
}
