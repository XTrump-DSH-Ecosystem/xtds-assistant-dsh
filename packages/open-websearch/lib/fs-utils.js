import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function fileExists(filePath) {
  return existsSync(filePath);
}

export function readFileText(filePath) {
  return readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileText(filePath));
  } catch {
    return fallback;
  }
}

export function removeFile(filePath) {
  rmSync(filePath, { force: true });
}

function renameIntoPlace(tempPath, filePath) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      lastError = error;
      if (attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }
  removeFile(filePath);
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    throw lastError ?? error;
  }
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  const directory = dirname(filePath);
  ensureDir(directory);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = openSync(tempPath, "wx", mode);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameIntoPlace(tempPath, filePath);
    try {
      chmodSync(filePath, mode);
    } catch {
      // Windows ACLs do not map to POSIX mode bits.
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures while unwinding.
      }
    }
    removeFile(tempPath);
  }
}
