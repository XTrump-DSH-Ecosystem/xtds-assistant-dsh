import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, "config/supervisor.json");

const SERVICE_DEFAULTS = {
  host: "127.0.0.1",
  preferredPort: 0,
  healthPath: "/health",
  healthRequireOnline: false,
  endpointPid: "self",
  env: {},
  envFile: null,
  dependsOn: null
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function directEnvValue(env, name) {
  const exact = env[name];
  if (typeof exact === "string" && exact.length > 0) return exact;
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (match !== undefined) {
    const value = env[match];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
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
  if (typeof value !== "string" || value.length === 0) return value;
  let expanded = value;
  expanded = expanded.replace(/%([^%]+)%/g, (match, name) => envValue(env, name) ?? match);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (match, name) => envValue(env, name) ?? match);
  const home = profilePath(env);
  if (expanded === "~") expanded = home ?? expanded;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = resolve(home ?? "~", expanded.slice(2));
  }
  return expanded;
}

function asBoolean(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${field} must be a boolean`);
  return value;
}

function asInteger(value, fallback, field, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asString(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function normalizeService(raw, index, options) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`processes[${index}] must be an object`);
  }
  const id = asString(raw.id, undefined, `processes[${index}].id`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new ConfigError(`processes[${index}].id is invalid`);
  }
  const cwd = resolve(options.baseDir, expandPath(asString(raw.cwd, undefined, `processes[${index}].cwd`), options.env));
  const command = resolve(options.baseDir, expandPath(asString(raw.command, options.nodePath, `processes[${index}].command`), options.env));
  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new ConfigError(`processes[${index}].args must be an array of strings`);
  }
  const host = asString(raw.host, SERVICE_DEFAULTS.host, `processes[${index}].host`);
  if (!isLoopbackHost(host)) throw new ConfigError(`processes[${index}].host must be loopback`);
  const healthPath = asString(raw.healthPath, SERVICE_DEFAULTS.healthPath, `processes[${index}].healthPath`);
  if (!healthPath.startsWith("/")) throw new ConfigError(`processes[${index}].healthPath must start with /`);
  const endpointPid = asString(raw.endpointPid, SERVICE_DEFAULTS.endpointPid, `processes[${index}].endpointPid`);
  if (endpointPid !== "self" && endpointPid !== "any") {
    throw new ConfigError(`processes[${index}].endpointPid must be "self" or "any"`);
  }

  const endpointValue = asString(raw.endpointFile, undefined, `processes[${index}].endpointFile`);
  const endpointFile = resolve(options.baseDir, expandPath(endpointValue, options.env));
  const envFileRaw = raw.envFile;
  if (envFileRaw !== undefined && envFileRaw !== null && typeof envFileRaw !== "string") {
    throw new ConfigError(`processes[${index}].envFile must be a string or null`);
  }
  const envFile = typeof envFileRaw === "string" && envFileRaw.trim().length > 0
    ? resolve(options.baseDir, expandPath(envFileRaw.trim(), options.env))
    : null;
  const env = raw.env ?? {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new ConfigError(`processes[${index}].env must be an object`);
  }
  const normalizedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new ConfigError(`processes[${index}].env contains an invalid entry`);
    }
    normalizedEnv[key] = value;
  }
  const dependsOn = raw.dependsOn === undefined || raw.dependsOn === null
    ? null
    : asString(raw.dependsOn, null, `processes[${index}].dependsOn`);

  return Object.freeze({
    id,
    label: asString(raw.label, id, `processes[${index}].label`),
    cwd,
    command,
    args: Object.freeze([...args]),
    endpointFile,
    host,
    preferredPort: asInteger(raw.preferredPort, SERVICE_DEFAULTS.preferredPort, `processes[${index}].preferredPort`, 0, 65535),
    healthPath,
    endpointPid,
    healthRequireOnline: asBoolean(
      raw.healthRequireOnline,
      SERVICE_DEFAULTS.healthRequireOnline,
      `processes[${index}].healthRequireOnline`
    ),
    env: Object.freeze(normalizedEnv),
    envFile,
    dependsOn
  });
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH, options = {}) {
  const env = options.env ?? process.env;
  const resolvedPath = resolve(expandPath(configPath, env));
  let raw = {};
  if (existsSync(resolvedPath)) {
    let text;
    try {
      text = readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, "");
    } catch (error) {
      throw new ConfigError(`cannot read config: ${error.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`config is not valid JSON: ${error.message}`);
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config root must be an object");
  }

  const baseDir = dirname(resolvedPath);
  const host = asString(raw.host, "127.0.0.1", "host");
  if (!isLoopbackHost(host)) throw new ConfigError("host must be loopback");
  const port = asInteger(raw.port, 986, "port", 0, 65535);
  const runtimeDir = resolve(baseDir, expandPath(asString(raw.runtimeDir, "runtime", "runtimeDir"), env));
  const serviceRuntimeDir = resolve(
    baseDir,
    expandPath(asString(raw.serviceRuntimeDir, "%LOCALAPPDATA%\\DSH\\runtime", "serviceRuntimeDir"), env)
  );
  const nodePath = resolve(baseDir, expandPath(asString(raw.nodePath, process.execPath, "nodePath"), env));
  const taskName = asString(raw.taskName, "XTDS-Assistant", "taskName");
  if (!/^[A-Za-z0-9._ -]{1,64}$/.test(taskName)) {
    throw new ConfigError("taskName contains unsupported characters");
  }
  const autostartBackend = asString(raw.autostartBackend, "registry", "autostartBackend");
  if (autostartBackend !== "registry" && autostartBackend !== "startup" && autostartBackend !== "schtasks") {
    throw new ConfigError("autostartBackend must be registry, startup, or schtasks");
  }
  const startupDirRaw = raw.startupDir;
  if (startupDirRaw !== undefined && startupDirRaw !== null && typeof startupDirRaw !== "string") {
    throw new ConfigError("startupDir must be a string");
  }
  const startupDir = typeof startupDirRaw === "string" && startupDirRaw.trim().length > 0
    ? resolve(baseDir, expandPath(startupDirRaw.trim(), env))
    : undefined;
  const processesRaw = raw.processes;
  if (!Array.isArray(processesRaw) || processesRaw.length === 0) {
    throw new ConfigError("processes must be a non-empty array");
  }
  const processes = processesRaw.map((entry, index) => normalizeService(entry, index, {
    baseDir,
    env,
    nodePath
  }));
  const ids = new Set();
  for (const processConfig of processes) {
    if (ids.has(processConfig.id)) throw new ConfigError(`duplicate process id: ${processConfig.id}`);
    ids.add(processConfig.id);
  }
  for (const processConfig of processes) {
    if (processConfig.dependsOn !== null && !ids.has(processConfig.dependsOn)) {
      throw new ConfigError(`${processConfig.id} depends on unknown process ${processConfig.dependsOn}`);
    }
  }

  return Object.freeze({
    configPath: resolvedPath,
    baseDir,
    host,
    port,
    runtimeDir,
    serviceRuntimeDir,
    nodePath,
    taskName,
    autostartBackend,
    startupDir,
    startServicesOnBoot: asBoolean(raw.startServicesOnBoot, false, "startServicesOnBoot"),
    readinessTimeoutMs: asInteger(raw.readinessTimeoutMs, 20000, "readinessTimeoutMs", 500, 120000),
    stopTimeoutMs: asInteger(raw.stopTimeoutMs, 8000, "stopTimeoutMs", 500, 60000),
    healthIntervalMs: asInteger(raw.healthIntervalMs, 5000, "healthIntervalMs", 500, 60000),
    healthTimeoutMs: asInteger(raw.healthTimeoutMs, 1500, "healthTimeoutMs", 200, 30000),
    logMaxBytes: asInteger(raw.logMaxBytes, 5 * 1024 * 1024, "logMaxBytes", 1024, 1073741824),
    logMaxFiles: asInteger(raw.logMaxFiles, 5, "logMaxFiles", 1, 50),
    processes: Object.freeze(processes)
  });
}

export function endpointUrl(service, port) {
  return `http://${service.host}:${port}${service.healthPath}`;
}

export function relativeToBase(baseDir, value) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}
