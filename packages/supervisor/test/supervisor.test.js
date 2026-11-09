import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../lib/config.js";
import { MAX_HEALTH_BODY_BYTES } from "../lib/endpoint.js";
import { ProcessManager } from "../lib/process-manager.js";
import { createLineRedactor } from "../lib/redact.js";
import { RotatingLogWriter } from "../lib/rotating-log.js";
import {
  api,
  createHarness,
  DUMMY_PATH,
  isPidAlive,
  killPid,
  shutdownSupervisor,
  spawnSupervisor,
  waitFor,
  waitForExit
} from "./helpers.js";

const CHATTY_PATH = join(import.meta.dirname, "fixtures/chatty-service.js");
const LATE_STDOUT_PATH = join(import.meta.dirname, "fixtures/late-stdout-service.js");
const SPAWNING_PATH = join(import.meta.dirname, "fixtures/spawning-service.js");

test("status API requires the local control token", async (t) => {
  const harness = createHarness();
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const missing = await api(supervisor, "/api/status", { token: null });
  assert.equal(missing.status, 401);
  const wrong = await api(supervisor, "/api/status", { token: "wrong-token" });
  assert.equal(wrong.status, 401);
  const ok = await api(supervisor, "/api/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.processes.length, 2);
  assert.equal(ok.data.processes[0].state, "stopped");
  assert.equal(ok.data.processes[0].online, null);
  assert.equal(ok.data.processes[0].healthDetail, null);
  assert.equal(JSON.stringify(supervisor.endpoint).includes(supervisor.token), false);
  assert.equal(readFileSync(supervisor.endpointPath, "utf8").includes(supervisor.token), false);
});

test("endpointPid=any adopts an endpoint published by a launcher child", async (t) => {
  const harness = createHarness();
  const memory = harness.config.processes.find((entry) => entry.id === "ds-memory");
  memory.args = [
    SPAWNING_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"],
    "--count-file",
    harness.countFiles["ds-memory"],
    "--health-file",
    harness.healthFiles["ds-memory"]
  ];
  memory.endpointPid = "any";
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));

  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.process.state, "running");
  assert.equal(started.data.process.health, "healthy");
  assert.ok(started.data.process.port > 0);

  const endpoint = JSON.parse(readFileSync(harness.endpoints["ds-memory"], "utf8"));
  assert.equal(isPidAlive(endpoint.pid), true);
  assert.notEqual(endpoint.pid, started.data.process.pid);

  const stopped = await api(supervisor, "/api/processes/ds-memory/stop", { method: "POST" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.process.state, "stopped");
});

test("duplicate supervisor start is rejected", async (t) => {
  const harness = createHarness();
  const first = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(first);
    harness.cleanup();
  });

  const { spawn } = await import("node:child_process");
  const duplicate = spawn(process.execPath, [join(import.meta.dirname, "../bin/supervisor.js"), "--config", harness.configPath], {
    cwd: harness.dir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  duplicate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = await waitForExit(duplicate, 10000);
  assert.equal(exit.code, 3, stderr);
  const status = await api(first, "/api/status");
  assert.equal(status.status, 200);
});

