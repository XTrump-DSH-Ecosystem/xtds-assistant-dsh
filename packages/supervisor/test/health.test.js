import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { ConfigError, loadConfig } from "../lib/config.js";
import { MAX_HEALTH_BODY_BYTES, probeHealth } from "../lib/endpoint.js";
import { createHarness } from "./helpers.js";

test("probeHealth parses online state and bounds the response body", async (t) => {
  const server = createServer((req, res) => {
    let status = 200;
    let body;
    switch (req.url) {
      case "/online-true":
        body = JSON.stringify({ ok: true, online: true });
        break;
      case "/online-false":
        body = JSON.stringify({ ok: true, online: false });
        break;
      case "/missing":
        body = JSON.stringify({ ok: true });
        break;
      case "/invalid":
        body = "{\"online\":\"secret-health-body\"";
        break;
      case "/too-large":
        body = JSON.stringify({ online: true, padding: "x".repeat(MAX_HEALTH_BODY_BYTES) });
        break;
      case "/unavailable":
        status = 503;
        body = JSON.stringify({ ok: false });
        break;
      default:
        status = 404;
        body = JSON.stringify({ ok: false });
        break;
    }
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const online = await probeHealth(`${base}/online-true`, 1000);
  assert.equal(online.ok, true);
  assert.equal(online.online, true);
  assert.equal(online.bodyState, "ok");

  const offline = await probeHealth(`${base}/online-false`, 1000);
  assert.equal(offline.ok, true);
  assert.equal(offline.online, false);

  const missing = await probeHealth(`${base}/missing`, 1000);
  assert.equal(missing.ok, true);
  assert.equal(missing.online, null);
  assert.equal(missing.bodyState, "missing");

  const invalid = await probeHealth(`${base}/invalid`, 1000);
  assert.equal(invalid.ok, true);
  assert.equal(invalid.online, null);
  assert.equal(invalid.bodyState, "invalid");
  assert.equal(JSON.stringify(invalid).includes("secret-health-body"), false);

  const tooLarge = await probeHealth(`${base}/too-large`, 1000);
  assert.equal(tooLarge.ok, true);
  assert.equal(tooLarge.online, null);
  assert.equal(tooLarge.bodyState, "too_large");

  const unavailable = await probeHealth(`${base}/unavailable`, 1000);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.online, null);
});

test("healthRequireOnline defaults to false and must be boolean", (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const config = loadConfig(harness.configPath);
  assert.equal(config.processes.find((entry) => entry.id === "ds-memory").healthRequireOnline, false);
  assert.equal(config.processes.find((entry) => entry.id === "qq-gateway").healthRequireOnline, true);

  harness.config.processes[0].healthRequireOnline = "true";
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  assert.throws(
    () => loadConfig(harness.configPath),
    (error) => error instanceof ConfigError && error.message.includes("healthRequireOnline")
  );
});

test("endpointPid defaults to self and only accepts self or any", (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const config = loadConfig(harness.configPath);
  assert.equal(config.processes[0].endpointPid, "self");

  harness.config.processes[0].endpointPid = "any";
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  assert.equal(loadConfig(harness.configPath).processes[0].endpointPid, "any");

  harness.config.processes[0].endpointPid = "child";
  writeFileSync(harness.configPath, JSON.stringify(harness.config, null, 2));
  assert.throws(
    () => loadConfig(harness.configPath),
    (error) => error instanceof ConfigError && error.message.includes("endpointPid")
  );
});
