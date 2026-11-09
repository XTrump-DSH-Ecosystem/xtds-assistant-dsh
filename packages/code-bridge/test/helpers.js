import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config.js";
import { startCodeBridge } from "../lib/service.js";

export const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/fake-dsh.js");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function git(cwd, args, env = process.env) {
  const result = run("git", args, { cwd, env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRepo(dir) {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Code Bridge Test"]);
  git(repo, ["config", "user.email", "code-bridge@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "baseline\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  git(repo, ["commit", "--allow-empty", "-q", "-m", "empty"]);
  return repo;
}

function createWrapper(dir, mode) {
  const binDir = join(dir, "fake dsh bin");
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, "fake-dsh.cmd");
  writeFileSync(
    wrapper,
    `@echo off\r\n"${process.execPath}" "${FIXTURE_PATH}" ${mode} %*\r\nexit /b %errorlevel%\r\n`,
    "utf8"
  );
  return wrapper;
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function createHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "code-bridge-test-"));
  const repo = createRepo(dir);
  const runtimeDir = join(dir, "runtime");
  const worktreeRoot = join(dir, "worktrees");
  const dshSessionsDir = options.dshSessionsDir ?? join(dir, "sessions");
  const dshWorkspaceRoot = options.dshWorkspaceRoot ?? join(dir, "deepseek-harness");
  const observationPath = join(dir, "observation.json");
  const pidsPath = join(dir, "pids.json");
  const mode = options.mode ?? "success";
  const dshCommand = createWrapper(dir, mode);
  const extraRepos = options.extraRepos ?? {};
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: options.port ?? 0,
    runtimeDir,
    worktreeRoot,
    dshSessionsDir,
    dshWorkspaceRoot,
    dshCommand,
    taskTimeoutMs: options.taskTimeoutMs ?? 5000,
    workspaceRoots: options.workspaceRoots ?? [],
    repos: {
      test: repo,
      ...extraRepos
    }
  }, null, 2), "utf8");
  const env = {
    ...process.env,
    FAKE_DSH_OBSERVATION: observationPath,
    FAKE_DSH_PIDS: pidsPath,
    ...(options.env ?? {})
  };
  const config = loadConfig(configPath, { env });
  const harness = {
    dir,
    repo,
    runtimeDir,
    worktreeRoot,
    dshSessionsDir,
    dshWorkspaceRoot,
    observationPath,
    pidsPath,
    configPath,
    config,
    env,
    service: null,
    async start(extra = {}) {
      this.service = await startCodeBridge(this.config, { env: this.env, ...extra });
      return this.service;
    },
    async stop() {
      if (this.service !== null) {
        const service = this.service;
        this.service = null;
        await service.stop().catch(() => {});
      }
    },
    observation() {
      return existsSync(observationPath) ? readJson(observationPath) : null;
    },
    pids() {
      return existsSync(pidsPath) ? readJson(pidsPath) : null;
    },
    cleanup() {
      const pids = this.pids();
      if (pids !== null) {
        for (const pid of Object.values(pids)) {
          if (Number.isInteger(pid)) {
            run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
          }
        }
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    }
  };
  return harness;
}

export function newSessionId() {
  return `session-${randomUUID()}`;
}

export function writeSessionFile(dir, options) {
  const sessionId = options.sessionId ?? newSessionId();
  const createdAt = options.createdAt ?? Date.now();
  const lastPromptAt = options.lastPromptAt === undefined ? createdAt : options.lastPromptAt;
  const metadata = {
    blank: options.blank === true,
    lastPromptAt
  };
  const rows = options.rowsArray === true
    ? [
      { key: "title", ver: 1, seq: 1, val: { ver: 1, seq: 1, val: options.title ?? null } },
      {
        key: "sessionListMetadata",
        ver: 1,
        seq: 1,
        val: { ver: 1, seq: 1, val: metadata }
      }
    ]
    : {
      title: { ver: 1, seq: 1, val: options.title ?? null },
      sessionListMetadata: { ver: 1, seq: 1, val: metadata }
    };
  if (options.agentPreset !== undefined) {
    const row = { ver: 1, seq: 1, val: options.agentPreset };
    if (Array.isArray(rows)) {
      rows.push({ key: "agentPreset", ...row });
    } else {
      rows.agentPreset = row;
    }
  }
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify({
    version: 7,
    record: {
      identity: {
        formatVersion: 4,
        createdAt,
        cwd: options.cwd
      },
      rows
    }
  }), "utf8");
  return { sessionId, filePath };
}

export function api(service, path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers ?? {}) };
  const token = Object.hasOwn(options, "token") ? options.token : service.token;
  if (typeof token === "string" && token.length > 0) headers["x-code-bridge-token"] = token;
  let body = options.body;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers["content-type"] = "application/json";
  } else if (body !== undefined) {
    body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return fetch(`${service.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
    signal: AbortSignal.timeout(30000)
  }).then(async (response) => {
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, text };
  });
}

export async function submit(service, body, options = {}) {
  return api(service, "/v1/tasks", { method: "POST", body, ...options });
}

export async function waitFor(predicate, timeoutMs = 10000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`timed out waiting for condition${lastError ? `: ${lastError.message}` : ""}`);
}

export async function waitForTask(service, taskId, predicate, timeoutMs = 10000) {
  return waitFor(async () => {
    const response = await api(service, `/v1/tasks/${taskId}`);
    if (response.status !== 200) return null;
    return predicate(response.data.task) ? response.data.task : null;
  }, timeoutMs);
}

export function startHarness(t, options = {}) {
  const harness = createHarness(options);
  t.after(async () => {
    await harness.stop();
    harness.cleanup();
  });
  return harness.start().then(() => harness);
}

export function repoStatus(repo) {
  return git(repo, ["status", "--porcelain"]);
}

export function repoHead(repo) {
  return git(repo, ["rev-parse", "HEAD"]);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnCli(args, options = {}) {
  return spawn(process.execPath, [join(import.meta.dirname, "../bin/code-bridge.js"), ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
