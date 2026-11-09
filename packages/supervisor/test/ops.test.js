import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSummary, runSoakMonitor } from "../../../ops/soak-monitor.mjs";
import {
  createBackup,
  formatBackupError,
  restoreBackup,
  verifyBackup
} from "../../../ops/backup-state.mjs";

const SOAK_CLI = join(import.meta.dirname, "../../../ops/soak-monitor.mjs");
const BACKUP_CLI = join(import.meta.dirname, "../../../ops/backup-state.mjs");

function tempDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function removeDirectoryLink(linkPath) {
  try {
    lstatSync(linkPath);
  } catch {
    return;
  }
  try {
    unlinkSync(linkPath);
  } catch {
    try {
      rmdirSync(linkPath);
    } catch {
      // Cleanup is best-effort; tests still report the creation failure.
    }
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function runNode(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: import.meta.dirname,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      reject(new Error("child CLI timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function createServiceHealthServer(initialStatus) {
  let statusCode = initialStatus;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({ ok: statusCode === 200, private: "PRIVATE SERVICE BODY" });
      res.writeHead(statusCode, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  return {
    port,
    setStatus: (value) => {
      statusCode = value;
    },
    close: () => closeServer(server)
  };
}

async function createSoakFixture({ token, serviceHealth = {} } = {}) {
  const root = tempDirectory("xtds-ops-soak-");
  const runtimeDir = join(root, "runtime");
  const stateDir = join(root, "state");
  const logDir = join(runtimeDir, "logs");
  const outDir = join(root, "soak");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(stateDir, "memory", "events"), { recursive: true });
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(stateDir, "memory", "events", "2026-11.jsonl"), "{\"event\":1}\n");
  writeFileSync(join(stateDir, "sessions", "private.json"), "{\"summary\":\"private\"}\n");
  writeFileSync(join(logDir, "ds-memory.log"), "log line\n");
  writeFileSync(join(logDir, "qq-gateway.log"), "log line\n");

  const controlToken = token ?? `ops-soak-secret-${Date.now()}-${Math.random()}`;
  const services = {
    "ds-memory": await createServiceHealthServer(serviceHealth["ds-memory"] ?? 200),
    "qq-gateway": await createServiceHealthServer(serviceHealth["qq-gateway"] ?? 200)
  };
  const processes = {
    "ds-memory": {
      id: "ds-memory",
      state: "running",
      health: "healthy",
      pid: 41001,
      uptimeMs: 12345
    },
    "qq-gateway": {
      id: "qq-gateway",
      state: "running",
      health: "healthy",
      pid: 41002,
      uptimeMs: 23456
    }
  };
  let supervisorStatusCode = 200;
  let supervisorApiOk = true;
  const supervisorServer = createServer((req, res) => {
    if (req.url !== "/api/status" || req.method !== "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers["x-xtds-token"] !== controlToken) {
      const body = JSON.stringify({ ok: false, error: "unauthorized" });
      res.writeHead(401, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }
    const entries = ["ds-memory", "qq-gateway"].map((id) => ({
      ...processes[id],
      port: services[id].port
    }));
    const body = JSON.stringify({
      ok: supervisorApiOk,
      supervisor: {
        pid: process.pid,
        port: 986,
        uptimeMs: 34567
      },
      processes: entries
    });
    res.writeHead(supervisorStatusCode, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  });
  const supervisorPort = await listen(supervisorServer);

  writeJson(join(runtimeDir, "supervisor.endpoint.json"), {
    v: 1,
    name: "xtds-assistant-supervisor",
    host: "127.0.0.1",
    port: supervisorPort,
    pid: 41000,
    startedAt: Date.now(),
    instanceId: "ops-test"
  });
  writeJson(join(runtimeDir, "config.json"), {
    version: 1,
    controlToken,
    createdAt: new Date().toISOString()
  });

  return {
    root,
    runtimeDir,
    stateDir,
    logDir,
    outDir,
    token: controlToken,
    services,
    processes,
    setSupervisorFailure(statusCode, apiOk = false) {
      supervisorStatusCode = statusCode;
      supervisorApiOk = apiOk;
    },
    async cleanup() {
      await closeServer(supervisorServer);
      await Promise.all(Object.values(services).map((service) => service.close()));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function createUnavailableSoakFixture() {
  const root = tempDirectory("xtds-ops-soak-unavailable-");
  const runtimeDir = join(root, "runtime");
  const stateDir = join(root, "state");
  const logDir = join(runtimeDir, "logs");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const endpointServer = createServer();
  const port = await listen(endpointServer);
  await closeServer(endpointServer);
  writeJson(join(runtimeDir, "supervisor.endpoint.json"), {
    v: 1,
    name: "xtds-assistant-supervisor",
    host: "127.0.0.1",
    port,
    pid: 42000,
    startedAt: Date.now(),
    instanceId: "ops-unavailable"
  });
  writeJson(join(runtimeDir, "config.json"), {
    version: 1,
    controlToken: `ops-unavailable-${Date.now()}`,
    createdAt: new Date().toISOString()
  });
  return {
    root,
    runtimeDir,
    stateDir,
    logDir,
    outDir: join(root, "soak"),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function soakCliArgs(fixture) {
  return [
    SOAK_CLI,
    "--once",
    "--runtime-dir",
    fixture.runtimeDir,
    "--out",
    fixture.outDir,
    "--state-dir",
    fixture.stateDir,
    "--log-dir",
    fixture.logDir,
    "--health-timeout-ms",
    "300"
  ];
}

function soakOptions(fixture) {
  return {
    endpointFile: join(fixture.runtimeDir, "supervisor.endpoint.json"),
    configFile: join(fixture.runtimeDir, "config.json"),
    outDir: fixture.outDir,
    stateDir: fixture.stateDir,
    logDir: fixture.logDir,
    healthTimeoutMs: 1000,
    once: true
  };
}

function readRunOutput(runDir) {
  return ["run.json", "samples.jsonl", "summary.json"]
    .map((name) => readFileSync(join(runDir, name), "utf8"))
    .join("\n");
}

function healthySample({ memoryPid = 100, gatewayPid = 200, stateBytes = 10, logBytes = 20 } = {}) {
  return {
    timestamp: new Date().toISOString(),
    supervisor: { ok: true },
    processes: {
      "ds-memory": {
        state: "running",
        health: "healthy",
        pid: memoryPid,
        healthResponse: { ok: true, status: 200 }
      },
      "qq-gateway": {
        state: "running",
        health: "healthy",
        pid: gatewayPid,
        healthResponse: { ok: true, status: 200 }
      }
    },
    stateBytes,
    logBytes,
    errors: [],
    unhealthy: false
  };
}

async function createBackupFixture() {
  const root = tempDirectory("xtds-ops-backup-");
  const source = join(root, "state");
  mkdirSync(join(source, "memory", "events"), { recursive: true });
  mkdirSync(join(source, "sessions"), { recursive: true });
  writeFileSync(join(source, "root.json"), "{\"root\":true}\n");
  writeFileSync(join(source, "memory", "events", "2026-11.jsonl"), "{\"event\":1}\n");
  writeFileSync(join(source, "sessions", "private.json"), "{\"summary\":\"private\"}\n");
  writeFileSync(join(source, "ds-memory.lock"), "{\"pid\":1}\n");
  writeFileSync(join(source, "root.json.tmp"), "partial\n");
  writeFileSync(join(source, "~$session.json"), "temporary\n");
  const backup = join(root, "backup");
  const drillRoot = join(root, "drill");
  const created = await createBackup({ source, dest: backup, drillRoot });
  return { root, source, backup, drillRoot, created };
}

async function createNestedBackupFixture() {
  const root = tempDirectory("xtds-ops-backup-nested-");
  const work = join(root, "work");
  const sourceParent = join(work, "live");
  const source = join(sourceParent, "state");
  const store = join(root, "store");
  const backup = join(store, "backup");
  mkdirSync(join(source, "sessions"), { recursive: true });
  writeFileSync(join(source, "sessions", "private.json"), "{\"summary\":\"private\"}\n");
  writeFileSync(join(sourceParent, "keep-parent.txt"), "keep parent\n");
  writeFileSync(join(work, "keep-ancestor.txt"), "keep ancestor\n");
  const drillRoot = join(root, "drill");
  await createBackup({ source, dest: backup, drillRoot });
  writeFileSync(join(store, "keep-backup-parent.txt"), "keep backup parent\n");
  return { root, work, sourceParent, source, store, backup, drillRoot };
}

test("soak --once records healthy services without leaking token or paths", async (t) => {
  const fixture = await createSoakFixture();
  t.after(() => fixture.cleanup());

  const result = await runSoakMonitor(soakOptions(fixture));
  assert.equal(result.summary.pass, true);
  assert.equal(result.summary.samples, 1);
  assert.equal(result.summary.unhealthySamples, 0);
  assert.equal(result.summary.pidChanges["ds-memory"], 0);
  assert.equal(result.summary.pidChanges["qq-gateway"], 0);
  assert.equal(result.samples[0].processes["ds-memory"].state, "running");
  assert.equal(result.samples[0].processes["ds-memory"].health, "healthy");
  assert.equal(result.samples[0].processes["ds-memory"].healthResponse.status, 200);
  assert.equal(result.samples[0].supervisor.ok, true);
  assert.ok(result.samples[0].stateBytes > 0);
  assert.ok(result.samples[0].stateFiles >= 2);
  assert.ok(result.samples[0].logBytes > 0);

  const output = readRunOutput(result.runDir);
  assert.equal(output.includes(fixture.token), false);
  assert.equal(output.includes(fixture.root), false);
  assert.equal(output.includes("PRIVATE SERVICE BODY"), false);
  assert.deepEqual(
    readdirSync(result.runDir).sort(),
    ["run.json", "samples.jsonl", "summary.json"]
  );
});

test("soak records failed service health and marks the sample unhealthy", async (t) => {
  const fixture = await createSoakFixture({ serviceHealth: { "qq-gateway": 503 } });
  t.after(() => fixture.cleanup());

  const result = await runSoakMonitor(soakOptions(fixture));
  assert.equal(result.summary.pass, false);
  assert.equal(result.summary.unhealthySamples, 1);
  assert.equal(result.samples[0].processes["qq-gateway"].healthResponse.status, 503);
  assert.equal(result.samples[0].processes["qq-gateway"].healthResponse.ok, false);
  assert.equal(result.samples[0].unhealthy, true);
});

test("soak CLI exits 2 when a completed sample does not pass", async (t) => {
  const fixture = await createSoakFixture({ serviceHealth: { "qq-gateway": 503 } });
  t.after(() => fixture.cleanup());

  const run = await runNode(soakCliArgs(fixture));
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stdout, /pass=false/);
  assert.equal(`${run.stdout}${run.stderr}`.includes(fixture.token), false);
});

test("soak CLI exits 2 when the supervisor is unreachable", async (t) => {
  const fixture = await createUnavailableSoakFixture();
  t.after(() => fixture.cleanup());

  const run = await runNode(soakCliArgs(fixture));
  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stdout, /unhealthy=1/);
  assert.match(run.stdout, /pass=false/);
  const runDir = join(fixture.outDir, readdirSync(fixture.outDir)[0]);
  const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
  assert.equal(summary.pass, false);
});

test("soak errors stay redacted when supervisor authentication fails", async (t) => {
  const fixture = await createSoakFixture();
  t.after(() => fixture.cleanup());
  writeJson(join(fixture.runtimeDir, "config.json"), {
    version: 1,
    controlToken: `${fixture.token}-wrong`,
    createdAt: new Date().toISOString()
  });

  const result = await runSoakMonitor(soakOptions(fixture));
  const output = readRunOutput(result.runDir);
  assert.equal(result.summary.pass, false);
  assert.equal(result.samples[0].supervisor.httpStatus, 401);
  assert.equal(output.includes(fixture.token), false);
  assert.match(output, /HTTP 401/);
});

test("soak writes an interrupted summary after cancellation", async (t) => {
  const fixture = await createSoakFixture();
  t.after(() => fixture.cleanup());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);

  const result = await runSoakMonitor({
    ...soakOptions(fixture),
    once: false,
    intervalMs: 1000,
    durationMs: 60000,
    signal: controller.signal
  });
  clearTimeout(timer);

  assert.equal(result.interrupted, true);
  assert.ok(result.samples.length >= 1);
  assert.equal(result.summary.interrupted, true);
  assert.equal(result.summary.pass, false);
  assert.equal(existsSync(join(result.runDir, "summary.json")), true);
  assert.equal(existsSync(join(result.runDir, "samples.jsonl")), true);
});

test("summary tracks PID transitions after establishing a baseline", () => {
  const stable = buildSummary({
    runId: "stable",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    samples: [healthySample(), healthySample()],
    durationMinutes: 1,
    intervalMs: 1000
  });
  assert.deepEqual(stable.pidChanges, { "ds-memory": 0, "qq-gateway": 0 });
  assert.equal(stable.pass, true);

  const changed = buildSummary({
    runId: "changed",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    samples: [
      healthySample({ memoryPid: 100 }),
      healthySample({ memoryPid: 200, stateBytes: 30 }),
      healthySample({ memoryPid: 200 }),
      healthySample({ memoryPid: 300, logBytes: 50 })
    ],
    durationMinutes: 1,
    intervalMs: 1000
  });
  assert.deepEqual(changed.pidChanges, { "ds-memory": 2, "qq-gateway": 0 });
  assert.equal(changed.maxStateBytes, 30);
  assert.equal(changed.maxLogBytes, 50);
  assert.equal(changed.pass, false);
});

test("summary never passes when either service PID is missing", () => {
  const allMissing = buildSummary({
    runId: "missing-pids",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    samples: [
      healthySample({ memoryPid: null, gatewayPid: null }),
      healthySample({ memoryPid: null, gatewayPid: null })
    ],
    durationMinutes: 1,
    intervalMs: 1000
  });
  assert.deepEqual(allMissing.pidChanges, { "ds-memory": 0, "qq-gateway": 0 });
  assert.equal(allMissing.unhealthySamples, 2);
  assert.equal(allMissing.pass, false);

  const oneMissing = buildSummary({
    runId: "missing-one-pid",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    samples: [healthySample({ gatewayPid: null })],
    durationMinutes: 1,
    intervalMs: 1000
  });
  assert.equal(oneMissing.pass, false);
});

test("backup create/verify/restore round trip excludes locks and temporary files", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const manifestText = readFileSync(join(fixture.backup, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.source, "state");
  assert.equal(manifest.source.includes(fixture.root), false);
  assert.equal(manifestText.includes(fixture.root), false);
  assert.match(manifest.sourcePathHash, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.sourceAncestorPathHashes));
  assert.ok(manifest.sourceAncestorPathHashes.length > 0);
  assert.ok(manifest.sourceAncestorPathHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ["memory/events/2026-11.jsonl", "root.json", "sessions/private.json"]
  );
  assert.equal(manifest.files.some((entry) => entry.path.endsWith(".lock")), false);
  assert.equal(manifest.files.some((entry) => entry.path.endsWith(".tmp")), false);
  assert.equal(manifest.files.some((entry) => entry.path.includes("~$")), false);

  const verified = await verifyBackup(fixture.backup);
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.errors, []);

  const target = join(fixture.drillRoot, "restore");
  const restored = await restoreBackup({
    backup: fixture.backup,
    target,
    drillRoot: fixture.drillRoot
  });
  assert.equal(restored.filesRestored, 3);
  assert.equal(readFileSync(join(target, "root.json"), "utf8"), "{\"root\":true}\n");
  assert.equal(
    readFileSync(join(target, "sessions", "private.json"), "utf8"),
    "{\"summary\":\"private\"}\n"
  );
  assert.equal(existsSync(join(target, "ds-memory.lock")), false);
  assert.equal(existsSync(join(target, "manifest.json")), false);
  assert.deepEqual(listFiles(target), [
    "memory/events/2026-11.jsonl",
    "root.json",
    "sessions/private.json"
  ]);
});

test("backup verify fails closed when source path proof is missing", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = join(fixture.backup, "manifest.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));

  for (const field of ["sourcePathHash", "sourceAncestorPathHashes"]) {
    const broken = { ...original };
    delete broken[field];
    writeJson(manifestPath, broken);
    await assert.rejects(() => verifyBackup(fixture.backup), new RegExp(field));
    await assert.rejects(
      () => restoreBackup({
        backup: fixture.backup,
        target: join(fixture.drillRoot, `restore-${field}`),
        drillRoot: fixture.drillRoot
      }),
      new RegExp(field)
    );
  }

  writeJson(manifestPath, { ...original, sourceAncestorPathHashes: [] });
  await assert.rejects(() => verifyBackup(fixture.backup), /must not be empty/);
  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: join(fixture.drillRoot, "restore-empty-ancestors"),
      drillRoot: fixture.drillRoot
    }),
    /must not be empty/
  );
});

test("backup verify rejects case-insensitive duplicate paths on Windows", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = join(fixture.backup, "manifest.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  const first = original.files[0];
  const duplicate = {
    ...original,
    files: [first, { ...first, path: first.path.toUpperCase() }],
    totalFiles: 2,
    totalBytes: first.bytes * 2
  };
  writeJson(manifestPath, duplicate);

  await assert.rejects(() => verifyBackup(fixture.backup), /duplicate file paths/);
});

test("backup verify rejects version 1 and a self-referential ancestor proof", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = join(fixture.backup, "manifest.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  const target = join(fixture.drillRoot, "restore");

  writeJson(manifestPath, { ...original, version: 1 });
  await assert.rejects(() => verifyBackup(fixture.backup), /version 2/);
  await assert.rejects(
    () => restoreBackup({ backup: fixture.backup, target, drillRoot: fixture.drillRoot }),
    /version 2/
  );

  writeJson(manifestPath, {
    ...original,
    sourceAncestorPathHashes: [original.sourcePathHash]
  });
  await assert.rejects(
    () => verifyBackup(fixture.backup),
    /sourceAncestorPathHashes must not contain sourcePathHash/
  );
  await assert.rejects(
    () => restoreBackup({ backup: fixture.backup, target, drillRoot: fixture.drillRoot }),
    /sourceAncestorPathHashes must not contain sourcePathHash/
  );
});

test("backup verify detects tampering and missing manifests", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const original = readFileSync(join(fixture.backup, "root.json"), "utf8");
  writeFileSync(join(fixture.backup, "root.json"), original.replace("true", "fals"));
  const tampered = await verifyBackup(fixture.backup);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.errors.some((message) => message.includes("sha256 mismatch: root.json")));

  rmSync(join(fixture.backup, "manifest.json"));
  await assert.rejects(
    () => verifyBackup(fixture.backup),
    /manifest\.json is missing/
  );
  writeFileSync(join(fixture.backup, "manifest.json"), "{broken");
  await assert.rejects(
    () => verifyBackup(fixture.backup),
    /manifest\.json is not valid JSON/
  );
});

