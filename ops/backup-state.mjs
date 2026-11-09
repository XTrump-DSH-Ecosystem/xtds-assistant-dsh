import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 2;
const LOCK_NAME = "ds-memory.lock";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DRILL_ROOT = join(REPO_ROOT, "runtime", "restore-drill");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function randomToken() {
  return randomBytes(8).toString("hex");
}

function foldPath(filePath) {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function canonicalForComparison(filePath) {
  const absolute = resolve(filePath);
  const suffix = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let base;
  try {
    base = realpathSync.native(current);
  } catch {
    base = current;
  }
  return foldPath(suffix.length === 0 ? base : join(base, ...suffix));
}

function containsPath(parent, candidate) {
  const rel = relative(foldPath(parent), foldPath(candidate));
  return rel === ""
    || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathsOverlap(left, right) {
  const canonicalLeft = canonicalForComparison(left);
  const canonicalRight = canonicalForComparison(right);
  return containsPath(canonicalLeft, canonicalRight) || containsPath(canonicalRight, canonicalLeft);
}

function assertTargetInDrillRoot(targetDir, drillRoot) {
  const resolvedRoot = resolve(drillRoot);
  const rootStat = lstatOrNull(resolvedRoot);
  if (rootStat !== null && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error("restore drill root must be a real directory");
  }
  const canonicalRoot = canonicalForComparison(resolvedRoot);
  const canonicalTarget = canonicalForComparison(targetDir);
  const rel = relative(canonicalRoot, canonicalTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("target must be a strict descendant of the restore drill root");
  }
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sourcePathHash(source) {
  return hashText(canonicalForComparison(source));
}

function ancestorPathHashes(filePath) {
  const hashes = new Set();
  let current = canonicalForComparison(filePath);
  while (true) {
    hashes.add(hashText(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return hashes;
}

function sourceAncestorPathHashes(source) {
  const hashes = [];
  const canonicalSource = canonicalForComparison(source);
  let current = dirname(canonicalSource);
  if (current === canonicalSource) return hashes;
  while (true) {
    hashes.push(hashText(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return hashes;
}

function hashFile(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function isTemporaryName(name) {
  const lower = name.toLowerCase();
  return lower === LOCK_NAME
    || lower.endsWith(".tmp")
    || lower.endsWith(".temp")
    || lower.endsWith(".partial")
    || lower.endsWith(".swp")
    || lower.endsWith(".crdownload")
    || lower.endsWith("~")
    || lower.startsWith("~$")
    || lower.startsWith(".#")
    || lower.startsWith(".tmp-")
    || lower.startsWith(".~lock.");
}

function toManifestPath(root, filePath) {
  return relative(root, filePath).split(sep).join("/");
}

function normalizeManifestPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("manifest contains an invalid file path");
  }
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:/.test(slashPath) || isAbsolute(slashPath)) {
    throw new Error("manifest contains an absolute file path");
  }
  const normalized = posix.normalize(slashPath);
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
  ) {
    throw new Error("manifest contains a file path outside the backup");
  }
  if (normalized === MANIFEST_NAME) {
    throw new Error("manifest cannot list itself as a state file");
  }
  return normalized;
}

function manifestDiskPath(root, manifestPath) {
  const fullPath = join(root, ...manifestPath.split("/"));
  if (!containsPath(canonicalForComparison(root), canonicalForComparison(fullPath))) {
    throw new Error("manifest file path escapes the target directory");
  }
  return fullPath;
}

function walkSourceFiles(root) {
  const files = [];
  const walk = (dirPath) => {
    for (const name of readdirSync(dirPath).sort()) {
      if (isTemporaryName(name)) continue;
      const fullPath = join(dirPath, name);
      const entry = lstatSync(fullPath);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = toManifestPath(root, fullPath);
        if (relativePath === MANIFEST_NAME) {
          throw new Error(`backup source contains reserved file: ${MANIFEST_NAME}`);
        }
        files.push({
          sourcePath: fullPath,
          relativePath,
          bytes: entry.size
        });
      }
    }
  };
  walk(root);
  files.sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    return 0;
  });
  return files;
}

function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function ensureDirectoryIsEmptyOrMissing(dirPath) {
  const stat = lstatOrNull(dirPath);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("backup destination exists and is not a directory");
  }
  if (readdirSync(dirPath).length > 0) {
    throw new Error("backup destination must be missing or empty");
  }
  return true;
}

function validateManifest(raw) {
  if (!isObject(raw)) throw new Error("manifest root must be an object");
  if (raw.version !== MANIFEST_VERSION) throw new Error("manifest version 2 is required");
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new Error("manifest createdAt is invalid");
  }
  if (
    typeof raw.source !== "string"
    || raw.source.length === 0
    || basename(raw.source) !== raw.source
    || raw.source === "."
    || raw.source === ".."
    || raw.source.includes("/")
    || raw.source.includes("\\")
  ) {
    throw new Error("manifest source must be a basename");
  }
  if (typeof raw.sourcePathHash !== "string" || !/^[a-fA-F0-9]{64}$/.test(raw.sourcePathHash)) {
    throw new Error("manifest sourcePathHash is required and must be 64 hex characters");
  }
  const normalizedSourcePathHash = raw.sourcePathHash.toLowerCase();
  if (!Array.isArray(raw.sourceAncestorPathHashes) || raw.sourceAncestorPathHashes.length === 0) {
    throw new Error("manifest sourceAncestorPathHashes is required and must not be empty");
  }
  const validatedAncestorHashes = [];
  const seenSourceAncestors = new Set();
  for (const value of raw.sourceAncestorPathHashes) {
    if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error("manifest sourceAncestorPathHashes contains an invalid hash");
    }
    const normalized = value.toLowerCase();
    if (seenSourceAncestors.has(normalized)) {
      throw new Error("manifest sourceAncestorPathHashes contains duplicate hashes");
    }
    if (normalized === normalizedSourcePathHash) {
      throw new Error("manifest sourceAncestorPathHashes must not contain sourcePathHash");
    }
    seenSourceAncestors.add(normalized);
    validatedAncestorHashes.push(normalized);
  }
  if (!Array.isArray(raw.files)) throw new Error("manifest files must be an array");
  if (!Number.isInteger(raw.totalFiles) || raw.totalFiles < 0) {
    throw new Error("manifest totalFiles is invalid");
  }
  if (!Number.isInteger(raw.totalBytes) || raw.totalBytes < 0) {
    throw new Error("manifest totalBytes is invalid");
  }

  const seen = new Set();
  let totalBytes = 0;
  const files = raw.files.map((entry) => {
    if (!isObject(entry)) throw new Error("manifest file entry is invalid");
    const manifestPath = normalizeManifestPath(entry.path);
    const seenKey = process.platform === "win32" ? manifestPath.toLowerCase() : manifestPath;
    if (seen.has(seenKey)) throw new Error("manifest contains duplicate file paths");
    seen.add(seenKey);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error("manifest file size is invalid");
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("manifest file hash is invalid");
    }
    totalBytes += entry.bytes;
    return {
      path: manifestPath,
      bytes: entry.bytes,
      sha256: entry.sha256
    };
  });

  if (raw.totalFiles !== files.length) throw new Error("manifest totalFiles does not match files");
  if (raw.totalBytes !== totalBytes) throw new Error("manifest totalBytes does not match files");

  return {
    version: MANIFEST_VERSION,
    createdAt: raw.createdAt,
    source: raw.source,
    sourcePathHash: normalizedSourcePathHash,
    sourceAncestorPathHashes: validatedAncestorHashes,
    files,
    totalFiles: raw.totalFiles,
    totalBytes: raw.totalBytes
  };
}

