import { randomBytes } from "node:crypto";
import * as defaultFileSystem from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const ARCHIVE_ATTEMPTS = 8;
const MAX_SEQUENCE = 999999999999;

function defaultRandomHex() {
  return randomBytes(4).toString("hex");
}

function reportError(onError, error) {
  if (typeof onError !== "function") return;
  try {
    onError(error);
  } catch {}
}

function archiveDetails(filePath, name) {
  const prefix = `${basename(filePath)}.`;
  const suffix = ".archive";
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const middle = name.slice(prefix.length, -suffix.length);
  const match = /^(\d{12})-(\d{13})-(\d+)-([0-9a-f]{8})$/.exec(middle);
  if (match === null) return null;
  return {
    name,
    sequence: Number(match[1]),
    timestamp: Number(match[2])
  };
}

function compareArchives(left, right) {
  return left.sequence - right.sequence
    || left.timestamp - right.timestamp
    || left.name.localeCompare(right.name);
}

function normalizeOptions({
  fileSystem = defaultFileSystem,
  now = Date.now,
  pid = process.pid,
  randomHex = defaultRandomHex
} = {}) {
  return {
    fileSystem,
    now: typeof now === "function" ? now : Date.now,
    pid,
    randomHex: typeof randomHex === "function" ? randomHex : defaultRandomHex
  };
}

function formatArchivePath(filePath, sequence, options) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    const error = new RangeError("archive sequence is outside the 12-digit range");
    error.code = "ERANGE";
    throw error;
  }
  const timestamp = String(Math.max(0, Math.trunc(options.now()))).padStart(13, "0").slice(-13);
  const random = String(options.randomHex()).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(random)) throw new Error("randomHex must return 8 hexadecimal characters");
  return `${filePath}.${String(sequence).padStart(12, "0")}-${timestamp}-${options.pid}-${random}.archive`;
}

function listRegularArchives(filePath, fileSystem, onError) {
  let names;
  try {
    names = fileSystem.readdirSync(dirname(filePath));
  } catch (error) {
    reportError(onError, error);
    return null;
  }
  const archives = [];
  for (const name of names) {
    const details = archiveDetails(filePath, name);
    if (details === null) continue;
    const archivePath = join(dirname(filePath), name);
    try {
      const stats = fileSystem.lstatSync(archivePath);
      if (!stats.isFile()) continue;
      archives.push({ ...details, path: archivePath });
    } catch (error) {
      if (error?.code !== "ENOENT") reportError(onError, error);
    }
  }
  archives.sort(compareArchives);
  return archives;
}

function allocateArchivePath(filePath, startingSequence, options, onError) {
  let sequence = startingSequence;
  for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS; attempt += 1) {
    let target;
    try {
      target = formatArchivePath(filePath, sequence, options);
    } catch (error) {
      reportError(onError, error);
      return null;
    }
    try {
      options.fileSystem.lstatSync(target);
    } catch (error) {
      if (error?.code === "ENOENT") return { path: target, sequence };
      reportError(onError, error);
      return null;
    }
    sequence += 1;
  }
  const error = new Error("unable to allocate a unique log archive name");
  error.code = "EEXIST";
  reportError(onError, error);
  return null;
}

function cleanupArchives(filePath, maxFiles, fileSystem, onError) {
  let archives = listRegularArchives(filePath, fileSystem, onError);
  if (archives === null) return { ok: false, archives: null };
  while (archives.length > maxFiles) {
    let removed = 0;
    for (const archive of archives.slice(0, archives.length - maxFiles)) {
      try {
        fileSystem.rmSync(archive.path, { force: true });
        removed += 1;
      } catch (error) {
        reportError(onError, error);
      }
    }
    if (removed === 0) break;
    const next = listRegularArchives(filePath, fileSystem, onError);
    if (next === null) return { ok: false, archives: null };
    if (next.length >= archives.length) {
      archives = next;
      break;
    }
    archives = next;
  }
  return { ok: archives.length <= maxFiles, archives };
}