function listFiles(root) {
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, relativePath);
      else files.push(relativePath);
    }
  };
  walk(root);
  return files.sort();
}

test("backup verify warns about extra files without failing", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(join(fixture.backup, "extra.txt"), "extra\n");

  const verified = await verifyBackup(fixture.backup);
  assert.equal(verified.ok, true);
  assert.ok(verified.warnings.some((message) => message.includes("extra file present: extra.txt")));
});

test("restore enforces non-empty targets and the drill-root boundary", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const nonEmpty = join(fixture.drillRoot, "non-empty");
  mkdirSync(nonEmpty, { recursive: true });
  writeFileSync(join(nonEmpty, "keep.txt"), "keep\n");
  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: nonEmpty,
      drillRoot: fixture.drillRoot
    }),
    /target is not empty/
  );
  assert.equal(readFileSync(join(nonEmpty, "keep.txt"), "utf8"), "keep\n");

  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: join(fixture.source, "inside"),
      drillRoot: fixture.drillRoot
    }),
    /drill root/
  );
  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: fixture.source,
      drillRoot: fixture.drillRoot
    }),
    /drill root/
  );
  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: join(fixture.backup, "inside"),
      drillRoot: fixture.drillRoot
    }),
    /drill root/
  );

  await restoreBackup({
    backup: fixture.backup,
    target: nonEmpty,
    force: true,
    drillRoot: fixture.drillRoot
  });
  assert.equal(existsSync(join(nonEmpty, "keep.txt")), false);
  assert.equal(readFileSync(join(nonEmpty, "root.json"), "utf8"), "{\"root\":true}\n");
});