test("autostart API creates, reports, and deletes the Startup entry", async (t) => {
  const harness = createHarness();
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const before = await api(supervisor, "/api/autostart");
  assert.equal(before.status, 200);
  assert.equal(before.data.autostart.enabled, false);
  assert.equal(before.data.autostart.backend, "startup");

  const enabled = await api(supervisor, "/api/autostart", {
    method: "PUT",
    body: { enabled: true }
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.autostart.enabled, true);
  assert.equal(existsSync(enabled.data.autostart.path), true);
  const script = readFileSync(enabled.data.autostart.path, "utf8");
  assert.match(script, /start-supervisor\.cmd/);

  const disabled = await api(supervisor, "/api/autostart", {
    method: "PUT",
    body: { enabled: false }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.autostart.enabled, false);
  assert.equal(existsSync(enabled.data.autostart.path), false);
});

test("lifecycle start stop restart is independent and logs are redacted", async (t) => {
  const harness = createHarness();
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const startedMemory = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(startedMemory.status, 200, JSON.stringify(startedMemory.data));
  assert.equal(startedMemory.data.process.state, "running");
  assert.equal(startedMemory.data.process.health, "healthy");
  assert.ok(startedMemory.data.process.pid > 0);

  const startedGateway = await api(supervisor, "/api/processes/qq-gateway/start", { method: "POST" });
  assert.equal(startedGateway.status, 200, JSON.stringify(startedGateway.data));
  assert.equal(startedGateway.data.process.state, "running");
  const gatewayPid = startedGateway.data.process.pid;
  const logPath = join(harness.runtimeDir, "logs", "qq-gateway.log");
  assert.equal(startedGateway.data.process.logPath, logPath);

  const stoppedMemory = await api(supervisor, "/api/processes/ds-memory/stop", { method: "POST" });
  assert.equal(stoppedMemory.status, 200);
  assert.equal(stoppedMemory.data.process.state, "stopped");

  const afterStop = await api(supervisor, "/api/status");
  const gateway = afterStop.data.processes.find((entry) => entry.id === "qq-gateway");
  const memory = afterStop.data.processes.find((entry) => entry.id === "ds-memory");
  assert.equal(gateway.state, "running");
  assert.equal(gateway.pid, gatewayPid);
  assert.equal(memory.state, "stopped");

  const restarted = await api(supervisor, "/api/processes/qq-gateway/restart", { method: "POST" });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.data));
  assert.equal(restarted.data.process.state, "running");
  assert.notEqual(restarted.data.process.pid, gatewayPid);
  assert.equal(restarted.data.process.logPath, logPath);

  await waitFor(() => existsSync(logPath), 3000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const log = readFileSync(logPath, "utf8");
  assert.equal(log.includes("secret-value-for-redaction"), false);
  assert.ok(log.includes("[REDACTED]"));
});

test("qq-gateway starts offline and reports degraded, healthy, then malformed health", async (t) => {
  const harness = createHarness();
  const marker = "HEALTH-BODY-MUST-NOT-LEAK";
  const healthFile = harness.healthFiles["qq-gateway"];
  const writeHealth = (value) => writeFileSync(healthFile, JSON.stringify(value));
  writeHealth({
    status: 200,
    body: { name: "qq-gateway", ok: true, online: false, marker }
  });

  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/qq-gateway/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.process.state, "running");
  assert.equal(started.data.process.health, "degraded");
  assert.equal(started.data.process.online, false);
  assert.equal(started.data.process.healthDetail, "onebot_offline");
  assert.equal(JSON.stringify(started.data).includes(marker), false);

  writeHealth({
    status: 200,
    body: { name: "qq-gateway", ok: true, online: true, marker }
  });
  const healthy = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.health === "healthy" ? { entry, body: status.data } : null;
  }, 5000);
  assert.equal(healthy.entry.online, true);
  assert.equal(healthy.entry.healthDetail, null);

  writeHealth({
    status: 200,
    body: { name: "qq-gateway", ok: true, online: false, marker }
  });
  const offlineAgain = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.health === "degraded" && entry.healthDetail === "onebot_offline" ? entry : null;
  }, 5000);
  assert.equal(offlineAgain.online, false);

  writeHealth({ status: 200, body: { name: "qq-gateway", ok: true, marker } });
  const missing = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.healthDetail === "online_missing" ? entry : null;
  }, 5000);
  assert.equal(missing.health, "degraded");
  assert.equal(missing.online, null);

  writeHealth({ status: 200, raw: `{"online":true,"padding":"${"x".repeat(MAX_HEALTH_BODY_BYTES)}"}` });
  const oversized = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.healthDetail === "health_invalid" ? entry : null;
  }, 5000);
  assert.equal(oversized.health, "degraded");
  assert.equal(oversized.online, null);

  writeHealth({ status: 200, raw: `{"online":"${marker}"` });
  const invalid = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.healthDetail === "health_invalid" ? { entry, body: status.data } : null;
  }, 5000);
  assert.equal(invalid.entry.health, "degraded");
  assert.equal(invalid.entry.online, null);
  assert.equal(JSON.stringify(invalid.body).includes(marker), false);

  writeHealth({ status: 503, body: { ok: false, marker } });
  const unavailable = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.health === "unhealthy" ? { entry, body: status.data } : null;
  }, 5000);
  assert.equal(unavailable.entry.state, "running");
  assert.equal(unavailable.entry.online, null);
  assert.equal(unavailable.entry.healthDetail, null);
  assert.equal(JSON.stringify(unavailable.body).includes(marker), false);
  assert.equal(supervisor.output().stdout.includes(marker), false);
  assert.equal(supervisor.output().stderr.includes(marker), false);
});

