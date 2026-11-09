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
  const tempPath = join(dirname(filePath), `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
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
      // Windows ACLs are not represented by POSIX mode bits.
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeFileAtomic(filePath, `${JSON.stringify(value)}\n`, mode);
}

export function removeFile(filePath) {
  rmSync(filePath, { force: true });
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

export function fileExists(filePath) {
  return existsSync(filePath);
}

export function parseEnvFile(text) {
  const env = {};
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`env file not found: ${filePath}`);
  }
  return parseEnvFile(readFileSync(filePath, "utf8"));
}