test("restore rejects source and backup parents outside the drill root with force", async (t) => {
  const fixture = await createNestedBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const cases = [
    {
      target: fixture.sourceParent,
      marker: join(fixture.sourceParent, "keep-parent.txt"),
      error: /drill root/
    },
    {
      target: fixture.work,
      marker: join(fixture.work, "keep-ancestor.txt"),
      error: /drill root/
    },
    {
      target: fixture.store,
      marker: join(fixture.store, "keep-backup-parent.txt"),
      error: /drill root/
    }
  ];

  for (const entry of cases) {
    await assert.rejects(
      () => restoreBackup({
        backup: fixture.backup,
        target: entry.target,
        force: true,
        drillRoot: fixture.drillRoot
      }),
      entry.error
    );
    assert.equal(readFileSync(entry.marker, "utf8").includes("keep"), true);
    assert.equal(
      readFileSync(join(fixture.source, "sessions", "private.json"), "utf8"),
      "{\"summary\":\"private\"}\n"
    );
    assert.equal(
      readFileSync(join(fixture.backup, "sessions", "private.json"), "utf8"),
      "{\"summary\":\"private\"}\n"
    );
    assert.equal(existsSync(join(fixture.backup, "manifest.json")), true);
  }
});

test("restore requires a strict descendant of the drill root and succeeds inside", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mkdirSync(fixture.drillRoot, { recursive: true });
  writeFileSync(join(fixture.drillRoot, "keep-root.txt"), "keep root\n");

  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: fixture.drillRoot,
      force: true,
      drillRoot: fixture.drillRoot
    }),
    /strict descendant/
  );
  assert.equal(readFileSync(join(fixture.drillRoot, "keep-root.txt"), "utf8"), "keep root\n");

  const target = join(fixture.drillRoot, "inside", "restore");
  await restoreBackup({
    backup: fixture.backup,
    target,
    drillRoot: fixture.drillRoot
  });
  assert.equal(readFileSync(join(target, "root.json"), "utf8"), "{\"root\":true}\n");
  assert.equal(readFileSync(join(fixture.drillRoot, "keep-root.txt"), "utf8"), "keep root\n");
});

