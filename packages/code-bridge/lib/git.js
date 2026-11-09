import { lstatSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { MAX_CHANGED_FILES } from "./constants.js";
import { ensureDir } from "./fs-utils.js";
import { sanitizeEnv } from "./env.js";
import { RepoValidationError, WorktreeError } from "./errors.js";

export function comparablePath(value) {
  let normalized = value;
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function samePath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

export function isPathWithinOrEqual(root, target) {
  const rel = relative(root, target);
  if (rel.length === 0) return true;
  return isPathInside(root, target);
}

export function isPathInside(root, target) {
  const rel = relative(root, target);
  if (rel.length === 0 || isAbsolute(rel)) return false;
  if (comparablePath(rel) === comparablePath("..")) return false;
  return !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function readGitCommonDir(cwd, env = process.env) {
  const result = runGit(["rev-parse", "--git-common-dir"], {
    cwd,
    env,
    optionalLocks: true
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const value = result.stdout.trim();
  if (value.length === 0) return null;
  try {
    const absolute = isAbsolute(value) ? value : join(cwd, value);
    return realpathSync.native(absolute);
  } catch {
    return null;
  }
}

function runGit(args, { cwd, env = process.env, optionalLocks = false } = {}) {
  const gitEnv = sanitizeEnv(env);
  if (optionalLocks) gitEnv.GIT_OPTIONAL_LOCKS = "0";
  return spawnSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function canonicalExistingDirectory(value) {
  const real = realpathSync.native(value);
  if (!statSync(real).isDirectory()) throw new RepoValidationError();
  return real;
}

export function validateRepoPath(repoPath, options = {}) {
  let realRepo;
  try {
    realRepo = canonicalExistingDirectory(repoPath);
  } catch {
    throw new RepoValidationError();
  }
  const result = runGit(["rev-parse", "--show-toplevel"], {
    cwd: realRepo,
    env: options.env
  });
  if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim().length === 0) {
    throw new RepoValidationError();
  }
  let top;
  try {
    top = canonicalExistingDirectory(result.stdout.trim());
  } catch {
    throw new RepoValidationError();
  }
  if (comparablePath(realRepo) !== comparablePath(top)) {
    throw new RepoValidationError();
  }
  return realRepo;
}

export function validateWorktreeTarget(root, taskId) {
  if (!/^ct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) {
    throw new WorktreeError("invalid_worktree_path");
  }
  ensureDir(root);
  const realRoot = realpathSync.native(root);
  const target = join(realRoot, taskId);
  if (!isPathInside(realRoot, target)) {
    throw new WorktreeError("invalid_worktree_path");
  }
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw new WorktreeError("worktree_path_error");
  }
  if (existing !== null) throw new WorktreeError("worktree_path_exists");
  return { root: realRoot, target };
}

export function createTaskWorktree({ root, taskId, repoPath, env = process.env }) {
  const { root: realRoot, target } = validateWorktreeTarget(root, taskId);
  const result = runGit(["worktree", "add", "--detach", target, "HEAD"], {
    cwd: repoPath,
    env
  });
  if (result.status !== 0) throw new WorktreeError("worktree_create_failed");

  let realTarget;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    throw new WorktreeError("worktree_path_error");
  }
  if (!isPathInside(realRoot, realTarget)) {
    throw new WorktreeError("worktree_path_escape");
  }
  const top = runGit(["rev-parse", "--show-toplevel"], { cwd: realTarget, env });
  if (top.status !== 0 || typeof top.stdout !== "string" || top.stdout.trim().length === 0) {
    throw new WorktreeError("worktree_validation_failed");
  }
  let realTop;
  try {
    realTop = realpathSync.native(top.stdout.trim());
  } catch {
    throw new WorktreeError("worktree_validation_failed");
  }
  if (comparablePath(realTop) !== comparablePath(realTarget)) {
    throw new WorktreeError("worktree_validation_failed");
  }
  return realTarget;
}

function statusPaths(worktree, env) {
  const result = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktree,
    env,
    optionalLocks: true
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];

  const entries = result.stdout.split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) paths.push(path);
    if (status.includes("R") || status.includes("C")) index += 1;
    if (paths.length >= MAX_CHANGED_FILES) break;
  }
  return paths;
}

function diffStat(worktree, env) {
  const result = runGit(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "HEAD"], {
    cwd: worktree,
    env,
    optionalLocks: true
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { files: 0, insertions: 0, deletions: 0 };
  }
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    files += 1;
    if (/^\d+$/.test(fields[0])) insertions += Number(fields[0]);
    if (/^\d+$/.test(fields[1])) deletions += Number(fields[1]);
  }
  return { files, insertions, deletions };
}

export function collectWorktreeChanges(worktree, env = process.env) {
  return {
    changedFiles: statusPaths(worktree, env),
    diffStat: diffStat(worktree, env)
  };
}
