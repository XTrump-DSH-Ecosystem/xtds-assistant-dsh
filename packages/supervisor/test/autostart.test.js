import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutostartManager, createStartScript } from "../lib/autostart.js";

const REG = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "reg.exe")
  : "reg.exe";

test("start script leaves service startup to the config flag", () => {
  const script = createStartScript({
    config: {
      configPath: join("C:\\repo", "config", "supervisor.json"),
      nodePath: "C:\\Program Files\\nodejs\\node.exe"
    },
    cliPath: join("C:\\repo", "packages", "supervisor", "bin", "supervisor.js"),
    logPath: join("C:\\repo", "runtime", "logs", "supervisor-boot.log")
  });
  assert.doesNotMatch(script, /--start-services/);
  assert.match(script, /--config/);
});

test("startup folder create query delete round trip", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "xtds-autostart-test-"));
  const scriptPath = join(dir, "start.cmd");
  const startupDir = join(dir, "Startup");
  writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n");
  const taskName = `XTDS-Assistant-Test-${Date.now().toString(36)}`;
  const manager = new AutostartManager({
    taskName,
    startScriptPath: scriptPath,
    backend: "startup",
    startupDir
  });
  try {
    const before = await manager.status();
    assert.equal(before.supported, true);
    assert.equal(before.enabled, false);
    assert.equal(before.backend, "startup");
    const created = await manager.enable();
    assert.equal(created.enabled, true, JSON.stringify(created));
    assert.equal(created.path, join(startupDir, `${taskName}.cmd`));
    assert.equal(await manager.exists(), true);
    const queried = await manager.status();
    assert.equal(queried.enabled, true);
    const deleted = await manager.disable();
    assert.equal(deleted.enabled, false);
    assert.equal(await manager.exists(), false);
  } finally {
    try {
      await manager.disable();
    } catch {
      // Best-effort cleanup.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional schtasks XML backend creates, queries, and deletes", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "xtds-schtasks-test-"));
  const scriptPath = join(dir, "start.cmd");
  writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n");
  const taskName = `XTDS-Assistant-Opt-${Date.now().toString(36)}`;
  const manager = new AutostartManager({
    taskName,
    startScriptPath: scriptPath,
    backend: "schtasks"
  });
  try {
    const created = await manager.enable();
    assert.equal(created.enabled, true, JSON.stringify(created));
    assert.equal(await manager.exists(), true);
    const queried = await manager.status();
    assert.equal(queried.enabled, true);
    const deleted = await manager.disable();
    assert.equal(deleted.enabled, false);
    assert.equal(await manager.exists(), false);
  } finally {
    try {
      await manager.disable();
    } catch {
      // Best-effort cleanup.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry backend creates, queries, and deletes a Run value", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "xtds-registry-test-"));
  const scriptPath = join(dir, "start.cmd");
  writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n");
  const key = `HKCU\\Software\\XTDS-Assistant-Test\\${Date.now().toString(36)}`;
  const manager = new AutostartManager({
    taskName: "XTDS-Assistant-Registry-Test",
    startScriptPath: scriptPath,
    backend: "registry",
    registryKey: key,
    registryValueName: "launch"
  });
  try {
    const before = await manager.status();
    assert.equal(before.backend, "registry");
    assert.equal(before.enabled, false);
    const created = await manager.enable();
    assert.equal(created.enabled, true, JSON.stringify(created));
    assert.equal(await manager.exists(), true);
    const queried = await manager.status();
    assert.equal(queried.enabled, true);
    const disabled = await manager.disable();
    assert.equal(disabled.enabled, false);
    assert.equal(await manager.exists(), false);
  } finally {
    try {
      await manager.disable();
    } catch {
      // Best-effort cleanup.
    }
    try {
      execFileSync(REG, ["DELETE", key, "/f"], { windowsHide: true, stdio: "ignore" });
    } catch {
      // The key may not have been created.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
