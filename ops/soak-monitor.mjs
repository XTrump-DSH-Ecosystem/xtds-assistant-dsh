import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_PROCESS_IDS = Object.freeze(["ds-memory", "qq-gateway"]);

const DEFAULT_DURATION_MINUTES = 1440;
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3000;
const REDACTED = "[REDACTED]";
const LOOPBACK_ENDPOINT_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function repoRoot() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value) {
  return Number.isInteger(value);
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeText(value, secrets = [], paths = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join(REDACTED);
    }
  }
  for (const filePath of paths) {
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    text = text.split(filePath).join("<path>");
    text = text.split(filePath.replaceAll("\\", "/")).join("<path>");
  }
  text = text.replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, "<path>");
  return text;
}

function safeJson(value, secrets = []) {
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join(REDACTED);
    }
  }
  return text;
}

function safeErrorCode(error) {
  if (typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)) {
    return error.code;
  }
  return null;
}

function networkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  const code = safeErrorCode(error);
  return code === null ? "request failed" : `request failed (${code})`;
}

function fsError(label, error) {
  const code = safeErrorCode(error);
  return code === null ? `${label} unavailable` : `${label} unavailable (${code})`;
}

function readJsonFile(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`${label}: ${fsError("file", error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

function validateEndpoint(value) {
  if (!isObject(value)) throw new Error("supervisor endpoint: invalid JSON shape");
  if (typeof value.host !== "string" || value.host.length === 0) {
    throw new Error("supervisor endpoint: host is missing");
  }
  if (!LOOPBACK_ENDPOINT_HOSTS.has(value.host)) {
    throw new Error("supervisor endpoint: host must be loopback");
  }
  if (!isInteger(value.port) || value.port <= 0 || value.port > 65535) {
    throw new Error("supervisor endpoint: port is invalid");
  }
  if (!isInteger(value.pid) || value.pid <= 0) {
    throw new Error("supervisor endpoint: pid is invalid");
  }
  return value;
}

function validateControlToken(value) {
  if (!isObject(value) || typeof value.controlToken !== "string" || value.controlToken.length === 0) {
    throw new Error("runtime config: controlToken is missing");
  }
  return value.controlToken;
}

function urlHost(host) {
  if (host.startsWith("[") || !host.includes(":")) return host;
  return `[${host}]`;
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      ...options,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return {
      response,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      response: null,
      durationMs: Date.now() - startedAt,
      error: networkError(error)
    };
  }
}

function isPositivePid(value) {
  return isInteger(value) && value > 0;
}

function normalizePid(value) {
  return isPositivePid(value) ? value : null;
}

function normalizePort(value) {
  return isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

function normalizeUptime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : "unknown";
}

function directoryStats(dirPath) {
  const status = lstatSync(dirPath);
  if (!status.isDirectory()) throw new Error("not a directory");
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(dirPath)) {
    const filePath = join(dirPath, name);
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const nested = directoryStats(filePath);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += entry.size;
      files += 1;
    }
  }
  return { bytes, files };
}

function collectDirectoryMetrics(dirPath, label, errors, required) {
  if (!existsSync(dirPath)) {
    if (required) errors.push(`${label}: directory not found`);
    return { bytes: 0, files: 0 };
  }
  try {
    return directoryStats(dirPath);
  } catch (error) {
    errors.push(`${label}: ${fsError("directory", error)}`);
    return { bytes: 0, files: 0 };
  }
}

async function probeServiceHealth({ host, port, healthPath, timeoutMs, fetchImpl }) {
  const startedAt = Date.now();
  const result = await fetchWithTimeout(
    `http://${urlHost(host)}:${port}${healthPath}`,
    { method: "GET", headers: { accept: "application/json" } },
    timeoutMs,
    fetchImpl
  );
  if (result.response === null) {
    return {
      ok: false,
      status: 0,
      durationMs: result.durationMs,
      error: result.error
    };
  }
  try {
    await result.response.body?.cancel();
  } catch {
    // The status code is sufficient for a health sample.
  }
  return {
    ok: result.response.ok,
    status: result.response.status,
    durationMs: result.durationMs
  };
}

function emptyProcessSnapshot(id) {
  return {
    id,
    state: "unknown",
    health: "unknown",
    pid: null,
    port: null,
    uptimeMs: 0,
    healthResponse: {
      ok: false,
      status: 0,
      durationMs: 0,
      error: "not observed"
    }
  };
}