test("managed service output rotates without losing lines or changing the active log path", async (t) => {
  const harness = createHarness();
  const memory = harness.config.processes.find((entry) => entry.id === "ds-memory");
  memory.args = [
    CHATTY_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"],
    "--count-file",
    harness.countFiles["ds-memory"],
    "--lines",
    "30",
    "--line-size",
    "240",
    "--stderr-lines",
    "5"
  ];
  harness.config.logMaxBytes = 1024;
  harness.config.logMaxFiles = 15;
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const logPath = join(harness.runtimeDir, "logs", "ds-memory.log");
  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.process.state, "running");
  assert.equal(started.data.process.health, "healthy");
  assert.equal(started.data.process.logPath, logPath);

  const archivePattern = /^ds-memory\.log\.\d{12}-\d{13}-\d+-[0-9a-f]{8}\.archive$/;
  const readLogs = () => {
    const logDir = join(harness.runtimeDir, "logs");
    const archives = readdirSync(logDir)
      .filter((name) => archivePattern.test(name))
      .sort()
      .map((name) => join(logDir, name));
    return {
      archives,
      text: [...archives, logPath]
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, "utf8"))
        .join("")
    };
  };
  const expectedStdout = Array.from(
    { length: 30 },
    (_, index) => `chatty-line-${String(index).padStart(3, "0")}-`
  );
  const expectedStderr = Array.from(
    { length: 5 },
    (_, index) => `[stderr] chatty-err-${String(index).padStart(3, "0")}-`
  );
  const logs = await waitFor(() => {
    const current = readLogs();
    const complete = [...expectedStdout, ...expectedStderr].every((line) => current.text.includes(line));
    return complete && current.archives.length > 0 ? current : null;
  }, 10000);

  assert.ok(logs.archives.length > 0);
  assert.equal(logs.text.includes("secret-value-for-redaction"), false);
  for (const line of [...expectedStdout, ...expectedStderr]) {
    assert.equal(logs.text.split(line).length - 1, 1, line);
  }
  const status = await api(supervisor, "/api/status");
  const memoryStatus = status.data.processes.find((entry) => entry.id === "ds-memory");
  assert.equal(memoryStatus.state, "running");
  assert.equal(memoryStatus.health, "healthy");
  assert.equal(memoryStatus.logPath, logPath);
});

test("late descendant stdout after parent exit is written before close", async (t) => {
  const harness = createHarness();
  const memory = harness.config.processes.find((entry) => entry.id === "ds-memory");
  memory.args = [
    LATE_STDOUT_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"],
    "--spawn-grandchild-ms",
    "800",
    "--grandchild-delay-ms",
    "900",
    "--exit-after-ms",
    "1200"
  ];
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "ds-memory");
    return entry.state === "failed" ? entry : null;
  }, 5000);

  const logPath = join(harness.runtimeDir, "logs", "ds-memory.log");
  const log = await waitFor(() => {
    if (!existsSync(logPath)) return null;
    const text = readFileSync(logPath, "utf8");
    return text.includes("LATE-GRANDCHILD-LINE") ? text : null;
  }, 5000);
  assert.equal(log.split("LATE-GRANDCHILD-LINE").length - 1, 1);
});

test("shutdown drains late descendant stdout before closing the writer", async (t) => {
  const harness = createHarness();
  const memory = harness.config.processes.find((entry) => entry.id === "ds-memory");
  memory.args = [
    LATE_STDOUT_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"],
    "--manual-exit",
    "--grandchild-delay-ms",
    "2000"
  ];
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const endpoint = JSON.parse(readFileSync(harness.endpoints["ds-memory"], "utf8"));
  const exitResponse = await fetch(`http://127.0.0.1:${endpoint.port}/exit`);
  assert.equal(exitResponse.status, 200);
  await exitResponse.text();
  await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "ds-memory");
    return entry.state === "failed" ? entry : null;
  }, 5000);

  const stopped = await api(supervisor, "/api/processes/ds-memory/stop", { method: "POST" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  await shutdownSupervisor(supervisor);
  assert.equal(supervisor.output().stdout.includes("log session drain timed out"), false);

  const logDir = join(harness.runtimeDir, "logs");
  const logPath = join(logDir, "ds-memory.log");
  const archivePattern = /^ds-memory\.log\.\d{12}-\d{13}-\d+-[0-9a-f]{8}\.archive$/;
  const text = readdirSync(logDir)
    .filter((name) => name === "ds-memory.log" || archivePattern.test(name))
    .sort()
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("");
  assert.equal(existsSync(logPath), true);
  assert.equal(text.split("LATE-GRANDCHILD-LINE").length - 1, 1);
});

