import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../lib/config.js";
import { buildSpawnSpec, launchDsh } from "../lib/dsh.js";
import { sanitizeEnv } from "../lib/env.js";
import { ConfigError, WorktreeError } from "../lib/errors.js";
import { isPathInside, validateRepoPath, validateWorktreeTarget } from "../lib/git.js";
import { extractSummary } from "../lib/manager.js";
import {
  acquireInstanceLock,
  constantTimeTokenMatch,
  ensureToken,
  releaseInstanceLock
} from "../lib/runtime.js";

test("command construction never interpolates the task into a batch command line", () => {
  const task = 'do work & echo INJECTED>injected.txt\n"quoted"';
  const cmd = buildSpawnSpec({
    command: "C:\\Program Files\\DSH\\dsh.cmd",
    task,
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe"
  });
  assert.equal(cmd.taskInArgs, false);
  assert.equal(cmd.stdin, task);
  assert.equal(cmd.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(cmd.windowsVerbatimArguments, true);
  assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(cmd.args[3], /dsh\.cmd/);
  assert.match(cmd.args[3], /--profile headless --json --permission-mode workspace-write --approval-policy never -/);
  assert.equal(cmd.args[3].includes(task), false);

  const exe = buildSpawnSpec({
    command: "C:\\DSH\\dsh.exe",
    task,
    platform: "win32"
  });
  assert.equal(exe.taskInArgs, true);
  assert.equal(exe.windowsVerbatimArguments, false);
  assert.deepEqual(exe.args, [
    "--profile",
    "headless",
    "--json",
    "--permission-mode",
    "workspace-write",
    "--approval-policy",
    "never",
    task
  ]);
  assert.equal(exe.args.includes("danger-full-access"), false);

  const sessionId = "session-1234abcd-1234-1234-1234-123456789abc";
  const cmdWithSession = buildSpawnSpec({
    command: "C:\\Program Files\\DSH\\dsh.cmd",
    task: "x",
    sessionId,
    platform: "win32",
    comspec: "C:\\Windows\\System32\\cmd.exe"
  });
  assert.equal(cmdWithSession.taskInArgs, false);
  assert.match(
    cmdWithSession.args[3],
    /--approval-policy never --session-id session-1234abcd-1234-1234-1234-123456789abc -/
  );

  const exeWithSession = buildSpawnSpec({
    command: "C:\\DSH\\dsh.exe",
    task: "x",
    sessionId,
    platform: "win32"
  });
  assert.deepEqual(exeWithSession.args, [
    "--profile",
    "headless",
    "--json",
    "--permission-mode",
    "workspace-write",
    "--approval-policy",
    "never",
    "--session-id",
    sessionId,
    "x"
  ]);
});

test("invalid session IDs are rejected before command construction", () => {
  for (const sessionId of [
    "session-1234ABCD-1234-1234-1234-123456789abc",
    "session-1234abcd-1234-1234-1234-123456789ab",
    "session-1234abcd-1234-1234-1234-123456789abc\" & calc",
    "session-1234abcd-1234-1234-1234-123456789abc\n",
    ""
  ]) {
    assert.throws(
      () => buildSpawnSpec({
        command: "C:\\safe\\dsh.cmd",
        task: "x",
        sessionId,
        platform: "win32",
        comspec: "cmd.exe"
      }),
      /invalid_session_id/
    );
  }

  const handle = launchDsh({
    command: "C:\\safe\\dsh.cmd",
    cwd: process.cwd(),
    task: "x",
    sessionId: "session-invalid"
  });
  assert.equal(handle.pid, null);
  assert.equal(handle.spawnError, "invalid_session_id");
  assert.equal(typeof handle.done.then, "function");
});

test("unsafe batch command paths are rejected", () => {
  assert.throws(
    () => buildSpawnSpec({
      command: "C:\\safe&evil\\dsh.cmd",
      task: "x",
      platform: "win32",
      comspec: "cmd.exe"
    }),
    /unsafe_cmd_path/
  );
  assert.throws(
    () => buildSpawnSpec({
      command: "C:\\safe%USERPROFILE%\\dsh.bat",
      task: "x",
      platform: "win32",
      comspec: "cmd.exe"
    }),
    /unsafe_cmd_path/
  );
  assert.throws(
    () => buildSpawnSpec({
      command: "C:\\safe!PATH!\\dsh.bat",
      task: "x",
      platform: "win32",
      comspec: "cmd.exe"
    }),
    /unsafe_cmd_path/
  );
});

test("sensitive environment classes are removed", () => {
  const env = sanitizeEnv({
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    SAFE: "yes",
    QQ_GATEWAY_TOKEN: "1",
    SNOWLUMA_SECRET: "2",
    SOME_PASSWORD: "3",
    OPENAI_API_KEY: "4",
    AUTH_HEADER: "5",
    COOKIE_VALUE: "6",
    CODE_BRIDGE_TOKEN: "7",
    GATEWAY_MODE: "8"
  });
  assert.deepEqual(env, {
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    SAFE: "yes"
  });
});

test("summary extraction prioritizes NDJSON fields, redacts secrets, and caps code points", () => {
  const secret = "bridge-secret-token";
  const stdout = [
    JSON.stringify({ type: "message", message: "lower priority" }),
    JSON.stringify({ type: "result", result: `final ${secret}` })
  ].join("\n");
  assert.equal(extractSummary(stdout, secret), "final [REDACTED]");
  assert.equal(extractSummary('{"summary":"summary value"}'), "summary value");
  assert.equal(extractSummary('{"text":"text value"}'), "text value");
  assert.equal(extractSummary('{"message":"message value"}'), "message value");
  const plain = `head\n${"😀".repeat(5000)}tail`;
  const summary = extractSummary(plain);
  assert.equal([...summary].length, 4000);
  assert.equal(summary.endsWith("tail"), true);
  assert.equal(extractSummary(""), null);
  assert.equal(
    extractSummary("the original task body", null, "the original task body"),
    "[REDACTED_TASK]"
  );
});

test("token generation is at least 32 hex characters and stable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "code-bridge.token");
  const first = ensureToken(path);
  const second = ensureToken(path);
  assert.match(first, /^[0-9a-f]{32,}$/);
  assert.equal(second, first);
  assert.equal(constantTimeTokenMatch(first, first), true);
  assert.equal(constantTimeTokenMatch("wrong", first), false);
  assert.equal(constantTimeTokenMatch("", first), false);
});