export async function collectSample({
  endpoint,
  controlToken,
  processIds = DEFAULT_PROCESS_IDS,
  stateDir,
  logDir,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  fetchImpl = fetch
}) {
  const errors = [];
  const sample = {
    timestamp: new Date().toISOString(),
    supervisor: {
      ok: false,
      httpStatus: 0,
      durationMs: 0,
      pid: null,
      port: normalizePort(endpoint.port),
      uptimeMs: 0
    },
    processes: {},
    stateBytes: 0,
    stateFiles: 0,
    logBytes: 0,
    logFiles: 0,
    errors
  };

  const statusResult = await fetchWithTimeout(
    `http://${urlHost(endpoint.host)}:${endpoint.port}/api/status`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-xtds-token": controlToken
      }
    },
    Math.max(healthTimeoutMs, 1000),
    fetchImpl
  );
  sample.supervisor.durationMs = statusResult.durationMs;

  let statusPayload = null;
  if (statusResult.response === null) {
    sample.supervisor.httpStatus = 0;
    errors.push(`supervisor: ${statusResult.error}`);
  } else {
    sample.supervisor.httpStatus = statusResult.response.status;
    if (!statusResult.response.ok) {
      errors.push(`supervisor: HTTP ${statusResult.response.status}`);
      try {
        await statusResult.response.body?.cancel();
      } catch {
        // Nothing else is needed from this response.
      }
    } else {
      try {
        const text = await statusResult.response.text();
        statusPayload = JSON.parse(text);
      } catch {
        errors.push("supervisor: invalid JSON response");
      }
    }
  }

  let rawProcesses = [];
  if (isObject(statusPayload)) {
    if (statusPayload.ok === true) sample.supervisor.ok = true;
    if (isObject(statusPayload.supervisor)) {
      sample.supervisor.pid = normalizePid(statusPayload.supervisor.pid);
      sample.supervisor.port = normalizePort(statusPayload.supervisor.port) ?? sample.supervisor.port;
      sample.supervisor.uptimeMs = normalizeUptime(statusPayload.supervisor.uptimeMs);
    }
    if (Array.isArray(statusPayload.processes)) {
      rawProcesses = statusPayload.processes;
    } else {
      errors.push("supervisor: processes array is missing");
    }
  } else if (statusPayload !== null) {
    errors.push("supervisor: invalid status response");
  }

  const rawById = new Map();
  for (const entry of rawProcesses) {
    if (isObject(entry) && typeof entry.id === "string") rawById.set(entry.id, entry);
  }

  const healthHost = endpoint.host;
  const healthChecks = processIds.map(async (id) => {
    const raw = rawById.get(id);
    const processSample = emptyProcessSnapshot(id);
    if (isObject(raw)) {
      processSample.state = normalizeLabel(raw.state);
      processSample.health = normalizeLabel(raw.health);
      processSample.pid = normalizePid(raw.pid);
      processSample.port = normalizePort(raw.port);
      processSample.uptimeMs = normalizeUptime(raw.uptimeMs);
    } else if (statusPayload !== null) {
      errors.push(`${id}: status entry missing`);
    }
    if (processSample.port !== null) {
      processSample.healthResponse = await probeServiceHealth({
        host: healthHost,
        port: processSample.port,
        healthPath: "/health",
        timeoutMs: healthTimeoutMs,
        fetchImpl
      });
    }
    return [id, processSample];
  });
  const checked = await Promise.all(healthChecks);
  for (const [id, processSample] of checked) {
    sample.processes[id] = processSample;
  }

  const stateMetrics = collectDirectoryMetrics(stateDir, "state", errors, true);
  sample.stateBytes = stateMetrics.bytes;
  sample.stateFiles = stateMetrics.files;
  const logMetrics = collectDirectoryMetrics(logDir, "logs", errors, false);
  sample.logBytes = logMetrics.bytes;
  sample.logFiles = logMetrics.files;

  sample.unhealthy = !sample.supervisor.ok || processIds.some((id) => {
    const processSample = sample.processes[id];
    return processSample === undefined
      || processSample.health !== "healthy"
      || !isPositivePid(processSample.pid)
      || processSample.healthResponse?.ok !== true;
  });
  return sample;
}

function sampleIsUnhealthy(sample, processIds) {
  if (sample?.unhealthy === true) return true;
  if (sample?.supervisor?.ok !== true) return true;
  if (processIds.some((id) => {
    const processSample = sample?.processes?.[id];
    return processSample === undefined
      || processSample.health !== "healthy"
      || !isPositivePid(processSample.pid)
      || processSample.healthResponse?.ok !== true;
  })) return true;
  return false;
}

