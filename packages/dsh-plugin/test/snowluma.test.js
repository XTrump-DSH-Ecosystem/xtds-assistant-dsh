import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const BASE_STATUS = {
  ok: true,
  supervisor: { pid: 123, port: 1, startedAt: Date.now(), uptimeMs: 1, version: "0.1.0" },
  autostart: { supported: true, enabled: false, backend: "startup", taskName: "XTDS-Assistant" },
  processes: [{ id: "qq-gateway", label: "QQ Gateway", state: "running", health: "healthy" }]
};

test("status API has a non-fatal, read-only SnowLuma Web UI projection", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xtds-plugin-snowluma-"));
  const configDir = join(dir, "config");
  const supervisorRuntimeDir = join(dir, "supervisor-runtime");
  const snowHome = join(dir, "snow-home");
  const snowRuntimePath = join(snowHome, "config", "runtime.json");
  const snowConfigPath = join(configDir, "snowluma.json");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(supervisorRuntimeDir, { recursive: true });
  mkdirSync(join(snowHome, "config"), { recursive: true });

  let upstreamStatus = 200;
  let upstreamBody = JSON.stringify(BASE_STATUS);
  const fakeSupervisor = createServer((req, res) => {
    res.writeHead(upstreamStatus, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(upstreamBody)
    });
    res.end(upstreamBody);
  });
  await new Promise((resolve) => fakeSupervisor.listen(0, "127.0.0.1", resolve));
  const fakePort = fakeSupervisor.address().port;

  writeFileSync(join(configDir, "supervisor.json"), JSON.stringify({
    runtimeDir: supervisorRuntimeDir,
    nodePath: process.execPath,
    processes: []
  }));
  writeFileSync(join(supervisorRuntimeDir, "config.json"), JSON.stringify({ controlToken: "b".repeat(64) }));
  writeFileSync(join(supervisorRuntimeDir, "supervisor.endpoint.json"), JSON.stringify({
    v: 1,
    name: "xtds-assistant-supervisor",
    host: "127.0.0.1",
    port: fakePort,
    pid: process.pid,
    startedAt: Date.now(),
    instanceId: "snowluma-test"
  }));

  const previousHome = process.env.XTDS_ASSISTANT_HOME;
  const previousConfig = process.env.XTDS_SUPERVISOR_CONFIG;
  const previousNoBootstrap = process.env.XTDS_PLUGIN_NO_BOOTSTRAP;
  process.env.XTDS_ASSISTANT_HOME = dir;
  process.env.XTDS_SUPERVISOR_CONFIG = join(configDir, "supervisor.json");
  process.env.XTDS_PLUGIN_NO_BOOTSTRAP = "1";

  const hostModule = await import(`${pathToFileURL(join(import.meta.dirname, "../lib/host.js")).href}?snowluma=${Date.now()}`);
  const routes = new Map();
  hostModule.apply({
    effect(fn) {
      const dispose = fn();
      t.after(() => { if (typeof dispose === "function") dispose(); });
      return dispose;
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      }
    }
  });

  const proxyServer = createServer((req, res) => {
    const route = routes.get(new URL(req.url, "http://127.0.0.1").pathname);
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    route.handler(req, res);
  });
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => proxyServer.close(resolve));
    await new Promise((resolve) => fakeSupervisor.close(resolve));
    if (previousHome === undefined) delete process.env.XTDS_ASSISTANT_HOME;
    else process.env.XTDS_ASSISTANT_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.XTDS_SUPERVISOR_CONFIG;
    else process.env.XTDS_SUPERVISOR_CONFIG = previousConfig;
    if (previousNoBootstrap === undefined) delete process.env.XTDS_PLUGIN_NO_BOOTSTRAP;
    else process.env.XTDS_PLUGIN_NO_BOOTSTRAP = previousNoBootstrap;
    rmSync(dir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${proxyServer.address().port}`;
  async function request(path) {
    const response = await fetch(`${origin}${path}`, {
      headers: { origin }
    });
    return { response, text: await response.text() };
  }

  function writeSnowConfig(value) {
    writeFileSync(snowConfigPath, typeof value === "string" ? value : JSON.stringify(value));
  }

  function writeRuntime(value) {
    writeFileSync(snowRuntimePath, typeof value === "string" ? value : JSON.stringify(value));
  }

  function writeValidFixture(overrides = {}) {
    writeSnowConfig({
      home: snowHome,
      configSentinel: "CONFIG_SENTINEL_DO_NOT_LEAK"
    });
    writeRuntime({
      webuiHost: "127.0.0.1",
      webuiPort: 5099,
      webuiTls: { enabled: false, tlsSentinel: "TLS_SENTINEL_DO_NOT_LEAK" },
      runtimeSentinel: "RUNTIME_SENTINEL_DO_NOT_LEAK",
      ...overrides
    });
  }

  async function readSnowluma() {
    const { response, text } = await request("/xtds/api/status");
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    return { body, text };
  }

  async function assertFailure(reason) {
    const { body } = await readSnowluma();
    assert.deepEqual(Object.keys(body.snowluma).sort(), ["available", "checkedAt", "reason"]);
    assert.equal(body.snowluma.available, false);
    assert.equal(body.snowluma.reason, reason);
    assert.match(body.snowluma.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }

  await t.test("reads port 5099 and returns a loopback URL without leaking fixture data", async () => {
    writeValidFixture();
    const { body, text } = await readSnowluma();
    assert.equal(body.snowluma.available, true);
    assert.equal(body.snowluma.webUiHost, "127.0.0.1");
    assert.equal(body.snowluma.webUiPort, 5099);
    assert.equal(body.snowluma.webUiUrl, "http://127.0.0.1:5099/");
    assert.equal(body.snowluma.tls, false);
    assert.equal(Object.hasOwn(body.snowluma, "reason"), false);
    assert.match(body.snowluma.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const escapedDir = JSON.stringify(dir).slice(1, -1);
    assert.equal(text.includes(dir) || text.includes(escapedDir), false);
    assert.equal(text.includes("CONFIG_SENTINEL_DO_NOT_LEAK"), false);
    assert.equal(text.includes("RUNTIME_SENTINEL_DO_NOT_LEAK"), false);
    assert.equal(text.includes("TLS_SENTINEL_DO_NOT_LEAK"), false);
  });

  await t.test("uses https when webuiTls.enabled is true", async () => {
    writeValidFixture({ webuiTls: { enabled: true } });
    const { body } = await readSnowluma();
    assert.equal(body.snowluma.available, true);
    assert.equal(body.snowluma.tls, true);
    assert.equal(body.snowluma.webUiUrl, "https://127.0.0.1:5099/");
  });

  await t.test("brackets IPv6 loopback hosts in the URL", async () => {
    writeValidFixture({ webuiHost: "::1" });
    const { body } = await readSnowluma();
    assert.equal(body.snowluma.available, true);
    assert.equal(body.snowluma.webUiHost, "::1");
    assert.equal(body.snowluma.webUiUrl, "http://[::1]:5099/");
  });

  await t.test("does not expose a URL for a valid non-loopback host", async () => {
    writeValidFixture({ webuiHost: "snowluma.example" });
    const { body, text } = await readSnowluma();
    assert.equal(body.snowluma.available, true);
    assert.equal(body.snowluma.webUiHost, "snowluma.example");
    assert.equal(body.snowluma.webUiPort, 5099);
    assert.equal(body.snowluma.reason, "non_loopback_host");
    assert.equal(Object.hasOwn(body.snowluma, "webUiUrl"), false);
    assert.equal(text.includes("\"webUiUrl\""), false);
  });

  await t.test("reports config_missing and config_invalid", async () => {
    rmSync(snowConfigPath, { force: true });
    await assertFailure("config_missing");
    writeSnowConfig("{not-json");
    await assertFailure("config_invalid");
    writeSnowConfig([]);
    await assertFailure("config_invalid");
  });

  await t.test("reports config_unreadable without failing the status request", async () => {
    rmSync(snowConfigPath, { force: true });
    mkdirSync(snowConfigPath);
    await assertFailure("config_unreadable");
    rmSync(snowConfigPath, { recursive: true, force: true });
  });

  await t.test("reports home_invalid for a non-absolute or missing home", async () => {
    writeSnowConfig({ home: "relative\\SnowLuma" });
    await assertFailure("home_invalid");
    writeSnowConfig({ home: 42 });
    await assertFailure("home_invalid");
  });

  await t.test("reports runtime_missing and runtime_invalid", async () => {
    writeSnowConfig({ home: snowHome });
    rmSync(snowRuntimePath, { force: true });
    await assertFailure("runtime_missing");
    writeRuntime("{not-json");
    await assertFailure("runtime_invalid");
    writeRuntime([]);
    await assertFailure("runtime_invalid");
  });

  await t.test("reports runtime_unreadable without failing the status request", async () => {
    writeSnowConfig({ home: snowHome });
    rmSync(snowRuntimePath, { force: true });
    mkdirSync(snowRuntimePath);
    await assertFailure("runtime_unreadable");
    rmSync(snowRuntimePath, { recursive: true, force: true });
  });

  await t.test("reports host_invalid and port_invalid", async () => {
    writeSnowConfig({ home: snowHome });
    writeRuntime({ webuiHost: "http://127.0.0.1", webuiPort: 5099, webuiTls: { enabled: false } });
    await assertFailure("host_invalid");

    for (const webuiPort of [0, 65536, 5099.5, "5099"]) {
      writeRuntime({ webuiHost: "127.0.0.1", webuiPort, webuiTls: { enabled: false } });
      await assertFailure("port_invalid");
    }
  });

  await t.test("keeps a non-200 upstream response byte-for-byte unchanged", async () => {
    writeValidFixture();
    upstreamStatus = 503;
    upstreamBody = JSON.stringify({ ok: false, error: "upstream down" });
    const { response, text } = await request("/xtds/api/status");
    assert.equal(response.status, 503);
    assert.equal(text, upstreamBody);
    assert.equal(text.includes("snowluma"), false);
    upstreamStatus = 200;
    upstreamBody = JSON.stringify(BASE_STATUS);
  });

  await t.test("keeps an unparseable 200 response and non-status paths unchanged", async () => {
    writeValidFixture();
    upstreamBody = "{\"ok\":true,";
    let result = await request("/xtds/api/status");
    assert.equal(result.response.status, 200);
    assert.equal(result.text, upstreamBody);
    assert.equal(result.text.includes("snowluma"), false);

    upstreamBody = JSON.stringify({ supported: true, enabled: false });
    result = await request("/xtds/api/autostart");
    assert.equal(result.response.status, 200);
    assert.equal(result.text, upstreamBody);
    assert.equal(result.text.includes("snowluma"), false);

    upstreamBody = JSON.stringify(BASE_STATUS);
  });
});
