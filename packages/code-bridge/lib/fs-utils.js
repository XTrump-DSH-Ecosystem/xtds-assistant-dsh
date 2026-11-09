import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(filePath, content, mode = 0o600) {
  ensureDir(dirname(filePath));
  const tempPath = join(dirname(filePath), `.${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, content, { mode });
    try {
      renameSync(tempPath, filePath);
    } catch {
      rmSync(filePath, { force: true });
      renameSync(tempPath, filePath);
    }
    try {
      chmodSync(filePath, mode);
    } catch {
      // Windows ACLs do not map to POSIX mode bits.
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeFileAtomic(filePath, `${JSON.stringify(value)}\n`, mode);
}

export function writeExclusive(filePath, content) {
  ensureDir(dirname(filePath));
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function removeFile(filePath) {
  rmSync(filePath, { force: true });
}

export function fileExists(filePath) {
  return existsSync(filePath);
}
