import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("host registers exact routes, fences origins, and proxies with the local token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "xtds-plugin-host-"));
  const runtimeDir = join(dir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const token = "a".repeat(64);
  const supervisorResponse = {
    ok: true,
    supervisor: { pid: 123, port: 1, startedAt: Date.now(), uptimeMs: 1, version: "0.1.0" },
    autostart: { supported: true, enabled: false, backend: "startup", taskName: "XTDS-Assistant" },
    processes: []
  };
  let forwardedToken = null;
  const fakeSupervisor = createServer((req, res) => {
    forwardedToken = req.headers["x-xtds-token"];
    const body = JSON.stringify(supervisorResponse);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve) => fakeSupervisor.listen(0, "127.0.0.1", resolve));
  const fakePort = fakeSupervisor.address().port;

  writeFileSync(join(dir, "supervisor.json"), JSON.stringify({
    runtimeDir,
    nodePath: process.execPath,
    processes: []
  }));
  writeFileSync(join(runtimeDir, "config.json"), JSON.stringify({ controlToken: token }));
  writeFileSync(join(runtimeDir, "supervisor.endpoint.json"), JSON.stringify({
    v: 1,
    name: "xtds-assistant-supervisor",
    host: "127.0.0.1",
    port: fakePort,
    pid: process.pid,
    startedAt: Date.now(),
    instanceId: "test"
  }));

  const previousHome = process.env.XTDS_ASSISTANT_HOME;
  const previousConfig = process.env.XTDS_SUPERVISOR_CONFIG;
  const previousNoBootstrap = process.env.XTDS_PLUGIN_NO_BOOTSTRAP;
  process.env.XTDS_ASSISTANT_HOME = dir;
  process.env.XTDS_SUPERVISOR_CONFIG = join(dir, "supervisor.json");
  process.env.XTDS_PLUGIN_NO_BOOTSTRAP = "1";
  const hostModule = await import(`${pathToFileURL(join(import.meta.dirname, "../lib/host.js")).href}?test=${Date.now()}`);

  const routes = new Map();
  const ctx = {
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
  };
  hostModule.apply(ctx);
  assert.equal(hostModule.name, "xtds-assistant-dsh-host");
  assert.deepEqual(hostModule.inject, ["webServer"]);
  assert.equal(routes.size, 14);
  assert.ok(routes.has("/xtds/api/status"));
  assert.ok(routes.has("/xtds/api/processes/open-websearch/start"));
  assert.ok(routes.has("/xtds/api/processes/open-websearch/stop"));
  assert.ok(routes.has("/xtds/api/processes/open-websearch/restart"));
  assert.ok(routes.has("/xtds/api/processes/code-bridge/start"));
  assert.ok(routes.has("/xtds/api/processes/code-bridge/stop"));
  assert.ok(routes.has("/xtds/api/processes/code-bridge/restart"));

  const proxyServer = createServer((req, res) => routes.get("/xtds/api/status").handler(req, res));
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    proxyServer.close();
    fakeSupervisor.close();
    if (previousHome === undefined) delete process.env.XTDS_ASSISTANT_HOME;
    else process.env.XTDS_ASSISTANT_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.XTDS_SUPERVISOR_CONFIG;
    else process.env.XTDS_SUPERVISOR_CONFIG = previousConfig;
    if (previousNoBootstrap === undefined) delete process.env.XTDS_PLUGIN_NO_BOOTSTRAP;
    else process.env.XTDS_PLUGIN_NO_BOOTSTRAP = previousNoBootstrap;
    rmSync(dir, { recursive: true, force: true });
  });
  const port = proxyServer.address().port;
  const sameOrigin = await fetch(`http://127.0.0.1:${port}/xtds/api/status`, {
    headers: { origin: `http://127.0.0.1:${port}` }
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal((await sameOrigin.json()).ok, true);
  assert.equal(forwardedToken, token);

  const foreign = await fetch(`http://127.0.0.1:${port}/xtds/api/status`, {
    headers: { origin: "http://evil.example" }
  });
  assert.equal(foreign.status, 403);
});