test("one log writer is reused across managed stop and start", async (t) => {
  const harness = createHarness();
  const config = loadConfig(harness.configPath);
  const logger = { info() {}, warn() {}, error() {} };
  const manager = new ProcessManager({
    config,
    controlToken: "test-control-token-1234567890",
    logger
  });
  t.after(async () => {
    await manager.shutdown();
    harness.cleanup();
  });

  await manager.start("ds-memory");
  const record = manager.records.get("ds-memory");
  const writer = record.logWriter;
  assert.ok(writer);

  await manager.stop("ds-memory");
  assert.equal(record.logWriter, writer);

  await manager.start("ds-memory");
  assert.equal(record.logWriter, writer);

  await manager.stop("ds-memory");
  assert.equal(record.logWriter, writer);
});

test("synchronous spawn failure preserves older unclosed log sessions", async (t) => {
  const harness = createHarness();
  const base = loadConfig(harness.configPath);
  const processConfig = base.processes.find((entry) => entry.id === "ds-memory");
  const config = {
    ...base,
    processes: [{ ...processConfig, command: null }]
  };
  const manager = new ProcessManager({
    config,
    controlToken: "test-control-token-1234567890",
    logger: { info() {}, warn() {}, error() {} }
  });
  const record = manager.records.get("ds-memory");
  const logDir = join(harness.runtimeDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const writer = new RotatingLogWriter({
    filePath: join(logDir, "ds-memory.log"),
    maxBytes: 1024,
    maxFiles: 2
  });
  const oldOutput = [];
  const oldStdoutLog = createLineRedactor({
    onLine: (text) => {
      oldOutput.push(text);
      writer.append(text);
    }
  });
  oldStdoutLog.push("old-session-tail");
  const oldSession = {
    child: null,
    closed: false,
    stdoutLog: oldStdoutLog,
    stderrLog: null
  };
  record.logWriter = writer;
  record.logSessions.add(oldSession);
  t.after(async () => {
    await manager.shutdown();
    harness.cleanup();
  });

  await assert.rejects(manager.start("ds-memory"));

  assert.equal(record.logWriter, writer);
  assert.equal(writer.closed, false);
  assert.equal(oldSession.closed, false);
  assert.equal(record.logSessions.has(oldSession), true);
  assert.equal(record.logSessions.size, 1);
  assert.deepEqual(oldOutput, []);

  await manager.shutdown();
  assert.deepEqual(oldOutput, ["old-session-tail"]);
});

test("log session drain warns with service id and remaining count on timeout", async (t) => {
  const harness = createHarness();
  const config = loadConfig(harness.configPath);
  const warnings = [];
  const manager = new ProcessManager({
    config,
    controlToken: "test-control-token-1234567890",
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {}
    }
  });
  const record = manager.records.get("ds-memory");
  const session = {
    child: null,
    closed: false,
    closedPromise: new Promise(() => {}),
    stdoutLog: null,
    stderrLog: null
  };
  record.logSessions.add(session);
  t.after(async () => {
    await manager.shutdown();
    harness.cleanup();
  });

  const result = await manager.drainLogSessions(20);

  assert.equal(result.timedOut, true);
  assert.deepEqual(result.remaining, [{ id: "ds-memory", count: 1 }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ds-memory/);
  assert.match(warnings[0], /1 session/);

  session.closed = true;
  record.logSessions.delete(session);
});

test("shutdown drains and cleans up before rethrowing a stop error", async (t) => {
  const harness = createHarness();
  const config = loadConfig(harness.configPath);
  const manager = new ProcessManager({
    config,
    controlToken: "test-control-token-1234567890",
    logger: { info() {}, warn() {}, error() {} }
  });
  const record = manager.records.get("ds-memory");
  const logDir = join(harness.runtimeDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const writer = new RotatingLogWriter({
    filePath: join(logDir, "ds-memory.log"),
    maxBytes: 1024,
    maxFiles: 2
  });
  record.logWriter = writer;
  let drainCalled = false;
  manager.stopAllManaged = async () => {
    throw new Error("stop failed");
  };
  manager.drainLogSessions = async () => {
    drainCalled = true;
    return { timedOut: false, remaining: [] };
  };
  t.after(async () => {
    await manager.shutdown();
    harness.cleanup();
  });

  await assert.rejects(manager.shutdown(), /stop failed/);

  assert.equal(drainCalled, true);
  assert.equal(writer.closed, true);
  assert.equal(record.logWriter, null);
});

test("log directory creation failure does not block service start", async (t) => {
  const harness = createHarness();
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const logDir = join(harness.runtimeDir, "logs");
  rmSync(logDir, { recursive: true, force: true });
  writeFileSync(logDir, "occupied");

  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.process.state, "running");
  assert.equal(statSync(logDir).isFile(), true);
  await waitFor(() => supervisor.output().stdout.includes("log write failed for ds-memory"), 3000);
});

test("--start-services starts ds-memory before qq-gateway", async (t) => {
  const harness = createHarness();
  const supervisor = await spawnSupervisor(harness, ["--start-services"]);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const running = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const processes = status.data.processes;
    return processes.every((entry) => entry.state === "running") ? processes : null;
  }, 8000);
  assert.equal(running[0].id, "ds-memory");
  assert.equal(running[1].id, "qq-gateway");
  const memoryTimes = readFileSync(harness.countFiles["ds-memory"], "utf8").trim().split(/\r?\n/).map(Number);
  const gatewayTimes = readFileSync(harness.countFiles["qq-gateway"], "utf8").trim().split(/\r?\n/).map(Number);
  assert.ok(Math.min(...memoryTimes) <= Math.min(...gatewayTimes));
});