test("instance lock rejects a live owner and releases only for the matching instance", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "code-bridge.lock");
  acquireInstanceLock(path, { pid: process.pid, instanceId: "instance-a", startedAt: Date.now() });
  assert.throws(
    () => acquireInstanceLock(path, { pid: process.pid, instanceId: "instance-b", startedAt: Date.now() }),
    (error) => error.code === "EALREADYLOCKED"
  );
  assert.equal(releaseInstanceLock(path, "instance-b"), false);
  assert.equal(releaseInstanceLock(path, "instance-a"), true);
  assert.equal(releaseInstanceLock(path, "instance-a"), false);
});

test("worktree root comparisons reject siblings and junction escapes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const taskId = "ct-00000000-0000-0000-0000-000000000001";
  assert.equal(isPathInside(root, join(root, "child")), true);
  assert.equal(isPathInside(root, root), false);
  assert.equal(isPathInside(root, outside), false);
  symlinkSync(outside, join(root, taskId), "junction");
  assert.throws(
    () => validateWorktreeTarget(root, taskId),
    (error) => error instanceof WorktreeError && error.message === "worktree_path_exists"
  );
});

test("a repository must exist and be the git top level", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-repo-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const subdir = join(repo, "subdir");
  mkdirSync(subdir, { recursive: true });
  assert.throws(() => validateRepoPath(subdir));
  const git = (args) => spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true
  });
  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "file.txt"), "x\n");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "initial"]);
  assert.throws(() => validateRepoPath(subdir));
  assert.equal(validateRepoPath(repo).toLowerCase(), realpathSync.native(repo).toLowerCase());
});

test("configuration defaults stay loopback-only and reject other bind hosts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const base = {
    runtimeDir: join(dir, "runtime"),
    dshCommand: "C:\\DSH\\dsh.exe",
    repos: { repo: "C:\\repo" }
  };
  writeFileSync(configPath, JSON.stringify(base), "utf8");
  const config = loadConfig(configPath);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9787);
  assert.equal(config.taskTimeoutMs, 1200000);
  assert.equal(config.worktreeRoot.toLowerCase(), "e:\\xtrump-dsh-ecosystem\\.code-worktrees");

  writeFileSync(configPath, JSON.stringify({ ...base, host: "0.0.0.0" }), "utf8");
  assert.throws(() => loadConfig(configPath), ConfigError);
  writeFileSync(configPath, JSON.stringify({ ...base, host: "localhost" }), "utf8");
  assert.throws(() => loadConfig(configPath), ConfigError);
});

test("config.example maps every alias to a Windows-local git top level", () => {
  const example = JSON.parse(readFileSync(
    join(import.meta.dirname, "../config.example.json"),
    "utf8"
  ));
  assert.equal(
    example.repos.xtds.toLowerCase(),
    "e:\\xtrump-dsh-ecosystem\\xtds-boot-suite"
  );
  for (const [alias, repoPath] of Object.entries(example.repos)) {
    assert.doesNotThrow(
      () => validateRepoPath(repoPath),
      `config.example repos.${alias} must be a git top level; update it after moving repositories`
    );
  }
});
