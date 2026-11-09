import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureDir, readEnvFile, removeFile } from "./fs-utils.js";
import { isPidAlive, probeHealth, readEndpoint, removeEndpointIfOwned, sleep } from "./endpoint.js";
import { createLineRedactor, createRedactor, secretValuesFromEnv } from "./redact.js";
import { RotatingLogWriter } from "./rotating-log.js";
import { ApiError } from "./errors.js";

const execFileAsync = promisify(execFile);
const TASKKILL = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "taskkill.exe")
  : "taskkill.exe";
const LOG_SESSION_DRAIN_TIMEOUT_MS = 5000;

function nowIso() {
  return new Date().toISOString();
}

export function createLogFailureThrottle({ intervalMs = 60000, now = Date.now, warn } = {}) {
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  return {
    failure(error, label) {
      const timestamp = now();
      if (timestamp - lastWarnAt < intervalMs) return;
      lastWarnAt = timestamp;
      try {
        warn(`log write failed for ${label}: ${error?.code ?? error?.name ?? "unknown"}`);
      } catch {}
    }
  };
}

export class ProcessManager {
  constructor({ config, controlToken, logger }) {
    this.config = config;
    this.controlToken = controlToken;
    this.logger = logger;
    this.queues = new Map();
    this.healthTimer = null;
    this.records = new Map();
    this.closed = false;
    for (const processConfig of config.processes) {
      this.records.set(processConfig.id, {
        config: processConfig,
        state: "stopped",
        pid: null,
        port: processConfig.preferredPort || null,
        startedAt: null,
        health: "unknown",
        online: null,
        healthDetail: null,
        lastHealthAt: null,
        external: false,
        managed: false,
        child: null,
        logWriter: null,
        logSessions: new Set(),
        logFailureThrottle: createLogFailureThrottle({
          warn: (message) => this.logger.warn(message)
        }),
        lastError: null,
        lastExit: null,
        instanceId: null,
        stopping: false
      });
    }
  }

  async initialize() {
    await this.refreshAll();
  }

