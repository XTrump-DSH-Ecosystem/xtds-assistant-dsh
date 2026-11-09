import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEndpoint,
  inspectEndpoint,
  isEndpoint,
  readEndpoint,
  removeEndpointIfOwned,
  writeEndpointAtomic
} from "../lib/endpoint.js";
import { writeJsonAtomic } from "../lib/fs-utils.js";
import { ATOMIC_READER_PATH, waitForExit } from "./helpers.js";

function createDir() {
  return mkdtempSync(join(tmpdir(), "xtds-ows-endpoint-"));
}

function validEndpoint(overrides = {}) {
  return {
    ...createEndpoint({
      port: 54321,
      pid: process.pid,
      instanceId: "instance-00000000-0000-4000-8000-000000000000",
      startedAt: new Date().toISOString()
    }),
    ...overrides
  };
}

const DEAD_PID = 2147483647;

test("isEndpoint accepts the frozen shape", () => {
  assert.equal(isEndpoint(validEndpoint()), true);
});

test("isEndpoint rejects version, identity, shape, and secret failures", () => {
  const cases = [
    validEndpoint({ v: 2 }),
    validEndpoint({ name: "other" }),
    validEndpoint({ host: "0.0.0.0" }),
    validEndpoint({ port: 0 }),
    validEndpoint({ port: 65536 }),
    validEndpoint({ pid: 0 }),
    validEndpoint({ instanceId: "" }),
    validEndpoint({ startedAt: "" }),
    validEndpoint({ startedAt: `${new Date().toISOString()}${"x".repeat(64)}` }),
    validEndpoint({ startedAt: "not-a-date" }),
    validEndpoint({ version: "2.2.1" }),
    validEndpoint({ baseUrl: "http://127.0.0.1:54322" }),
    validEndpoint({ token: "secret" }),
    validEndpoint({ apiKey: "secret" }),
    null,
    [],
    "endpoint"
  ];
  for (const value of cases) {
    assert.equal(isEndpoint(value), false, JSON.stringify(value));
  }
});

test("readEndpoint loads only a valid endpoint", () => {
  const dir = createDir();
  try {
    const filePath = join(dir, "open-websearch.endpoint.json");
    const endpoint = validEndpoint();
    writeFileSync(filePath, JSON.stringify(endpoint));
    assert.deepEqual(readEndpoint(filePath), endpoint);
    writeFileSync(filePath, JSON.stringify(validEndpoint({ version: "2.2.1" })));
    assert.equal(readEndpoint(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectEndpoint distinguishes none, stale, mismatch, and live", () => {
  const dir = createDir();
  try {
    const filePath = join(dir, "open-websearch.endpoint.json");
    assert.deepEqual(inspectEndpoint(filePath), { state: "none" });

    writeFileSync(filePath, JSON.stringify(validEndpoint({ pid: DEAD_PID })));
    assert.equal(inspectEndpoint(filePath).state, "stale");

    writeFileSync(filePath, JSON.stringify(validEndpoint({ pid: process.pid, version: "2.2.1" })));
    assert.equal(inspectEndpoint(filePath).state, "mismatch");

    writeFileSync(filePath, JSON.stringify(validEndpoint({ pid: process.pid })));
    assert.equal(inspectEndpoint(filePath).state, "live");

    writeFileSync(filePath, "{");
    assert.equal(inspectEndpoint(filePath).state, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeEndpointIfOwned removes only matching pid and instance", () => {
  const dir = createDir();
  try {
    const filePath = join(dir, "open-websearch.endpoint.json");
    const endpoint = validEndpoint();
    writeFileSync(filePath, JSON.stringify(endpoint));

    assert.equal(removeEndpointIfOwned(filePath, { pid: endpoint.pid + 1, instanceId: endpoint.instanceId }), false);
    assert.equal(removeEndpointIfOwned(filePath, { pid: endpoint.pid, instanceId: "other" }), false);
    assert.equal(removeEndpointIfOwned(filePath, { pid: endpoint.pid, instanceId: endpoint.instanceId }), true);
    assert.equal(readEndpoint(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEndpointAtomic refuses invalid endpoints and leaves no temp files", () => {
  const dir = createDir();
  try {
    const filePath = join(dir, "open-websearch.endpoint.json");
    assert.throws(() => writeEndpointAtomic(filePath, validEndpoint({ version: "2.2.1" })));
    const endpoint = validEndpoint();
    writeEndpointAtomic(filePath, endpoint);
    assert.deepEqual(readEndpoint(filePath), endpoint);
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endpoint replacement is atomic for a concurrent reader", { timeout: 30000 }, async () => {
  const dir = createDir();
  const filePath = join(dir, "open-websearch.endpoint.json");
  const stopPath = join(dir, "stop");
  const resultPath = join(dir, "result.json");
  const reader = spawn(process.execPath, [ATOMIC_READER_PATH, filePath, stopPath, resultPath], {
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    writeJsonAtomic(filePath, { seq: 0, payload: "x".repeat(20000) });
    for (let seq = 1; seq <= 30; seq += 1) {
      writeJsonAtomic(filePath, { seq, payload: "x".repeat(20000) });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(stopPath, "");
    await waitForExit(reader, 10000);
    const report = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.ok(report.reads > 0, JSON.stringify(report));
    assert.equal(report.parseErrors, 0, JSON.stringify(report));
    assert.equal(report.shapeErrors, 0, JSON.stringify(report));
  } finally {
    writeFileSync(stopPath, "");
    if (reader.exitCode === null) reader.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
