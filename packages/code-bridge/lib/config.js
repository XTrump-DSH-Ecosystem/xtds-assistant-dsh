import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  HOST
} from "./constants.js";
import { ConfigError } from "./errors.js";

const DEFAULT_WORKTREE_ROOT = "E:\\workspace\\.code-worktrees";
const DEFAULT_DSH_SESSIONS_DIR = "%USERPROFILE%\\.dsh\\storages\\session_projcache\\sessions";
const DEFAULT_DSH_WORKSPACE_ROOT = "%USERPROFILE%\\Documents\\deepseek-harness";

function directEnvValue(env, name) {
  const exact = env[name];
  if (typeof exact === "string" && exact.length > 0) return exact;
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (match === undefined) return undefined;
  const value = env[match];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function profilePath(env) {
  return directEnvValue(env, "USERPROFILE") ?? directEnvValue(env, "HOME");
}

function envValue(env, name) {
  const direct = directEnvValue(env, name);
  if (direct !== undefined) return direct;
  const profile = profilePath(env);
  switch (name.toUpperCase()) {
    case "USERPROFILE":
    case "HOME":
      return profile;
    case "LOCALAPPDATA":
      return profile === undefined ? undefined : join(profile, "AppData", "Local");
    case "APPDATA":
      return profile === undefined ? undefined : join(profile, "AppData", "Roaming");
    default:
      return undefined;
  }
}

export function expandPath(value, env = process.env) {
  let expanded = value;
  expanded = expanded.replace(/%([^%]+)%/g, (match, name) => envValue(env, name) ?? match);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (match, name) => envValue(env, name) ?? match);
  const profile = profilePath(env);
  if (expanded === "~") expanded = profile ?? expanded;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = resolve(profile ?? "~", expanded.slice(2));
  }
  return expanded;
}

function asString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function asInteger(value, fallback, field, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function resolvePath(baseDir, value, field, env) {
  const expanded = expandPath(asString(value, field), env);
  return resolve(baseDir, expanded);
}

export function loadConfig(configPath, options = {}) {
  const env = options.env ?? process.env;
  const resolvedPath = resolve(expandPath(configPath, env));
  if (!existsSync(resolvedPath)) {
    throw new ConfigError(`config file not found: ${resolvedPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${error.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config root must be an object");
  }

  const host = raw.host ?? HOST;
  if (host !== HOST) {
    throw new ConfigError(`host must be exactly ${HOST}`);
  }

  if (raw.repos === null || typeof raw.repos !== "object" || Array.isArray(raw.repos)) {
    throw new ConfigError("repos must be an object");
  }
  const repos = {};
  for (const [alias, repoPath] of Object.entries(raw.repos)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias)) {
      throw new ConfigError(`invalid repo alias: ${alias}`);
    }
    const resolvedRepo = resolvePath(dirname(resolvedPath), repoPath, `repos.${alias}`, env);
    if (!isAbsolute(resolvedRepo)) {
      throw new ConfigError(`repos.${alias} must resolve to an absolute path`);
    }
    repos[alias] = resolvedRepo;
  }
  if (Object.keys(repos).length === 0) {
    throw new ConfigError("repos must contain at least one repository alias");
  }

  const baseDir = dirname(resolvedPath);
  const workspaceRoots = raw.workspaceRoots === undefined
    ? []
    : raw.workspaceRoots;
  if (!Array.isArray(workspaceRoots)) {
    throw new ConfigError("workspaceRoots must be an array of paths");
  }
  return Object.freeze({
    configPath: resolvedPath,
    baseDir,
    host: HOST,
    port: asInteger(raw.port, DEFAULT_PORT, "port", 0, 65535),
    runtimeDir: resolvePath(
      baseDir,
      raw.runtimeDir ?? "%LOCALAPPDATA%\\DSH\\runtime",
      "runtimeDir",
      env
    ),
    worktreeRoot: resolvePath(
      baseDir,
      raw.worktreeRoot ?? DEFAULT_WORKTREE_ROOT,
      "worktreeRoot",
      env
    ),
    dshSessionsDir: resolvePath(
      baseDir,
      raw.dshSessionsDir ?? DEFAULT_DSH_SESSIONS_DIR,
      "dshSessionsDir",
      env
    ),
    dshWorkspaceRoot: resolvePath(
      baseDir,
      raw.dshWorkspaceRoot ?? DEFAULT_DSH_WORKSPACE_ROOT,
      "dshWorkspaceRoot",
      env
    ),
    workspaceRoots: Object.freeze(workspaceRoots.map((entry, index) => resolvePath(
      baseDir,
      entry,
      `workspaceRoots[${index}]`,
      env
    ))),
    dshCommand: resolvePath(baseDir, raw.dshCommand, "dshCommand", env),
    taskTimeoutMs: asInteger(raw.taskTimeoutMs, DEFAULT_TIMEOUT_MS, "taskTimeoutMs", 50, 24 * 60 * 60 * 1000),
    repos: Object.freeze(repos)
  });
}