function readManifest(backupDir) {
  const manifestPath = join(backupDir, MANIFEST_NAME);
  const manifestStat = lstatOrNull(manifestPath);
  if (manifestStat === null) throw new Error("manifest.json is missing");
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("manifest.json must be a regular file");
  }
  let text;
  try {
    text = readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("manifest.json is missing");
    throw new Error(`manifest.json cannot be read${error?.code ? ` (${error.code})` : ""}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  return validateManifest(raw);
}

function listBackupEntries(root) {
  const files = [];
  const otherEntries = [];
  const walk = (dirPath, prefix = "") => {
    for (const name of readdirSync(dirPath).sort()) {
      const fullPath = join(dirPath, name);
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const entry = lstatSync(fullPath);
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        otherEntries.push(relativePath);
      }
    }
  };
  walk(root);
  return { files, otherEntries };
}

async function verifyFilesAtRoot(root, manifest) {
  const errors = [];
  for (const entry of manifest.files) {
    let fullPath;
    try {
      fullPath = manifestDiskPath(root, entry.path);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const stat = lstatOrNull(fullPath);
    if (stat === null) {
      errors.push(`missing file: ${entry.path}`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`not a regular file: ${entry.path}`);
      continue;
    }
    if (stat.size !== entry.bytes) {
      errors.push(`size mismatch: ${entry.path}`);
      continue;
    }
    let actualHash;
    try {
      actualHash = await hashFile(fullPath);
    } catch {
      errors.push(`cannot hash file: ${entry.path}`);
      continue;
    }
    if (actualHash !== entry.sha256) errors.push(`sha256 mismatch: ${entry.path}`);
  }

  const warnings = [];
  const expected = new Set(manifest.files.map((entry) => entry.path));
  const listed = listBackupEntries(root);
  for (const filePath of listed.files) {
    if (filePath === MANIFEST_NAME) continue;
    if (!expected.has(filePath)) warnings.push(`extra file present: ${filePath}`);
  }
  for (const entryPath of listed.otherEntries) {
    warnings.push(`extra non-regular entry present: ${entryPath}`);
  }
  return { errors, warnings };
}

export async function createBackup({ source, dest, hooks = {}, drillRoot = DEFAULT_DRILL_ROOT }) {
  if (typeof source !== "string" || source.length === 0) throw new Error("source is required");
  if (typeof dest !== "string" || dest.length === 0) throw new Error("dest is required");
  if (typeof drillRoot !== "string" || drillRoot.length === 0) throw new Error("drillRoot is required");

  const sourceDir = resolve(source);
  const destDir = resolve(dest);
  const drillRootDir = resolve(drillRoot);
  const sourceStat = lstatOrNull(sourceDir);
  if (sourceStat === null || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("source must be an existing directory");
  }
  if (pathsOverlap(sourceDir, drillRootDir)) {
    throw new Error("source must not overlap the restore drill root");
  }
  if (basename(destDir).length === 0 || destDir === dirname(destDir)) {
    throw new Error("dest must name a backup directory");
  }
  if (pathsOverlap(sourceDir, destDir)) {
    throw new Error("source and backup destination must not overlap");
  }
  const sourceAncestors = sourceAncestorPathHashes(sourceDir);
  if (sourceAncestors.length === 0) {
    throw new Error("source must not be a filesystem root");
  }

  const existsEmptyDest = ensureDirectoryIsEmptyOrMissing(destDir);
  const files = walkSourceFiles(sourceDir);
  const parent = dirname(destDir);
  mkdirSync(parent, { recursive: true });
  const tempDir = join(parent, `.${basename(destDir)}.tmp-${process.pid}-${randomToken()}`);
  let committed = false;

  try {
    mkdirSync(tempDir);
    const manifestFiles = [];
    let totalBytes = 0;
    for (const entry of files) {
      const targetPath = join(tempDir, ...entry.relativePath.split("/"));
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(entry.sourcePath, targetPath);
      const copiedStat = lstatSync(targetPath);
      if (!copiedStat.isFile() || copiedStat.size !== entry.bytes) {
        throw new Error(`file changed while copying: ${entry.relativePath}`);
      }
      manifestFiles.push({
        path: entry.relativePath,
        bytes: copiedStat.size,
        sha256: await hashFile(targetPath)
      });
      totalBytes += copiedStat.size;
    }

    const manifest = {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      source: basename(sourceDir),
      sourcePathHash: sourcePathHash(sourceDir),
      sourceAncestorPathHashes: sourceAncestors,
      files: manifestFiles,
      totalFiles: manifestFiles.length,
      totalBytes
    };
    writeFileSync(join(tempDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    if (typeof hooks.beforeCommit === "function") {
      await hooks.beforeCommit({ tempDir, destDir, manifest });
    }

    if (existsEmptyDest) {
      if (readdirSync(destDir).length > 0) {
        throw new Error("backup destination changed while the backup was being created");
      }
      rmdirSync(destDir);
    }
    renameSync(tempDir, destDir);
    committed = true;
    return {
      backup: destDir,
      manifest
    };
  } finally {
    if (!committed) rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function verifyBackup(backupDir) {
  if (typeof backupDir !== "string" || backupDir.length === 0) throw new Error("backup is required");
  const root = resolve(backupDir);
  const stat = lstatOrNull(root);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("backup must be an existing directory");
  }
  const manifest = readManifest(root);
  const verified = await verifyFilesAtRoot(root, manifest);
  return {
    ok: verified.errors.length === 0,
    errors: verified.errors,
    warnings: verified.warnings,
    manifest,
    filesVerified: manifest.totalFiles,
    bytesVerified: manifest.totalBytes
  };
}

function assertTargetIsSafe({ targetDir, backupDir, manifest, drillRoot }) {
  assertTargetInDrillRoot(targetDir, drillRoot);
  if (pathsOverlap(backupDir, targetDir)) {
    throw new Error("target must not equal, contain, or be inside the backup directory");
  }
  if (ancestorPathHashes(targetDir).has(manifest.sourcePathHash)) {
    throw new Error("target must not equal the live source or be inside it");
  }
  const targetHash = hashText(canonicalForComparison(targetDir));
  if (manifest.sourceAncestorPathHashes.includes(targetHash)) {
    throw new Error("target must not contain the live source or be its ancestor");
  }
}

function copyManifestFiles(sourceRoot, targetRoot, manifest) {
  for (const entry of manifest.files) {
    const sourcePath = manifestDiskPath(sourceRoot, entry.path);
    const targetPath = manifestDiskPath(targetRoot, entry.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

export async function restoreBackup({ backup, target, force = false, drillRoot = DEFAULT_DRILL_ROOT }) {
  if (typeof backup !== "string" || backup.length === 0) throw new Error("backup is required");
  if (typeof target !== "string" || target.length === 0) throw new Error("target is required");
  if (typeof drillRoot !== "string" || drillRoot.length === 0) throw new Error("drillRoot is required");

  const backupDir = resolve(backup);
  const targetDir = resolve(target);
  const drillRootDir = resolve(drillRoot);
  const verification = await verifyBackup(backupDir);
  if (!verification.ok) {
    throw new Error(`backup verification failed: ${verification.errors.join("; ")}`);
  }
  assertTargetIsSafe({ targetDir, backupDir, manifest: verification.manifest, drillRoot: drillRootDir });

  const targetStat = lstatOrNull(targetDir);
  if (targetStat !== null) {
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error("target exists and is not a directory");
    }
    if (readdirSync(targetDir).length > 0 && !force) {
      throw new Error("target is not empty; use --force to replace it");
    }
  }

  const parent = dirname(targetDir);
  mkdirSync(parent, { recursive: true });
  assertTargetInDrillRoot(targetDir, drillRootDir);
  const stagingDir = join(parent, `.${basename(targetDir)}.restore-${process.pid}-${randomToken()}`);
  const previousDir = join(parent, `.${basename(targetDir)}.previous-${process.pid}-${randomToken()}`);
  let stagingCreated = false;
  let previousMoved = false;
  let targetCreated = false;

  try {
    mkdirSync(stagingDir);
    stagingCreated = true;
    copyManifestFiles(backupDir, stagingDir, verification.manifest);
    const stagingVerification = await verifyFilesAtRoot(stagingDir, verification.manifest);
    if (stagingVerification.errors.length > 0) {
      throw new Error(`staged restore verification failed: ${stagingVerification.errors.join("; ")}`);
    }

    if (targetStat !== null) {
      renameSync(targetDir, previousDir);
      previousMoved = true;
    }
    try {
      renameSync(stagingDir, targetDir);
      stagingCreated = false;
      targetCreated = true;
    } catch (error) {
      if (previousMoved) {
        renameSync(previousDir, targetDir);
        previousMoved = false;
      }
      throw error;
    }

    const restoredVerification = await verifyFilesAtRoot(targetDir, verification.manifest);
    if (restoredVerification.errors.length > 0) {
      throw new Error(`restored target verification failed: ${restoredVerification.errors.join("; ")}`);
    }
    if (previousMoved) {
      rmSync(previousDir, { recursive: true, force: true });
      previousMoved = false;
    }
    return {
      target: targetDir,
      filesRestored: verification.manifest.totalFiles,
      bytesRestored: verification.manifest.totalBytes
    };
  } catch (error) {
    if (targetCreated) {
      rmSync(targetDir, { recursive: true, force: true });
      targetCreated = false;
    }
    if (previousMoved && !existsSync(targetDir)) {
      renameSync(previousDir, targetDir);
      previousMoved = false;
    }
    throw error;
  } finally {
    if (stagingCreated) rmSync(stagingDir, { recursive: true, force: true });
    if (previousMoved && existsSync(previousDir) && !existsSync(targetDir)) {
      renameSync(previousDir, targetDir);
    }
    if (previousMoved && existsSync(previousDir) && existsSync(targetDir)) {
      rmSync(previousDir, { recursive: true, force: true });
    }
  }
}

function displayPath(filePath) {
  const shown = relative(process.cwd(), filePath);
  return isAbsolute(shown) ? basename(filePath) : shown || ".";
}

function usage() {
  return [
    "Usage:",
    "  node ops/backup-state.mjs create --source <dir> --dest <backup-dir>",
    "  node ops/backup-state.mjs verify --backup <backup-dir>",
    "  node ops/backup-state.mjs restore --backup <backup-dir> --target <dir> [--force]",
    "",
    "Creates read-only state snapshots and verifies/restores them in isolation."
  ].join("\n");
}

function parseCreate(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: "string" },
      dest: { type: "string" }
    }
  });
  if (typeof values.source !== "string" || typeof values.dest !== "string") {
    throw new Error("create requires --source and --dest");
  }
  return { command: "create", source: resolve(values.source), dest: resolve(values.dest) };
}

function parseVerify(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      backup: { type: "string" }
    }
  });
  if (typeof values.backup !== "string") throw new Error("verify requires --backup");
  return { command: "verify", backup: resolve(values.backup) };
}

function parseRestore(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      backup: { type: "string" },
      target: { type: "string" },
      force: { type: "boolean", default: false }
    }
  });
  if (typeof values.backup !== "string" || typeof values.target !== "string") {
    throw new Error("restore requires --backup and --target");
  }
  return {
    command: "restore",
    backup: resolve(values.backup),
    target: resolve(values.target),
    force: values.force
  };
}

export function parseBackupCommand(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { command: "help" };
  const [command, ...rest] = argv;
  if (command === "create") return parseCreate(rest);
  if (command === "verify") return parseVerify(rest);
  if (command === "restore") return parseRestore(rest);
  throw new Error(`unknown command: ${command}`);
}

function stableErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "E_BACKUP_STATE";
}

export function formatBackupError(error) {
  const code = stableErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const hasStructuredPath = [error?.path, error?.dest, error?.src]
    .some((value) => typeof value === "string" && value.length > 0);
  const looksAbsolute = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s'"(])\/)/.test(message);
  if (hasStructuredPath || looksAbsolute) {
    return `backup-state failed [${code}]: operation failed; absolute path redacted`;
  }
  const safeMessage = message.trim().length === 0 ? "operation failed" : message.trim();
  return `backup-state failed [${code}]: ${safeMessage}`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseBackupCommand(argv);
    if (parsed.command === "help") {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (parsed.command === "create") {
      const result = await createBackup({ source: parsed.source, dest: parsed.dest });
      process.stdout.write(
        `backup=${displayPath(result.backup)} files=${result.manifest.totalFiles} `
        + `bytes=${result.manifest.totalBytes}\n`
      );
      return result;
    }
    if (parsed.command === "verify") {
      const result = await verifyBackup(parsed.backup);
      for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
      for (const error of result.errors) process.stderr.write(`error: ${error}\n`);
      if (!result.ok) {
        process.exitCode = 1;
        return result;
      }
      process.stdout.write(`verified=${displayPath(parsed.backup)} files=${result.filesVerified} bytes=${result.bytesVerified}\n`);
      return result;
    }
    const result = await restoreBackup({
      backup: parsed.backup,
      target: parsed.target,
      force: parsed.force
    });
    process.stdout.write(
      `restored=${displayPath(result.target)} files=${result.filesRestored} bytes=${result.bytesRestored}\n`
    );
    return result;
  } catch (error) {
    process.stderr.write(`${formatBackupError(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