export function buildSummary({
  runId,
  startedAt,
  finishedAt,
  samples,
  processIds = DEFAULT_PROCESS_IDS,
  interrupted = false,
  durationMinutes,
  intervalMs
}) {
  const pidChanges = Object.fromEntries(processIds.map((id) => [id, 0]));
  const lastPid = new Map();
  let unhealthySamples = 0;
  let errorSamples = 0;
  let maxStateBytes = 0;
  let maxLogBytes = 0;

  for (const sample of samples) {
    if (sampleIsUnhealthy(sample, processIds)) unhealthySamples += 1;
    if (Array.isArray(sample?.errors) && sample.errors.length > 0) errorSamples += 1;
    if (typeof sample?.stateBytes === "number" && sample.stateBytes > maxStateBytes) {
      maxStateBytes = sample.stateBytes;
    }
    if (typeof sample?.logBytes === "number" && sample.logBytes > maxLogBytes) {
      maxLogBytes = sample.logBytes;
    }
    for (const id of processIds) {
      const pid = normalizePid(sample?.processes?.[id]?.pid);
      if (!lastPid.has(id)) {
        lastPid.set(id, pid);
        continue;
      }
      if (lastPid.get(id) !== pid) {
        pidChanges[id] += 1;
        lastPid.set(id, pid);
      }
    }
  }

  const pass = samples.length > 0
    && !interrupted
    && unhealthySamples === 0
    && errorSamples === 0
    && processIds.every((id) => samples.every((sample) => isPositivePid(sample?.processes?.[id]?.pid)))
    && processIds.every((id) => pidChanges[id] === 0);

  return {
    version: 1,
    runId,
    startedAt,
    finishedAt,
    durationMinutes,
    intervalMs,
    samples: samples.length,
    unhealthySamples,
    errorSamples,
    pidChanges,
    maxStateBytes,
    maxLogBytes,
    interrupted,
    pass
  };
}

async function waitForNextSample(ms, signal) {
  if (signal?.aborted) return false;
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createRunDirectory(outDir) {
  mkdirSync(outDir, { recursive: true });
  const base = `${safeTimestamp()}-${process.pid}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${attempt}`;
    const candidate = join(outDir, name);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a unique soak run directory");
}

function writeTextFile(filePath, content, flag = "w") {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600, flag });
}