test("startServicesOnBoot skips an external service and starts the remaining one", async (t) => {
  const harness = createHarness();
  harness.config.startServicesOnBoot = true;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const { spawn } = await import("node:child_process");
  const external = spawn(process.execPath, [
    DUMMY_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"]
  ], {
    cwd: harness.dir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitFor(() => existsSync(harness.endpoints["ds-memory"]), 5000);
  const externalPid = JSON.parse(readFileSync(harness.endpoints["ds-memory"], "utf8")).pid;
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    await killPid(external.pid);
    harness.cleanup();
  });

  const gateway = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "qq-gateway");
    return entry.state === "running" ? entry : null;
  }, 10000);
  const memory = (await api(supervisor, "/api/status")).data.processes.find((item) => item.id === "ds-memory");
  assert.equal(gateway.state, "running");
  assert.equal(memory.state, "external");
  assert.equal(memory.pid, externalPid);
  assert.equal(isPidAlive(externalPid), true);
});

test("start failure enters failed and does not auto restart", async (t) => {
  const harness = createHarness({
    "qq-gateway": {
      args: [DUMMY_PATH, "--fail-exit", "3"]
    }
  });
  // Replace the count path with the real harness path after construction.
  harness.config.processes.find((entry) => entry.id === "qq-gateway").args = [
    DUMMY_PATH,
    "--fail-exit",
    "3",
    "--count-file",
    harness.countFiles["qq-gateway"]
  ];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/qq-gateway/start", { method: "POST" });
  assert.equal(started.status, 500, JSON.stringify(started.data));
  const status = await api(supervisor, "/api/status");
  const gateway = status.data.processes.find((entry) => entry.id === "qq-gateway");
  assert.equal(gateway.state, "failed");
  assert.equal(gateway.pid, null);
  assert.match(gateway.lastError, /exited unexpectedly|failed to start/);
  const count = readFileSync(harness.countFiles["qq-gateway"], "utf8").trim().split(/\r?\n/).length;
  assert.equal(count, 1);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = await api(supervisor, "/api/status");
  assert.equal(after.data.processes.find((entry) => entry.id === "qq-gateway").pid, null);
  assert.equal(readFileSync(harness.countFiles["qq-gateway"], "utf8").trim().split(/\r?\n/).length, 1);
});

