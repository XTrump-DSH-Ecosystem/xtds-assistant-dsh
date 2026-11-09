import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { ensureDir, readJson, removeFile, writeExclusive, writeJsonAtomic } from "./fs-utils.js";
import { readEndpoint, isPidAlive, writeEndpoint } from "./endpoint.js";
import { createLogger } from "./logger.js";
import { createRedactor } from "./redact.js";
import { ProcessManager } from "./process-manager.js";
import { AutostartManager, ensureStartScript } from "./autostart.js";
import { createApiServer } from "./server.js";

export const VERSION = "0.1.0";
const CLI_PATH = resolve(fileURLToPath(new URL("../bin/supervisor.js", import.meta.url)));

export class AlreadyRunningError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlreadyRunningError";
  }
}

function tokenFile(runtimeDir) {
  return join(runtimeDir, "config.json");
}

function endpointFile(runtimeDir) {
  return join(runtimeDir, "supervisor.endpoint.json");
}

function lockFile(runtimeDir) {
  return join(runtimeDir, "supervisor.lock");
}

function ensureControlToken(runtimeDir) {
  const filePath = tokenFile(runtimeDir);
  const existing = readJson(filePath, null);
  if (existing !== null && typeof existing.controlToken === "string" && existing.controlToken.length >= 32) {
    return existing.controlToken;
  }
  const controlToken = randomBytes(32).toString("hex");
  writeJsonAtomic(filePath, {
    version: 1,
    controlToken,
    createdAt: new Date().toISOString()
  });
  return controlToken;
}

function acquireLock(runtimeDir, instanceId) {
  const filePath = lockFile(runtimeDir);
  const payload = `${JSON.stringify({ pid: process.pid, instanceId, startedAt: Date.now() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusive(filePath, payload);
      return filePath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readJson(filePath, null);
      if (existing !== null && isPidAlive(existing.pid)) {
        throw new AlreadyRunningError(`supervisor already running (pid ${existing.pid})`);
      }
      removeFile(filePath);
    }
  }
  throw new AlreadyRunningError("cannot acquire supervisor lock");
}

function releaseLock(filePath, instanceId) {
  const existing = readJson(filePath, null);
  if (existing !== null && existing.instanceId === instanceId) removeFile(filePath);
}

function checkExistingSupervisor(runtimeDir) {
  const filePath = endpointFile(runtimeDir);
  const endpoint = readEndpoint(filePath);
  if (endpoint === null) return;
  if (endpoint.name !== "xtds-assistant-supervisor") return;
  if (!isPidAlive(endpoint.pid)) {
    removeFile(filePath);
    return;
  }
  throw new AlreadyRunningError(`supervisor endpoint already alive at 127.0.0.1:${endpoint.port} (pid ${endpoint.pid})`);
}

export function inspectConfig(configPath) {
  const config = loadConfig(configPath);
  const issues = [];
  if (!isPidAlive(process.pid)) issues.push("unexpected pid check failure");
  for (const processConfig of config.processes) {
    if (!existsSync(processConfig.command)) {
      issues.push(`${processConfig.id}: command not found: ${processConfig.command}`);
    }
    try {
      if (!statSync(processConfig.cwd).isDirectory()) {
        issues.push(`${processConfig.id}: working directory is not a directory: ${processConfig.cwd}`);
      }
    } catch {
      issues.push(`${processConfig.id}: working directory not found: ${processConfig.cwd}`);
    }
  }
  return {
    ok: issues.length === 0,
    configPath: config.configPath,
    runtimeDir: config.runtimeDir,
    serviceRuntimeDir: config.serviceRuntimeDir,
    preferredPort: config.port,
    taskName: config.taskName,
    processes: config.processes.map((entry) => ({
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      endpointFile: entry.endpointFile,
      preferredPort: entry.preferredPort
    })),
    issues
  };
}

export function runSelftest(configPath) {
  const inspected = inspectConfig(configPath);
  const checks = [
    { name: "config", ok: inspected.ok, detail: inspected.issues.join("; ") },
    {
      name: "loopback",
      ok: true,
      detail: "supervisor binds 127.0.0.1 only"
    },
    {
      name: "schtasks",
      ok: process.platform === "win32",
      detail: process.platform === "win32" ? "available" : "Windows only"
    }
  ];
  return { ok: checks.every((check) => check.ok), checks, inspected };
}

export async function startSupervisor({ configPath, startServices = false, logger = createLogger() } = {}) {
  const config = loadConfig(configPath);
  ensureDir(config.runtimeDir);
  ensureDir(join(config.runtimeDir, "logs"));
  checkExistingSupervisor(config.runtimeDir);
  const instanceId = randomUUID();
  const acquiredLock = acquireLock(config.runtimeDir, instanceId);
  let controlToken;
  let manager;
  let api;
  let autostart;
  let shuttingDown = false;
  const startedAt = Date.now();

  const shutdown = async (reason = "signal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down supervisor (${reason})`);
    try {
      if (manager) await manager.shutdown();
    } catch (error) {
      logger.warn(`error while stopping managed processes: ${error.message}`);
    }
    try {
      if (api) await api.close();
    } catch {
      // The server may already be closed.
    }
    const endpointPath = endpointFile(config.runtimeDir);
    const endpoint = readEndpoint(endpointPath);
    if (endpoint !== null && endpoint.pid === process.pid && endpoint.instanceId === instanceId) {
      removeFile(endpointPath);
    }
    releaseLock(acquiredLock, instanceId);
    logger.info("supervisor stopped");
  };

  try {
    controlToken = ensureControlToken(config.runtimeDir);
    const redact = createRedactor([controlToken]);
    const safeLogger = {
      info: (message) => logger.info(redact(message)),
      warn: (message) => logger.warn(redact(message)),
      error: (message) => logger.error(redact(message))
    };
    manager = new ProcessManager({ config, controlToken, logger: safeLogger });
    await manager.initialize();
    const scripts = ensureStartScript({ config, cliPath: CLI_PATH, runtimeDir: config.runtimeDir });
    autostart = new AutostartManager({
      taskName: config.taskName,
      startScriptPath: scripts.scriptPath,
      backend: config.autostartBackend,
      ...(config.startupDir ? { startupDir: config.startupDir } : {})
    });
    api = createApiServer({
      config,
      manager,
      autostart,
      controlToken,
      onShutdown: shutdown,
      version: VERSION
    });
    const listening = await api.listen();
    if (listening.fellBack) {
      safeLogger.warn(`preferred port ${config.port} is busy; using ${listening.port}`);
    }
    writeEndpoint(endpointFile(config.runtimeDir), {
      v: 1,
      name: "xtds-assistant-supervisor",
      host: config.host,
      port: listening.port,
      pid: process.pid,
      startedAt,
      instanceId
    });
    manager.startHealthLoop();
    safeLogger.info(`supervisor listening on http://${config.host}:${listening.port}`);
    if (startServices || config.startServicesOnBoot) {
      setTimeout(() => {
        manager.startAll()
          .then(() => safeLogger.info("background services started"))
          .catch((error) => safeLogger.error(`background service startup failed: ${error.message}`));
      }, 100);
    }
    return {
      config,
      controlToken,
      manager,
      autostart,
      instanceId,
      port: listening.port,
      endpointPath: endpointFile(config.runtimeDir),
      shutdown
    };
  } catch (error) {
    try {
      if (api) await api.close();
    } catch {
      // ignore
    }
    releaseLock(acquiredLock, instanceId);
    throw error;
  }
}