function writeJsonAtomic(filePath, value, secrets) {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  try {
    writeTextFile(tempPath, `${safeJson(value, secrets)}\n`);
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export async function runSoakMonitor({
  endpointFile,
  configFile,
  outDir,
  durationMinutes = DEFAULT_DURATION_MINUTES,
  intervalMs = DEFAULT_INTERVAL_MS,
  once = false,
  stateDir,
  logDir,
  processIds = DEFAULT_PROCESS_IDS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  signal,
  fetchImpl = fetch,
  durationMs
}) {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error("durationMinutes must be greater than zero");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("intervalMs must be a positive integer");
  }
  if (!Array.isArray(processIds) || processIds.length === 0) {
    throw new Error("processIds must not be empty");
  }

  const endpoint = validateEndpoint(readJsonFile(endpointFile, "supervisor endpoint"));
  const controlToken = validateControlToken(readJsonFile(configFile, "runtime config"));
  const startedDate = new Date();
  const startedAt = startedDate.toISOString();
  const runDir = createRunDirectory(outDir);
  const runId = basename(runDir);
  const samples = [];
  const samplePath = join(runDir, "samples.jsonl");
  const effectiveDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : durationMinutes * 60000;

  writeTextFile(join(runDir, "run.json"), `${safeJson({
    version: 1,
    runId,
    startedAt,
    monitorPid: process.pid,
    mode: once ? "once" : "duration",
    durationMinutes,
    intervalMs,
    processIds,
    supervisorPid: endpoint.pid,
    supervisorPort: endpoint.port
  }, [controlToken])}\n`);
  writeTextFile(samplePath, "");

  const loopStartedAt = Date.now();
  let interrupted = false;
  while (true) {
    if (signal?.aborted) {
      interrupted = true;
      break;
    }
    const sample = await collectSample({
      endpoint,
      controlToken,
      processIds,
      stateDir,
      logDir,
      healthTimeoutMs,
      fetchImpl
    });
    samples.push(sample);
    appendFileSync(samplePath, `${safeJson(sample, [controlToken])}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    if (signal?.aborted) interrupted = true;
    if (once || interrupted) break;
    const elapsedMs = Date.now() - loopStartedAt;
    if (elapsedMs >= effectiveDurationMs) break;
    const remainingMs = effectiveDurationMs - elapsedMs;
    const completed = await waitForNextSample(Math.min(intervalMs, remainingMs), signal);
    if (!completed) {
      interrupted = true;
      break;
    }
  }

  const summary = buildSummary({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    samples,
    processIds,
    interrupted,
    durationMinutes,
    intervalMs
  });
  writeJsonAtomic(join(runDir, "summary.json"), summary, [controlToken]);
  return { runDir, summary, samples, interrupted };
}

function parseNumber(value, label, { integer = false, min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} >= ${min}`);
  }
  return parsed;
}

export function parseSoakArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "duration-minutes": { type: "string" },
      "interval-ms": { type: "string" },
      out: { type: "string" },
      once: { type: "boolean", default: false },
      "state-dir": { type: "string" },
      "log-dir": { type: "string" },
      "runtime-dir": { type: "string" },
      "health-timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false }
    }
  });

  if (values.help) return { help: true };

  const root = repoRoot();
  const runtimeDir = values["runtime-dir"] === undefined
    ? join(root, "runtime")
    : resolve(values["runtime-dir"]);
  let durationMinutes = DEFAULT_DURATION_MINUTES;
  if (values["duration-minutes"] !== undefined) {
    durationMinutes = Number(values["duration-minutes"]);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      throw new Error("--duration-minutes must be greater than zero");
    }
  }
  const intervalMs = values["interval-ms"] === undefined
    ? DEFAULT_INTERVAL_MS
    : parseNumber(values["interval-ms"], "--interval-ms", { integer: true, min: 1 });
  const healthTimeoutMs = values["health-timeout-ms"] === undefined
    ? DEFAULT_HEALTH_TIMEOUT_MS
    : parseNumber(values["health-timeout-ms"], "--health-timeout-ms", { integer: true, min: 100 });

  return {
    help: false,
    root,
    endpointFile: join(runtimeDir, "supervisor.endpoint.json"),
    configFile: join(runtimeDir, "config.json"),
    outDir: values.out === undefined ? join(runtimeDir, "soak") : resolve(values.out),
    durationMinutes,
    intervalMs,
    healthTimeoutMs,
    once: values.once,
    stateDir: values["state-dir"] === undefined
      ? resolve(root, "../ds-memory/state")
      : resolve(values["state-dir"]),
    logDir: values["log-dir"] === undefined
      ? join(runtimeDir, "logs")
      : resolve(values["log-dir"])
  };
}

function usage() {
  return [
    "Usage: node ops/soak-monitor.mjs [options]",
    "",
    "Read-only supervisor soak monitor.",
    "  --duration-minutes <n>  Total duration, default 1440",
    "  --interval-ms <n>       Sampling interval, default 60000",
    "  --out <dir>             Output root, default runtime/soak",
    "  --once                  Collect one sample and exit",
    "  --state-dir <dir>       ds-memory state directory",
    "  --log-dir <dir>         Supervisor log directory",
    "  --runtime-dir <dir>     Directory containing runtime JSON files",
    "  --health-timeout-ms <n> Per-request timeout, default 3000"
  ].join("\n");
}

function displayPath(filePath) {
  const shown = relative(process.cwd(), filePath);
  return isAbsolute(shown) ? basename(filePath) : shown || ".";
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  let signalExitCode = 0;
  const onSignal = () => {
    signalExitCode = 130;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const options = parseSoakArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    const result = await runSoakMonitor({
      endpointFile: options.endpointFile,
      configFile: options.configFile,
      outDir: options.outDir,
      durationMinutes: options.durationMinutes,
      intervalMs: options.intervalMs,
      once: options.once,
      stateDir: options.stateDir,
      logDir: options.logDir,
      healthTimeoutMs: options.healthTimeoutMs,
      signal: controller.signal
    });
    process.stdout.write(
      `soak samples=${result.summary.samples} unhealthy=${result.summary.unhealthySamples} `
      + `errors=${result.summary.errorSamples} pass=${result.summary.pass}\n`
    );
    process.stdout.write(`output=${displayPath(result.runDir)}\n`);
    if (result.interrupted || signalExitCode === 130) process.exitCode = 130;
    else if (!result.summary.pass) process.exitCode = 2;
    else process.exitCode = 0;
    return result;
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : error);
    process.stderr.write(`soak monitor failed: ${message}\n`);
    process.exitCode = signalExitCode === 130 ? 130 : 1;
    return null;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