test("restore rejects a junction or symlink escaping the drill root", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mkdirSync(fixture.drillRoot, { recursive: true });
  const outside = join(fixture.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep outside\n");
  const escapeLink = join(fixture.drillRoot, "escape");
  try {
    symlinkSync(outside, escapeLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory link creation unavailable: ${error.code ?? error.message}`);
    return;
  }

  try {
    await assert.rejects(
      () => restoreBackup({
        backup: fixture.backup,
        target: join(escapeLink, "restore"),
        force: true,
        drillRoot: fixture.drillRoot
      }),
      /drill root/
    );
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep outside\n");
    assert.equal(
      readFileSync(join(fixture.source, "sessions", "private.json"), "utf8"),
      "{\"summary\":\"private\"}\n"
    );
  } finally {
    removeDirectoryLink(escapeLink);
  }
  assert.equal(existsSync(escapeLink), false);
});

test("restore rejects a drill root that is itself a junction or symlink", async (t) => {
  const fixture = await createBackupFixture();
  const outside = join(fixture.root, "outside-drill");
  const linkedRoot = join(fixture.root, "linked-drill");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep outside\n");
  try {
    symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    rmSync(fixture.root, { recursive: true, force: true });
    t.skip(`directory link creation unavailable: ${error.code ?? error.message}`);
    return;
  }
  t.after(() => {
    removeDirectoryLink(linkedRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => restoreBackup({
      backup: fixture.backup,
      target: join(linkedRoot, "restore"),
      force: true,
      drillRoot: linkedRoot
    }),
    /real directory/
  );
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep outside\n");
});

test("backup create rejects sources overlapping the drill root", async (t) => {
  const root = tempDirectory("xtds-ops-create-boundary-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drillRoot = join(root, "drill");
  const insideSource = join(drillRoot, "state");
  mkdirSync(insideSource, { recursive: true });
  writeFileSync(join(insideSource, "state.json"), "{\"ok\":true}\n");

  const insideDest = join(root, "backup-inside");
  await assert.rejects(
    () => createBackup({ source: insideSource, dest: insideDest, drillRoot }),
    /drill root/
  );
  assert.equal(existsSync(insideDest), false);

  const ancestorDest = join(root, "backup-ancestor");
  await assert.rejects(
    () => createBackup({ source: root, dest: ancestorDest, drillRoot }),
    /drill root/
  );
  assert.equal(existsSync(ancestorDest), false);
});

test("formatBackupError redacts unstructured paths containing quotes", () => {
  const absolutePath = process.platform === "win32"
    ? "C:\\tmp\\o'brien\\private\\state"
    : "/tmp/o'brien/private/state";
  const formatted = formatBackupError(new Error(`synthetic failure at '${absolutePath}'`));
  assert.match(formatted, /E_BACKUP_STATE/);
  assert.match(formatted, /absolute path redacted/);
  assert.equal(formatted.includes("o'brien"), false);
  assert.equal(formatted.includes(absolutePath), false);

  assert.match(
    formatBackupError(new Error("safe validation failure")),
    /safe validation failure/
  );
});

test("backup CLI redacts absolute paths from unexpected errors", async (t) => {
  const root = tempDirectory("xtds-ops-backup-cli-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "state");
  mkdirSync(source);
  writeFileSync(join(source, "state.json"), "{\"ok\":true}\n");
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "blocked\n");
  const dest = join(blocker, "backup");

  const run = await runNode([BACKUP_CLI, "create", "--source", source, "--dest", dest]);
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.code, 1);
  assert.match(run.stderr, /backup-state failed \[[A-Z0-9_]+\]/);
  assert.equal(output.includes(root), false);
});

test("backup CLI has no drill-root override and enforces the built-in boundary", async (t) => {
  const fixture = await createBackupFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const target = join(fixture.root, "cli-restore");

  const overrideRun = await runNode([
    BACKUP_CLI,
    "restore",
    "--backup",
    fixture.backup,
    "--target",
    target,
    "--drill-root",
    fixture.drillRoot
  ]);
  assert.equal(overrideRun.code, 1);
  assert.match(overrideRun.stderr, /--drill-root/);
  assert.equal(existsSync(target), false);

  const outsideRun = await runNode([
    BACKUP_CLI,
    "restore",
    "--backup",
    fixture.backup,
    "--target",
    target,
    "--force"
  ]);
  assert.equal(outsideRun.code, 1);
  assert.match(outsideRun.stderr, /strict descendant of the restore drill root/);
  assert.equal(existsSync(target), false);
});

test("backup create failure leaves no destination or temporary half", async (t) => {
  const root = tempDirectory("xtds-ops-atomic-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "state");
  const dest = join(root, "backup");
  mkdirSync(source);
  writeFileSync(join(source, "state.json"), "{\"ok\":true}\n");

  await assert.rejects(
    () => createBackup({
      source,
      dest,
      hooks: {
        beforeCommit: () => {
          throw new Error("simulated commit failure");
        }
      }
    }),
    /simulated commit failure/
  );
  assert.equal(existsSync(dest), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".backup.tmp-")),
    []
  );
  assert.equal(readFileSync(join(source, "state.json"), "utf8"), "{\"ok\":true}\n");
});
