import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlreadyRunningError } from "../lib/errors.js";
import { acquireLock, readLock, releaseLock } from "../lib/lock.js";

const DEAD_PID = 2147483647;

function createDir() {
  return mkdtempSync(join(tmpdir(), "xtds-ows-lock-"));
}

function lockMetadata(overrides = {}) {
  return {
    v: 1,
    name: "open-websearch-launcher",
    pid: process.pid,
    instanceId: "lock-instance-00000000-0000-4000-8000-000000000000",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test("acquireLock creates a lock and releaseLock removes it", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    const instanceId = "instance-a";
    acquireLock(lockPath, { instanceId });
    const state = readLock(lockPath);
    assert.equal(state.state, "live");
    assert.equal(state.lock.instanceId, instanceId);
    assert.equal(releaseLock(lockPath, { instanceId }), true);
    assert.equal(readLock(lockPath).state, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second acquire fails while the owner is alive", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    acquireLock(lockPath, { instanceId: "instance-a" });
    assert.throws(() => acquireLock(lockPath, { instanceId: "instance-b" }), AlreadyRunningError);
    releaseLock(lockPath, { instanceId: "instance-a" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock is replaced", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    writeFileSync(lockPath, JSON.stringify(lockMetadata({
      pid: DEAD_PID,
      instanceId: "stale-instance"
    })));
    acquireLock(lockPath, { instanceId: "new-instance" });
    const state = readLock(lockPath);
    assert.equal(state.state, "live");
    assert.equal(state.lock.instanceId, "new-instance");
    releaseLock(lockPath, { instanceId: "new-instance" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid lock file is replaced", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    writeFileSync(lockPath, "{");
    acquireLock(lockPath, { instanceId: "new-instance" });
    assert.equal(readLock(lockPath).state, "live");
    releaseLock(lockPath, { instanceId: "new-instance" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live incompatible lock fails closed", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    writeFileSync(lockPath, JSON.stringify(lockMetadata({ name: "other-launcher" })));
    assert.equal(readLock(lockPath).state, "mismatch");
    assert.throws(() => acquireLock(lockPath, { instanceId: "new-instance" }), AlreadyRunningError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLock requires the matching instance", () => {
  const dir = createDir();
  try {
    const lockPath = join(dir, "open-websearch.lock");
    acquireLock(lockPath, { instanceId: "instance-a" });
    assert.equal(releaseLock(lockPath, { instanceId: "instance-b" }), false);
    assert.equal(readLock(lockPath).state, "live");
    assert.equal(releaseLock(lockPath, { instanceId: "instance-a" }), true);
    assert.equal(readLock(lockPath).state, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