function rotateActiveFile(filePath, maxFiles, options, onError, minimumSequence = 0) {
  try {
    const stats = options.fileSystem.lstatSync(filePath);
    if (!stats.isFile() || stats.size === 0) {
      return { rotated: false, sequence: null, paused: false };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") reportError(onError, error);
    return { rotated: false, sequence: null, paused: false };
  }

  let archives = listRegularArchives(filePath, options.fileSystem, onError);
  if (archives === null) {
    return { rotated: false, sequence: null, paused: true, renameFailed: false };
  }
  if (archives.length > maxFiles) {
    const retention = cleanupArchives(filePath, maxFiles, options.fileSystem, onError);
    if (!retention.ok) {
      return { rotated: false, sequence: null, paused: true, renameFailed: false };
    }
    archives = retention.archives ?? archives;
  }
  const maxExisting = archives.reduce((maximum, archive) => Math.max(maximum, archive.sequence), 0);
  const allocation = allocateArchivePath(
    filePath,
    Math.max(maxExisting, minimumSequence) + 1,
    options,
    onError
  );
  if (allocation === null) {
    return { rotated: false, sequence: null, paused: false, renameFailed: false };
  }

  try {
    options.fileSystem.renameSync(filePath, allocation.path);
  } catch (error) {
    reportError(onError, error);
    let activeExists = false;
    try {
      activeExists = options.fileSystem.lstatSync(filePath).isFile();
    } catch (statError) {
      if (statError?.code !== "ENOENT") reportError(onError, statError);
    }
    return {
      rotated: false,
      sequence: allocation.sequence,
      paused: activeExists,
      renameFailed: true
    };
  }
  const retention = cleanupArchives(filePath, maxFiles, options.fileSystem, onError);
  return {
    rotated: true,
    sequence: allocation.sequence,
    paused: !retention.ok,
    renameFailed: false
  };
}

export function rotateFileIfNeeded(
  filePath,
  {
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    onError = null,
    fileSystem = defaultFileSystem,
    now = Date.now,
    pid = process.pid,
    randomHex = defaultRandomHex
  } = {}
) {
  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const archiveLimit = Number.isInteger(maxFiles) && maxFiles >= 1 ? maxFiles : DEFAULT_MAX_FILES;
  const report = typeof onError === "function" ? onError : null;
  const options = normalizeOptions({ fileSystem, now, pid, randomHex });
  try {
    const stats = options.fileSystem.lstatSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size <= byteLimit) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") reportError(report, error);
    return false;
  }
  return rotateActiveFile(filePath, archiveLimit, options, report).rotated;
}

export class RotatingLogWriter {
  constructor({
    filePath,
    maxBytes,
    maxFiles,
    mode = 0o600,
    onError = null,
    fileSystem = defaultFileSystem,
    now = Date.now,
    pid = process.pid,
    randomHex = defaultRandomHex
  } = {}) {
    this.filePath = typeof filePath === "string" ? filePath : String(filePath ?? "");
    this.maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    this.maxFiles = Number.isInteger(maxFiles) && maxFiles >= 1 ? maxFiles : DEFAULT_MAX_FILES;
    this.mode = Number.isInteger(mode) ? mode : 0o600;
    this.onError = typeof onError === "function" ? onError : null;
    this.options = normalizeOptions({ fileSystem, now, pid, randomHex });
    this.closed = false;
    this.paused = null;
    this.retentionChecked = false;
    this.currentBytes = 0;
    this.lastSequence = 0;
    try {
      const stats = this.options.fileSystem.lstatSync(this.filePath);
      if (stats.isFile()) this.currentBytes = stats.size;
    } catch (error) {
      if (error?.code !== "ENOENT") reportError(this.onError, error);
    }
  }

  append(text) {
    if (this.closed) return false;
    let data;
    try {
      data = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ""), "utf8");
    } catch (error) {
      reportError(this.onError, error);
      return false;
    }
    if (data.length === 0) return true;

    if (this.paused === "cleanup") {
      const retention = cleanupArchives(
        this.filePath,
        this.maxFiles,
        this.options.fileSystem,
        this.onError
      );
      if (!retention.ok) return false;
      this.paused = null;
    }
    if (this.paused === "rotation" && !this.attemptRotation()) {
      return false;
    }
    if (!this.retentionChecked) {
      const retention = cleanupArchives(
        this.filePath,
        this.maxFiles,
        this.options.fileSystem,
        this.onError
      );
      this.retentionChecked = true;
      if (!retention.ok) {
        this.paused = "cleanup";
        return false;
      }
    }

    if (this.currentBytes > 0 && this.currentBytes + data.length > this.maxBytes) {
      if (!this.attemptRotation()) return false;
    }

    try {
      this.options.fileSystem.appendFileSync(this.filePath, data, { mode: this.mode });
      this.currentBytes += data.length;
      return true;
    } catch (error) {
      reportError(this.onError, error);
      return false;
    }
  }

  refreshCurrentBytes() {
    try {
      const stats = this.options.fileSystem.lstatSync(this.filePath);
      this.currentBytes = stats.isFile() ? stats.size : 0;
    } catch (error) {
      if (error?.code === "ENOENT") this.currentBytes = 0;
      else reportError(this.onError, error);
    }
  }

  attemptRotation() {
    const rotation = rotateActiveFile(
      this.filePath,
      this.maxFiles,
      this.options,
      this.onError,
      this.lastSequence
    );
    if (rotation.sequence !== null) this.lastSequence = rotation.sequence;
    if (rotation.rotated) {
      this.currentBytes = 0;
      if (rotation.paused) {
        this.paused = "cleanup";
        return false;
      }
      this.paused = null;
      return true;
    }
    if (rotation.paused) {
      this.paused = rotation.renameFailed ? "rotation" : "cleanup";
      return false;
    }
    this.refreshCurrentBytes();
    if (this.currentBytes > 0) {
      this.paused = "rotation";
      return false;
    }
    this.paused = null;
    return true;
  }

  close() {
    this.closed = true;
  }
}
