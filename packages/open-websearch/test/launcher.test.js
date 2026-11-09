import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEndpoint, isEndpoint } from "../lib/endpoint.js";
import { LauncherError } from "../lib/errors.js";
import {
  DEFAULT_INSTALL_DIR,
  buildChildEnv,
  resolveInstallPaths,
  resolveRuntimeDir,
  validateInstalledPackage
} from "../lib/launcher.js";
import {
  FAKE_ENTRY,
  FAKE_ROOT,
  PACKAGE_ROOT,
  createRuntimeDir,
  endpointPath,
  isPidAlive,
  lockPath,
  readJson,
  readJsonSafe,
  spawnLauncher,
  stopEverything,
  waitFor,
  waitForExit
} from "./helpers.js";

const DEAD_PID = 2147483647;

async function waitForFailure(handle) {
  const result = await waitForExit(handle.child, 15000);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  return { ...result, ...handle.output() };
}

async function startReady(runtimeDir, options = {}) {
  const handle = spawnLauncher(runtimeDir, options);
  try {
    await waitFor(() => existsSync(endpointPath(runtimeDir)), 12000);
    return { handle, endpoint: readJson(endpointPath(runtimeDir)) };
  } catch (error) {
    const output = handle.output();
    throw new Error(`${error.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  }
}

function assertArtifactsGone(runtimeDir) {
  assert.equal(existsSync(endpointPath(runtimeDir)), false);
  assert.equal(existsSync(lockPath(runtimeDir)), false);
}

test("resolveRuntimeDir defaults to LOCALAPPDATA and fails closed without it", () => {
  const localAppData = "C:\\Users\\test\\AppData\\Local";
  assert.equal(
    resolveRuntimeDir(undefined, { LOCALAPPDATA: localAppData }),
    join(localAppData, "DSH", "runtime")
  );
  assert.throws(() => resolveRuntimeDir(undefined, {}), LauncherError);
  const explicit = resolve("custom-runtime");
  assert.equal(resolveRuntimeDir("custom-runtime", {}), explicit);
});

test("resolveInstallPaths derives the package root from the entry", () => {
  const installed = resolveInstallPaths({ installDir: DEFAULT_INSTALL_DIR }, {});
  assert.equal(
    installed.entryPath,
    join(DEFAULT_INSTALL_DIR, "node_modules", "open-websearch", "build", "index.js")
  );
  assert.equal(
    installed.packageRoot,
    join(DEFAULT_INSTALL_DIR, "node_modules", "open-websearch")
  );
  assert.equal(resolveInstallPaths({ entry: FAKE_ENTRY }, {}).packageRoot, FAKE_ROOT);
});

test("validateInstalledPackage enforces name and version", () => {
  assert.deepEqual(validateInstalledPackage(FAKE_ROOT), {
    name: "open-websearch",
    version: "2.2.0"
  });
  const dir = mkdtempSync(join(tmpdir(), "xtds-ows-package-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "open-websearch",
      version: "2.2.1"
    }));
    assert.throws(
      () => validateInstalledPackage(dir),
      (error) => error instanceof LauncherError && error.code === "package_version_mismatch"
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "not-open-websearch",
      version: "2.2.0"
    }));
    assert.throws(
      () => validateInstalledPackage(dir),
      (error) => error instanceof LauncherError && error.code === "package_identity_mismatch"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildChildEnv removes daemon URL and port overrides", () => {
  const env = buildChildEnv({
    OPEN_WEBSEARCH_DAEMON_PORT: "3210",
    OPEN_WEBSEARCH_DAEMON_URL: "http://127.0.0.1:3210",
    KEEP_ME: "yes"
  });
  assert.equal("OPEN_WEBSEARCH_DAEMON_PORT" in env, false);
  assert.equal("OPEN_WEBSEARCH_DAEMON_URL" in env, false);
  assert.equal(env.KEEP_ME, "yes");
});

test("buildChildEnv forces safe daemon env and strips mixed-case overrides", () => {
  const env = buildChildEnv({
    USE_PROXY: "true",
    use_proxy: "true",
    Use_Proxy: "true",
    FETCH_WEB_INSECURE_TLS: "true",
    fetch_web_insecure_tls: "true",
    Fetch_Web_Insecure_Tls: "true",
    ENABLE_CORS: "true",
    enable_cors: "true",
    Enable_Cors: "true",
    FAKE_IP_CIDRS: "127.0.0.0/8",
    fake_ip_cidrs: "10.0.0.0/8",
    Fake_Ip_Cidrs: "192.168.0.0/16",
    open_websearch_daemon_port: "3210",
    Open_WebSearch_Daemon_Url: "http://127.0.0.1:3210",
    KEEP_ME: "yes"
  });
  assert.equal(env.USE_PROXY, "false");
  assert.equal(env.FETCH_WEB_INSECURE_TLS, "false");
  assert.equal(env.ENABLE_CORS, "false");
  assert.equal(env.FAKE_IP_CIDRS, "");
  assert.equal("use_proxy" in env, false);
  assert.equal("Use_Proxy" in env, false);
  assert.equal("fetch_web_insecure_tls" in env, false);
  assert.equal("Fetch_Web_Insecure_Tls" in env, false);
  assert.equal("enable_cors" in env, false);
  assert.equal("Enable_Cors" in env, false);
  assert.equal("fake_ip_cidrs" in env, false);
  assert.equal("Fake_Ip_Cidrs" in env, false);
  assert.equal("open_websearch_daemon_port" in env, false);
  assert.equal("Open_WebSearch_Daemon_Url" in env, false);
  assert.equal(env.KEEP_ME, "yes");
});

test("launcher sources contain no 3210 fallback", () => {
  const files = [
    join(PACKAGE_ROOT, "bin", "launcher.js"),
    ...readdirSync(join(PACKAGE_ROOT, "lib"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(PACKAGE_ROOT, "lib", name))
  ];
  for (const file of files) {
    assert.equal(readFileSync(file, "utf8").includes("3210"), false, file);
  }
});

test("publishes a dynamic endpoint and cleans up on child exit", { timeout: 40000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const exitFile = join(runtimeDir, "exit");
  const handle = spawnLauncher(runtimeDir, {
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_FILE: exitFile,
      OPEN_WEBSEARCH_DAEMON_PORT: "3210",
      OPEN_WEBSEARCH_DAEMON_URL: "http://127.0.0.1:3210"
    }
  });
  try {
    await waitFor(() => existsSync(endpointPath(runtimeDir)), 12000);
    const endpoint = readJson(endpointPath(runtimeDir));
    const observation = readJson(observationFile);

    assert.equal(isEndpoint(endpoint), true);
    assert.equal(endpoint.v, 1);
    assert.equal(endpoint.name, "open-websearch");
    assert.equal(endpoint.host, "127.0.0.1");
    assert.equal(endpoint.version, "2.2.0");
    assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0);
    assert.equal(endpoint.baseUrl, `http://127.0.0.1:${endpoint.port}`);
    assert.equal(endpoint.pid, observation.pid);
    assert.notEqual(endpoint.pid, handle.child.pid);
    assert.ok(isPidAlive(endpoint.pid));
    assert.equal(Number.isNaN(Date.parse(endpoint.startedAt)), false);
    assert.deepEqual(
      Object.keys(endpoint).sort(),
      ["baseUrl", "host", "instanceId", "name", "pid", "port", "startedAt", "v", "version"]
    );
    assert.equal(/token|secret|password|authorization|api[-_]?key/i.test(JSON.stringify(endpoint)), false);

    assert.deepEqual(observation.argv, ["serve", "--host", "127.0.0.1", "--port", "0"]);
    assert.equal(observation.env.OPEN_WEBSEARCH_DAEMON_PORT, null);
    assert.equal(observation.env.OPEN_WEBSEARCH_DAEMON_URL, null);

    const response = await fetch(`${endpoint.baseUrl}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.data.version, "2.2.0");

    writeFileSync(exitFile, "exit");
    const exit = await waitForExit(handle.child, 15000);
    assert.equal(exit.code, 0);
    await waitFor(() => !existsSync(endpointPath(runtimeDir)), 5000);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
    await waitFor(() => !isPidAlive(endpoint.pid), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("replaces a stale endpoint with a dead pid", { timeout: 40000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const exitFile = join(runtimeDir, "exit");
  writeFileSync(endpointPath(runtimeDir), JSON.stringify(createEndpoint({
    port: 54321,
    pid: DEAD_PID,
    instanceId: "stale-instance",
    startedAt: new Date().toISOString()
  })));
  const handle = spawnLauncher(runtimeDir, {
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_FILE: exitFile
    }
  });
  try {
    const endpoint = await waitFor(() => {
      const candidate = readJsonSafe(endpointPath(runtimeDir));
      return candidate !== null && candidate.instanceId !== "stale-instance" && candidate.pid !== DEAD_PID
        ? candidate
        : null;
    }, 12000);
    assert.notEqual(endpoint.instanceId, "stale-instance");
    assert.notEqual(endpoint.pid, DEAD_PID);
    assert.ok(isPidAlive(endpoint.pid));
    writeFileSync(exitFile, "exit");
    const exit = await waitForExit(handle.child, 15000);
    assert.equal(exit.code, 0);
    await waitFor(() => !existsSync(endpointPath(runtimeDir)), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("replaces an invalid endpoint file", { timeout: 40000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const exitFile = join(runtimeDir, "exit");
  writeFileSync(endpointPath(runtimeDir), "{not-json");
  const handle = spawnLauncher(runtimeDir, {
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_FILE: exitFile
    }
  });
  try {
    const endpoint = await waitFor(() => {
      const candidate = readJsonSafe(endpointPath(runtimeDir));
      return candidate !== null && isEndpoint(candidate) ? candidate : null;
    }, 12000);
    assert.equal(isEndpoint(endpoint), true);
    writeFileSync(exitFile, "exit");
    const exit = await waitForExit(handle.child, 15000);
    assert.equal(exit.code, 0);
    await waitFor(() => !existsSync(endpointPath(runtimeDir)), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("refuses to start when a live endpoint exists", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const live = createEndpoint({
    port: 54321,
    pid: process.pid,
    instanceId: "existing-instance",
    startedAt: new Date().toISOString()
  });
  writeFileSync(endpointPath(runtimeDir), JSON.stringify(live));
  const handle = spawnLauncher(runtimeDir, {
    env: { FAKE_OWS_OBSERVATION_FILE: observationFile }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /already running/i);
    assert.equal(existsSync(observationFile), false);
    assert.deepEqual(readJson(endpointPath(runtimeDir)), live);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("fails closed on a live endpoint with the wrong version", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const live = createEndpoint({
    port: 54321,
    pid: process.pid,
    instanceId: "existing-instance",
    startedAt: new Date().toISOString()
  });
  live.version = "2.2.1";
  writeFileSync(endpointPath(runtimeDir), JSON.stringify(live));
  const handle = spawnLauncher(runtimeDir, {
    env: { FAKE_OWS_OBSERVATION_FILE: observationFile }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /identity/i);
    assert.equal(existsSync(observationFile), false);
    assert.deepEqual(readJson(endpointPath(runtimeDir)), live);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("replaces a stale lock", { timeout: 40000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const exitFile = join(runtimeDir, "exit");
  writeFileSync(lockPath(runtimeDir), JSON.stringify({
    v: 1,
    name: "open-websearch-launcher",
    pid: DEAD_PID,
    instanceId: "stale-lock",
    createdAt: new Date().toISOString()
  }));
  const handle = spawnLauncher(runtimeDir, {
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_FILE: exitFile
    }
  });
  try {
    await waitFor(() => existsSync(endpointPath(runtimeDir)), 12000);
    const lock = readJson(lockPath(runtimeDir));
    assert.equal(lock.pid, handle.child.pid);
    assert.notEqual(lock.instanceId, "stale-lock");
    writeFileSync(exitFile, "exit");
    const exit = await waitForExit(handle.child, 15000);
    assert.equal(exit.code, 0);
    await waitFor(() => !existsSync(lockPath(runtimeDir)), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("refuses to start while another launcher lock is live", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const heldLock = {
    v: 1,
    name: "open-websearch-launcher",
    pid: process.pid,
    instanceId: "held-lock",
    createdAt: new Date().toISOString()
  };
  writeFileSync(lockPath(runtimeDir), JSON.stringify(heldLock));
  const handle = spawnLauncher(runtimeDir, {
    env: { FAKE_OWS_OBSERVATION_FILE: observationFile }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /already running/i);
    assert.equal(existsSync(observationFile), false);
    assert.equal(existsSync(endpointPath(runtimeDir)), false);
    assert.deepEqual(readJson(lockPath(runtimeDir)), heldLock);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

for (const [label, overrides, expectedCode] of [
  ["version", { version: "2.2.1" }, "package_version_mismatch"],
  ["identity", { name: "not-open-websearch" }, "package_identity_mismatch"]
]) {
  test(`fails closed before spawn on package ${label} mismatch`, { timeout: 30000 }, async () => {
    const runtimeDir = createRuntimeDir();
    const observationFile = join(runtimeDir, "observation.json");
    const packageRoot = join(runtimeDir, "bad-package");
    cpSync(FAKE_ROOT, packageRoot, { recursive: true });
    const manifest = readJson(join(packageRoot, "package.json"));
    Object.assign(manifest, overrides);
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
    const handle = spawnLauncher(runtimeDir, {
      entry: join(packageRoot, "build", "index.js"),
      env: { FAKE_OWS_OBSERVATION_FILE: observationFile }
    });
    try {
      const result = await waitForFailure(handle);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(expectedCode));
      assert.equal(existsSync(observationFile), false);
      assertArtifactsGone(runtimeDir);
    } finally {
      await stopEverything(handle, runtimeDir);
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
}

for (const [mode, expectedReason] of [
  ["wrong-version", "status_version_mismatch"],
  ["wrong-base-url", "status_base_url_mismatch"],
  ["wrong-identity", "status_daemon_not_running"],
  ["runtime-not-ready", "status_runtime_not_ready"],
  ["missing-capability", "status_capabilities_mismatch"],
  ["proxy-enabled", "status_proxy_enabled"],
  ["insecure-tls", "status_insecure_tls_enabled"],
  ["invalid-envelope", "status_invalid_envelope"],
  ["http-500", "status_http_500"],
  ["invalid-json", "status_invalid_json"]
]) {
  test(`fails closed on /status ${mode}`, { timeout: 30000 }, async () => {
    const runtimeDir = createRuntimeDir();
    const observationFile = join(runtimeDir, "observation.json");
    const handle = spawnLauncher(runtimeDir, {
      startupTimeoutMs: 5000,
      statusTimeoutMs: 1200,
      env: {
        FAKE_OWS_OBSERVATION_FILE: observationFile,
        FAKE_OWS_STATUS_MODE: mode
      }
    });
    try {
      const result = await waitForFailure(handle);
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(expectedReason), result.stderr);
      assert.equal(result.stderr.includes("secret-playwright-path"), false);
      assert.equal(existsSync(endpointPath(runtimeDir)), false);
      assert.equal(existsSync(lockPath(runtimeDir)), false);
      const observation = readJson(observationFile);
      await waitFor(() => !isPidAlive(observation.pid), 5000);
    } finally {
      await stopEverything(handle, runtimeDir);
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
}

test("fails closed when no port is announced", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const handle = spawnLauncher(runtimeDir, {
    startupTimeoutMs: 1200,
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_NO_ANNOUNCE: "1"
    }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("startup_timeout"), result.stderr);
    assert.equal(existsSync(endpointPath(runtimeDir)), false);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
    const observation = readJson(observationFile);
    await waitFor(() => !isPidAlive(observation.pid), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("rejects an announced port of zero", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const handle = spawnLauncher(runtimeDir, {
    startupTimeoutMs: 5000,
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_ANNOUNCE_PORT: "0"
    }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("invalid_announced_port"), result.stderr);
    assert.equal(existsSync(endpointPath(runtimeDir)), false);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
    const observation = readJson(observationFile);
    await waitFor(() => !isPidAlive(observation.pid), 5000);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("fails closed when the child exits before announcing", { timeout: 30000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const handle = spawnLauncher(runtimeDir, {
    startupTimeoutMs: 5000,
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_BEFORE_ANNOUNCE: "1"
    }
  });
  try {
    const result = await waitForFailure(handle);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("child_exited_before_ready"), result.stderr);
    assertArtifactsGone(runtimeDir);
  } finally {
    await stopEverything(handle, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("only one launcher can own a runtime directory", { timeout: 40000 }, async () => {
  const runtimeDir = createRuntimeDir();
  const observationFile = join(runtimeDir, "observation.json");
  const exitFile = join(runtimeDir, "exit");
  const first = spawnLauncher(runtimeDir, {
    env: {
      FAKE_OWS_OBSERVATION_FILE: observationFile,
      FAKE_OWS_EXIT_FILE: exitFile
    }
  });
  let second;
  try {
    await waitFor(() => existsSync(endpointPath(runtimeDir)), 12000);
    const published = readJson(endpointPath(runtimeDir));
    second = spawnLauncher(runtimeDir, {
      env: { FAKE_OWS_OBSERVATION_FILE: join(runtimeDir, "observation-b.json") }
    });
    const result = await waitForFailure(second);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /already running/i);
    assert.equal(existsSync(join(runtimeDir, "observation-b.json")), false);
    assert.deepEqual(readJson(endpointPath(runtimeDir)), published);
    assert.equal(readJson(lockPath(runtimeDir)).pid, first.child.pid);

    writeFileSync(exitFile, "exit");
    const exit = await waitForExit(first.child, 15000);
    assert.equal(exit.code, 0);
    await waitFor(() => !existsSync(endpointPath(runtimeDir)), 5000);
    assert.equal(existsSync(lockPath(runtimeDir)), false);
  } finally {
    if (second) await stopEverything(second, runtimeDir);
    await stopEverything(first, runtimeDir);
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
