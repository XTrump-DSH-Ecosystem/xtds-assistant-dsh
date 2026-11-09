import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import { DSH_ARGS, MAX_OUTPUT_BYTES, SESSION_ID_PATTERN } from "./constants.js";
import { sanitizeEnv } from "./env.js";

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.buffer = Buffer.alloc(0);
    this.truncated = false;
  }

  append(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combinedLength = this.buffer.length + value.length;
    if (combinedLength > this.limit) {
      this.truncated = true;
      const keep = combinedLength === 0 ? 0 : Math.min(this.limit, value.length);
      const prefix = combinedLength > this.limit && value.length < this.limit
        ? this.buffer.subarray(Math.max(0, this.buffer.length - (this.limit - value.length)))
        : Buffer.alloc(0);
      this.buffer = Buffer.concat([prefix, value.subarray(value.length - keep)]);
    } else {
      this.buffer = Buffer.concat([this.buffer, value]);
    }
  }

  text() {
    return this.buffer.toString("utf8");
  }
}
function sessionFlags(sessionId) {
  if (sessionId === undefined || sessionId === null) return [];
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("invalid_session_id");
  }
  return ["--session-id", sessionId];
}

function staticCmdFlags(sessionId) {
  return [...DSH_ARGS, ...sessionFlags(sessionId), "-"];
}

function assertSafeCmdCommand(command) {
  if (/[\0\r\n"!%^&|<>]/.test(command)) {
    throw new Error("unsafe_cmd_path");
  }
}

export function buildSpawnSpec({
  command,
  task,
  sessionId,
  platform = process.platform,
  comspec = process.env.ComSpec
}) {
  const extra = sessionFlags(sessionId);
  const extension = extname(command).toLowerCase();
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    assertSafeCmdCommand(command);
    const commandLine = `""${command}" ${staticCmdFlags(sessionId).join(" ")}"`;
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      stdin: task,
      windowsVerbatimArguments: true,
      taskInArgs: false
    };
  }
  return {
    command,
    args: [...DSH_ARGS, ...extra, task],
    stdin: "",
    windowsVerbatimArguments: false,
    taskInArgs: true
  };
}

function taskkillPath() {
  return process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
}

export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let killer;
    try {
      killer = spawn(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The helper may already have exited.
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish();
    }, 5000);
    timer.unref?.();
    killer.once("error", () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may already have exited.
      }
      clearTimeout(timer);
      finish();
    });
    killer.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export function launchDsh({ command, cwd, task, sessionId, env = process.env }) {
  let spec;
  try {
    spec = buildSpawnSpec({ command, task, sessionId });
  } catch (error) {
    return {
      pid: null,
      spawnError: error.message,
      done: Promise.resolve({ code: null, signal: null, spawnError: true })
    };
  }

  const stdout = new TailBuffer(MAX_OUTPUT_BYTES);
  const stderr = new TailBuffer(MAX_OUTPUT_BYTES);
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd,
      env: sanitizeEnv(env),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    return {
      pid: null,
      spawnError: "spawn_failed",
      done: Promise.resolve({ code: null, signal: null, spawnError: true })
    };
  }

  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(spec.stdin, "utf8");

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      if (!child.pid) {
        finish({
          code: null,
          signal: null,
          spawnError: true,
          spawnErrorCode: error.code === "ENOENT" ? "spawn_failed" : "spawn_error"
        });
      }
    });
    child.once("close", (code, signal) => {
      finish({
        code: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        spawnError: false
      });
    });
  });

  return {
    pid: child.pid ?? null,
    child,
    stdout,
    stderr,
    spawnError: null,
    done
  };
}