  startHealthLoop() {
    if (this.healthTimer !== null) return;
    this.healthTimer = setInterval(() => {
      this.refreshAll().catch((error) => {
        this.logger.warn(`health refresh failed: ${error.message}`);
      });
    }, this.config.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  async refreshAll() {
    await Promise.all([...this.records.values()].map((record) => this.refreshRecord(record)));
  }

  async refreshRecord(record) {
    if (record.child !== null) {
      const endpoint = this.readServiceEndpoint(record);
      if (this.endpointMatchesManaged(record, endpoint)) {
        if (endpoint.port > 0) record.port = endpoint.port;
        if (Number.isInteger(endpoint.startedAt)) record.startedAt = endpoint.startedAt;
      }
      if (record.state === "running") await this.probe(record);
      return;
    }

    const endpoint = this.readServiceEndpoint(record);
    if (endpoint !== null && endpoint.name === record.config.id && isPidAlive(endpoint.pid) && endpoint.pid !== process.pid) {
      record.external = true;
      record.managed = false;
      if (record.logSessions.size === 0) this.closeRecordLog(record);
      record.state = "external";
      record.pid = endpoint.pid;
      record.port = endpoint.port;
      record.startedAt = Number.isInteger(endpoint.startedAt) ? endpoint.startedAt : null;
      record.instanceId = endpoint.instanceId ?? null;
      await this.probe(record);
      return;
    }

    if (endpoint !== null && endpoint.name === record.config.id && !isPidAlive(endpoint.pid)) {
      removeEndpointIfOwned(record.config.endpointFile, { pid: endpoint.pid, instanceId: endpoint.instanceId });
    }
    if (record.external) {
      record.external = false;
      record.managed = false;
      record.state = "stopped";
      record.pid = null;
      record.port = record.config.preferredPort || null;
      record.startedAt = null;
      record.health = "unknown";
      record.online = null;
      record.healthDetail = null;
      record.lastHealthAt = null;
      record.instanceId = null;
    }
  }

  readServiceEndpoint(record) {
    return readEndpoint(record.config.endpointFile);
  }

  /**
   * 默认要求 endpoint.pid == 受管进程 pid。`endpointPid: "any"` 仅用于
   * launcher 型进程：受管进程自身启动 daemon 子进程并由子进程发布 endpoint。
   * 仍要求 endpoint.name 与进程 id 完全一致，且 pid 活着。
   */
  endpointMatchesManaged(record, endpoint) {
    if (endpoint === null) return false;
    if (endpoint.pid === record.pid) return true;
    return record.config.endpointPid === "any"
      && endpoint.name === record.config.id
      && isPidAlive(endpoint.pid)
      && endpoint.pid !== process.pid;
  }

  async probe(record) {
    const port = record.port || record.config.preferredPort || 0;
    if (!port) {
      record.health = "unknown";
      record.online = null;
      record.healthDetail = null;
      return "unknown";
    }
    await this.probeAt(record, port, this.config.healthTimeoutMs);
    return record.health;
  }

  async probeAt(record, port, timeoutMs) {
    const result = await probeHealth(
      `http://${record.config.host}:${port}${record.config.healthPath}`,
      timeoutMs
    );
    this.applyHealthResult(record, result);
    record.lastHealthAt = nowIso();
    return result;
  }

  applyHealthResult(record, result) {
    if (!result.ok) {
      record.health = "unhealthy";
      record.online = null;
      record.healthDetail = null;
      return;
    }
    record.online = typeof result.online === "boolean" ? result.online : null;
    if (!record.config.healthRequireOnline) {
      record.health = "healthy";
      record.healthDetail = null;
      return;
    }
    if (record.online === true) {
      record.health = "healthy";
      record.healthDetail = null;
      return;
    }
    record.health = "degraded";
    if (record.online === false) {
      record.healthDetail = "onebot_offline";
      return;
    }
    record.healthDetail = result.bodyState === "invalid" || result.bodyState === "too_large"
      ? "health_invalid"
      : "online_missing";
  }

  enqueue(id, operation) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(id, next.catch(() => {}));
    return next;
  }

  getRecord(id) {
    const record = this.records.get(id);
    if (record === undefined) throw new ApiError(404, `unknown process: ${id}`);
    return record;
  }

  start(id) {
    return this.enqueue(id, () => this.startInternal(id));
  }

  stop(id) {
    return this.enqueue(id, () => this.stopInternal(id));
  }

  restart(id) {
    return this.enqueue(id, async () => {
      const record = this.getRecord(id);
      await this.refreshRecord(record);
      if (record.external) {
        throw new ApiError(409, `${id} is an external instance; stop it manually`);
      }
      await this.stopInternal(id);
      return this.startInternal(id);
    });
  }

  async startInternal(id) {
    const record = this.getRecord(id);
    await this.refreshRecord(record);
    if (record.external) {
      throw new ApiError(409, `${id} is already running as an external instance`);
    }
    if (record.child !== null && (record.state === "starting" || record.state === "running")) {
      return this.statusItem(record);
    }
    if (record.state === "stopping") {
      throw new ApiError(409, `${id} is stopping`);
    }
    if (record.pid !== null && record.state === "failed" && isPidAlive(record.pid)) {
      throw new ApiError(409, `${id} still has a live process (pid ${record.pid})`);
    }

    record.state = "starting";
    record.external = false;
    record.managed = true;
    record.stopping = false;
    record.lastError = null;
    record.lastExit = null;
    record.health = "unknown";
    record.online = null;
    record.healthDetail = null;
    record.lastHealthAt = null;
    record.startedAt = Date.now();
    record.instanceId = randomUUID();

    let env;
    try {
      env = { ...process.env, ...(record.config.envFile ? readEnvFile(record.config.envFile) : {}), ...record.config.env };
    } catch (error) {
      record.state = "failed";
      record.managed = false;
      record.lastError = this.redact(error.message);
      throw new ApiError(500, record.lastError);
    }
    const secretValues = [
      this.controlToken,
      ...secretValuesFromEnv(env)
    ];
    const redact = createRedactor(secretValues);
    this.logger.info(`starting ${id}: ${record.config.command} ${record.config.args.join(" ")}`);

    const logDir = join(this.config.runtimeDir, "logs");
    try {
      ensureDir(logDir);
    } catch (error) {
      record.logFailureThrottle.failure(error, id);
    }
    if (record.logWriter === null || record.logWriter.closed) {
      try {
        record.logWriter = new RotatingLogWriter({
          filePath: join(logDir, `${id}.log`),
          maxBytes: this.config.logMaxBytes,
          maxFiles: this.config.logMaxFiles,
          onError: (error) => {
            record.logFailureThrottle.failure(error, id);
          }
        });
      } catch (error) {
        record.logWriter = null;
        record.logFailureThrottle.failure(error, id);
      }
    }
    let resolveClosed = null;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const session = {
      child: null,
      closed: false,
      closedPromise,
      resolveClosed,
      stdoutLog: null,
      stderrLog: null
    };
    const appendLog = (text) => {
      if (session.closed || record.logWriter === null) return false;
      return record.logWriter.append(text);
    };
    const reportStreamError = (error) => {
      record.logFailureThrottle.failure(error, id);
    };
    session.stdoutLog = createLineRedactor({
      redact,
      secretValues,
      onLine: appendLog,
      onError: reportStreamError
    });
    session.stderrLog = createLineRedactor({
      redact,
      secretValues,
      linePrefix: "[stderr] ",
      onLine: appendLog,
      onError: reportStreamError
    });
    record.logSessions.add(session);
    session.stdoutLog.push(`[supervisor] [${nowIso()}] starting ${id}\n`);

    let child;
    try {
      child = spawn(record.config.command, [...record.config.args], {
        cwd: record.config.cwd,
        env,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      record.state = "failed";
      record.managed = false;
      record.lastError = this.redact(error.message);
      this.flushLogSession(record, session);
      record.logSessions.delete(session);
      if (record.logSessions.size === 0) this.closeRecordLog(record);
      throw new ApiError(500, record.lastError);
    }

    record.child = child;
    record.pid = Number.isInteger(child.pid) ? child.pid : null;
    session.child = child;
    child.stdout?.on("data", (chunk) => session.stdoutLog?.push(chunk));
    child.stderr?.on("data", (chunk) => session.stderrLog?.push(chunk));
    child.once("error", (error) => {
      this.handleExit(record, child, null, null, error);
    });
    child.once("exit", (code, signal) => {
      this.handleExit(record, child, code, signal, null);
    });
    child.once("close", () => {
      this.handleClose(record, session);
    });

    const ready = await this.waitUntilReady(record, child);
    if (!ready) {
      if (record.state === "failed") {
        throw new ApiError(500, record.lastError ?? `${id} failed to start`);
      }
      throw new ApiError(504, `${id} did not become healthy within ${this.config.readinessTimeoutMs}ms`);
    }
    return this.statusItem(record);
  }

  async waitUntilReady(record, child) {
    const deadline = Date.now() + this.config.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (record.child !== child || record.state === "failed") return false;
      const endpoint = this.readServiceEndpoint(record);
      if (this.endpointMatchesManaged(record, endpoint) && endpoint.port > 0) {
        record.port = endpoint.port;
        if (Number.isInteger(endpoint.startedAt)) record.startedAt = endpoint.startedAt;
      }
      const port = record.port || record.config.preferredPort || 0;
      if (port > 0) {
        const result = await this.probeAt(
          record,
          port,
          Math.min(this.config.healthTimeoutMs, 1000)
        );
        if (result.ok) {
          record.state = "running";
          record.lastError = null;
          return true;
        }
      }
      await sleep(200);
    }
    if (record.child !== child) return false;
    record.state = "running";
    record.health = "unhealthy";
    record.online = null;
    record.healthDetail = null;
    record.lastHealthAt = nowIso();
    record.lastError = `readiness timeout after ${this.config.readinessTimeoutMs}ms`;
    this.logger.warn(`${record.config.id}: ${record.lastError}`);
    return true;
  }

  handleExit(record, child, code, signal, error) {
    if (record.child !== child) return;
    const wasStopping = record.stopping || record.state === "stopping";
    const pid = record.pid;
    record.child = null;
    record.pid = null;
    record.managed = false;
    record.external = false;
    record.stopping = false;
    record.port = record.config.preferredPort || null;
    record.health = "unknown";
    record.online = null;
    record.healthDetail = null;
    record.lastHealthAt = null;
    record.startedAt = null;
    record.lastExit = {
      code: Number.isInteger(code) ? code : null,
      signal: signal ?? null,
      at: nowIso(),
      error: error ? this.redact(error.message) : null
    };
    if (pid !== null) {
      removeEndpointIfOwned(record.config.endpointFile, { pid });
    }
    record.instanceId = null;
    if (wasStopping) {
      record.state = "stopped";
      record.lastError = null;
      this.logger.info(`${record.config.id} stopped`);
    } else {
      record.state = "failed";
      record.lastError = error
        ? this.redact(`process error: ${error.message}`)
        : `process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.logger.error(`${record.config.id}: ${record.lastError}`);
    }
  }

  async stopInternal(id) {
    const record = this.getRecord(id);
    await this.refreshRecord(record);
    if (record.external) {
      throw new ApiError(409, `${id} is an external instance; stop it manually`);
    }
    if (record.child === null) {
      if (record.state === "failed") {
        record.state = "stopped";
        record.lastError = null;
        record.lastExit = null;
      }
      return this.statusItem(record);
    }

    const child = record.child;
    const pid = record.pid;
    record.stopping = true;
    record.state = "stopping";
    this.logger.info(`stopping ${id} (pid ${pid})`);

    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    if (process.platform === "win32" && pid !== null) {
      try {
        await execFileAsync(TASKKILL, ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10000
        });
      } catch {
        // The process may already have exited.
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    await Promise.race([exited, sleep(this.config.stopTimeoutMs)]);
    if (record.child === child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      await Promise.race([exited, sleep(2000)]);
    }
    if (record.child === child) {
      record.stopping = false;
      record.state = "failed";
      record.lastError = `failed to stop ${id} (pid ${pid})`;
      throw new ApiError(500, record.lastError);
    }
    record.state = "stopped";
    record.lastError = null;
    return this.statusItem(record);
  }

  async startAll() {
    const results = [];
    for (const processConfig of this.config.processes) {
      const record = this.getRecord(processConfig.id);
      await this.refreshRecord(record);
      if (record.external) {
        results.push(this.statusItem(record));
        continue;
      }
      const result = await this.start(processConfig.id);
      results.push(result);
    }
    return results;
  }

  async stopAllManaged() {
    const results = [];
    for (const processConfig of [...this.config.processes].reverse()) {
      const record = this.getRecord(processConfig.id);
      if (record.child === null || record.external) continue;
      results.push(await this.stopInternal(processConfig.id));
    }
    return results;
  }

  statusItem(record) {
    const uptimeMs = Number.isInteger(record.startedAt) ? Math.max(0, Date.now() - record.startedAt) : 0;
    return {
      id: record.config.id,
      label: record.config.label,
      state: record.state,
      pid: record.pid,
      port: record.port,
      health: record.health,
      online: record.online,
      healthDetail: record.healthDetail,
      healthCheckedAt: record.lastHealthAt,
      uptimeMs,
      startedAt: record.startedAt,
      managed: record.managed,
      external: record.external,
      lastError: record.lastError,
      lastExit: record.lastExit,
      logPath: join(this.config.runtimeDir, "logs", `${record.config.id}.log`)
    };
  }

  async status() {
    await this.refreshAll();
    return this.config.processes.map((processConfig) => this.statusItem(this.records.get(processConfig.id)));
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    let stopError = null;
    let drainError = null;
    try {
      await this.stopAllManaged();
    } catch (error) {
      stopError = error;
    }
    try {
      await this.drainLogSessions();
    } catch (error) {
      drainError = error;
      this.logger.warn(`log session drain failed: ${error.message}`);
    } finally {
      for (const record of this.records.values()) {
        this.closeRecordLog(record);
      }
    }
    if (stopError !== null) throw stopError;
    if (drainError !== null) throw drainError;
  }

  async drainLogSessions(timeoutMs = LOG_SESSION_DRAIN_TIMEOUT_MS) {
    const waits = [];
    for (const record of this.records.values()) {
      const sessions = [...record.logSessions]
        .filter((session) => !session.closed && session.closedPromise !== undefined);
      if (sessions.length === 0) continue;
      waits.push(Promise.all(sessions.map((session) => session.closedPromise)));
    }
    if (waits.length === 0) return { timedOut: false, remaining: [] };

    let timer = null;
    let timedOut = false;
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      });
      await Promise.race([Promise.all(waits), timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (!timedOut) return { timedOut: false, remaining: [] };

    const remaining = [];
    for (const record of this.records.values()) {
      const count = [...record.logSessions].filter((session) => !session.closed).length;
      if (count === 0) continue;
      remaining.push({ id: record.config.id, count });
      this.logger.warn(
        `log session drain timed out for ${record.config.id}: ${count} session(s) still open`
      );
    }
    return { timedOut: true, remaining };
  }

  closeRecordLog(record) {
    for (const session of [...record.logSessions]) {
      this.flushLogSession(record, session);
      record.logSessions.delete(session);
    }
    if (record.logWriter !== null) {
      const writer = record.logWriter;
      record.logWriter = null;
      try {
        writer.close();
      } catch (error) {
        record.logFailureThrottle.failure(error, record.config.id);
      }
    }
  }

  flushLogSession(record, session) {
    if (session === null || session.closed) return;
    try {
      for (const stream of [session.stdoutLog, session.stderrLog]) {
        if (stream === null) continue;
        try {
          stream.flush();
        } catch (error) {
          record.logFailureThrottle.failure(error, record.config.id);
        }
      }
    } finally {
      session.closed = true;
      session.stdoutLog = null;
      session.stderrLog = null;
      if (typeof session.resolveClosed === "function") {
        const resolve = session.resolveClosed;
        session.resolveClosed = null;
        resolve();
      }
    }
  }

  handleClose(record, session) {
    this.flushLogSession(record, session);
    record.logSessions.delete(session);
    if (record.external && record.logSessions.size === 0) {
      this.closeRecordLog(record);
    }
  }

  redact(value) {
    return createRedactor([this.controlToken])(value);
  }
}
