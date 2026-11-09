import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = resolve(here, "../bin/supervisor.js");
export const DUMMY_PATH = resolve(here, "fixtures/dummy-service.js");

export function createHarness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xtds-supervisor-test-"));
  const runtimeDir = join(dir, "runtime");
  const serviceRuntimeDir = join(dir, "services");
  const startupDir = join(dir, "Startup");
  mkdirSync(serviceRuntimeDir, { recursive: true });
  const ids = ["ds-memory", "qq-gateway"];
  const endpoints = Object.fromEntries(ids.map((id) => [id, join(serviceRuntimeDir, `${id}.endpoint.json`)]));
  const countFiles = Object.fromEntries(ids.map((id) => [id, join(dir, `${id}.count`)]));
  const healthFiles = Object.fromEntries(ids.map((id) => [id, join(dir, `${id}.health.json`)]));
  const services = ids.map((id) => ({
    id,
    label: id,
    cwd: dir,
    command: process.execPath,
    args: [
      DUMMY_PATH,
      "--name",
      id,
      "--endpoint",
      endpoints[id],
      "--count-file",
      countFiles[id],
      "--health-file",
      healthFiles[id]
    ],
    endpointFile: endpoints[id],
    host: "127.0.0.1",
    preferredPort: 0,
    healthPath: "/health",
    healthRequireOnline: id === "qq-gateway",
    env: {
      TEST_SECRET: "secret-value-for-redaction"
    },
    ...(id === "qq-gateway" ? { dependsOn: "ds-memory" } : {})
  }));
  for (const service of services) {
    if (overrides[service.id]?.args) service.args = overrides[service.id].args;
    if (overrides[service.id]?.env) service.env = { ...service.env, ...overrides[service.id].env };
  }
  const config = {
    host: "127.0.0.1",
    port: 0,
    runtimeDir,
    serviceRuntimeDir,
    taskName: `XTDS-Assistant-Test-${Math.random().toString(16).slice(2, 10)}`,
    autostartBackend: "startup",
    startupDir,
    startServicesOnBoot: false,
    readinessTimeoutMs: 6000,
    stopTimeoutMs: 5000,
    healthIntervalMs: 500,
    healthTimeoutMs: 800,
    nodePath: process.execPath,
    processes: services
  };
  const configPath = join(dir, "supervisor.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    dir,
    configPath,
    runtimeDir,
    serviceRuntimeDir,
    startupDir,
    endpoints,
    countFiles,
    healthFiles,
    config,
    cleanup: () => rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100
    })
  };
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export async function waitFor(predicate, timeoutMs = 10000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for condition${lastError ? `: ${lastError.message}` : ""}`);
}

export function waitForExit(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error("child exit timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export async function spawnSupervisor(harness, extraArgs = [], options = {}) {
  const child = spawn(process.execPath, [CLI_PATH, "--config", harness.configPath, ...extraArgs], {
    cwd: harness.dir,
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const endpointPath = join(harness.runtimeDir, "supervisor.endpoint.json");
  try {
    await waitFor(() => existsSync(endpointPath), 12000);
  } catch (error) {
    throw new Error(`supervisor did not start: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const endpoint = readJson(endpointPath);
  const tokenConfig = readJson(join(harness.runtimeDir, "config.json"));
  return {
    child,
    endpoint,
    endpointPath,
    runtimeDir: harness.runtimeDir,
    token: tokenConfig.controlToken,
    baseUrl: `http://127.0.0.1:${endpoint.port}`,
    output: () => ({ stdout, stderr })
  };
}

export async function api(supervisor, path, { method = "GET", body, token = supervisor.token } = {}) {
  const headers = { accept: "application/json" };
  if (typeof token === "string" && token.length > 0) headers["x-xtds-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${supervisor.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

export async function shutdownSupervisor(supervisor) {
  if (supervisor.child.exitCode !== null) return;
  try {
    await api(supervisor, "/api/shutdown", { method: "POST" });
  } catch {
    // If the API is already down, fall back to terminating the supervisor.
    supervisor.child.kill();
  }
  await waitForExit(supervisor.child, 30000);
  await waitFor(() => !existsSync(supervisor.endpointPath), 5000).catch(() => {});
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killPid(pid) {
  if (!pid || !isPidAlive(pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      child.once("exit", resolve);
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