test("unexpected crash is recorded as failed and not restarted", async (t) => {
  const harness = createHarness();
  const ds = harness.config.processes.find((entry) => entry.id === "ds-memory");
  ds.args = [DUMMY_PATH, "--name", "ds-memory", "--endpoint", harness.endpoints["ds-memory"], "--count-file", harness.countFiles["ds-memory"], "--crash-after-ms", "900"];
  const { writeFileSync } = await import("node:fs");
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    harness.cleanup();
  });

  const started = await api(supervisor, "/api/processes/ds-memory/start", { method: "POST" });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const failed = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    const entry = status.data.processes.find((item) => item.id === "ds-memory");
    return entry.state === "failed" ? entry : null;
  }, 5000);
  assert.equal(failed.pid, null);
  assert.equal(failed.lastExit.code, 23);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const count = readFileSync(harness.countFiles["ds-memory"], "utf8").trim().split(/\r?\n/).length;
  assert.equal(count, 1);
});

test("existing instances are external and stop returns 409", async (t) => {
  const harness = createHarness();
  const { spawn } = await import("node:child_process");
  const external = spawn(process.execPath, [
    DUMMY_PATH,
    "--name",
    "ds-memory",
    "--endpoint",
    harness.endpoints["ds-memory"]
  ], {
    cwd: harness.dir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let externalLog = "";
  external.stdout.on("data", (chunk) => { externalLog += chunk.toString(); });
  await waitFor(() => existsSync(harness.endpoints["ds-memory"]), 5000);
  const externalEndpoint = JSON.parse(readFileSync(harness.endpoints["ds-memory"], "utf8"));
  const supervisor = await spawnSupervisor(harness);
  t.after(async () => {
    await shutdownSupervisor(supervisor);
    await killPid(external.pid);
    harness.cleanup();
  });

  const status = await api(supervisor, "/api/status");
  const memory = status.data.processes.find((entry) => entry.id === "ds-memory");
  assert.equal(memory.state, "external");
  assert.equal(memory.external, true);
  assert.equal(memory.pid, externalEndpoint.pid);
  assert.equal(memory.health, "healthy", externalLog);
  const stopped = await api(supervisor, "/api/processes/ds-memory/stop", { method: "POST" });
  assert.equal(stopped.status, 409);
  assert.match(stopped.data.error, /external/i);
  await shutdownSupervisor(supervisor);
  assert.equal(isPidAlive(external.pid), true);
});

test("start-all skips external instances found through fallback path expansion", async (t) => {
  const harness = createHarness();
  const profileDir = join(harness.dir, "profile");
  const serviceDir = join(profileDir, "AppData", "Local", "DSH", "runtime");
  mkdirSync(serviceDir, { recursive: true });
  const externalEndpoints = {};
  for (const processConfig of harness.config.processes) {
    externalEndpoints[processConfig.id] = join(serviceDir, `${processConfig.id}.endpoint.json`);
    processConfig.endpointFile = `%LOCALAPPDATA%/DSH/runtime/${processConfig.id}.endpoint.json`;
  }
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));

  const { spawn } = await import("node:child_process");
  const externals = [];
  let supervisor;
  t.after(async () => {
    if (supervisor) await shutdownSupervisor(supervisor);
    for (const external of externals) await killPid(external.pid);
    harness.cleanup();
  });

  for (const id of ["ds-memory", "qq-gateway"]) {
    const external = spawn(process.execPath, [
      DUMMY_PATH,
      "--name",
      id,
      "--endpoint",
      externalEndpoints[id],
      "--count-file",
      harness.countFiles[id]
    ], {
      cwd: harness.dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    externals.push(external);
    await waitFor(() => existsSync(externalEndpoints[id]), 5000);
  }

  const childEnv = { ...process.env, USERPROFILE: profileDir };
  delete childEnv.LOCALAPPDATA;
  supervisor = await spawnSupervisor(harness, ["--start-services"], { env: childEnv });

  const entries = await waitFor(async () => {
    const status = await api(supervisor, "/api/status");
    return status.data.processes.every((entry) => entry.state === "external" && entry.health === "healthy")
      ? status.data.processes
      : null;
  }, 8000);
  for (const entry of entries) {
    const external = externals.find((child) => child.pid === entry.pid);
    assert.ok(external, `unexpected external PID ${entry.pid}`);
    assert.equal(entry.external, true);
    assert.equal(entry.managed, false);
  }

  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const entry of entries) {
    const spawnCount = readFileSync(harness.countFiles[entry.id], "utf8").trim().split(/\r?\n/).length;
    assert.equal(spawnCount, 1);
    const external = externals.find((child) => child.pid === entry.pid);
    assert.equal(isPidAlive(external.pid), true);
  }
});
