import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ENDPOINT_FILE_NAME,
  EXPECTED_VERSION,
  createEndpoint,
  inspectEndpoint,
  removeEndpoint,
  removeEndpointIfOwned,
  writeEndpointAtomic
} from "./endpoint.js";
import { AlreadyRunningError, LauncherError } from "./errors.js";
import { ensureDir, fileExists, readJson } from "./fs-utils.js";
import { LOCK_FILE_NAME, acquireLock, releaseLock } from "./lock.js";
import { terminateChild } from "./process.js";
import { waitForStatus } from "./status.js";

export { EXPECTED_VERSION };

export const DEFAULT_INSTALL_DIR = "E:\\DSH-Services\\open-websearch\\2.2.0";
export const EXPECTED_PACKAGE_NAME = "open-websearch";
export const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
export const DEFAULT_STATUS_TIMEOUT_MS = 8000;
export const SHUTDOWN_TIMEOUT_MS = 3000;

const MAX_OUTPUT_TAIL_CHARS = 8192;
const ANNOUNCEMENT_PATTERN = /^Local open-websearch daemon running at (http:\/\/127\.0\.0\.1:(\d{1,5}))$/;

function sanitize(value) {
  return String(value).slice(0, 64).replace(/[\r\n]/g, " ");
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeExitCode(code, signal) {
  if (Number.isInteger(code) && code >= 0) return Math.min(code, 255);
  return signal ? 1 : 1;
}

export function resolveRuntimeDir(explicit, env = process.env) {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return resolve(explicit);
  }
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.trim() === "") {
    throw new LauncherError(
      "runtime_dir_unavailable",
      "LOCALAPPDATA is not set; pass --runtime-dir explicitly"
    );
  }
  return join(localAppData, "DSH", "runtime");
}

export function resolveInstallPaths({ installDir, entry } = {}, env = process.env) {
  const baseDir = typeof installDir === "string" && installDir.trim() !== ""
    ? resolve(installDir)
    : resolve(env.OPEN_WEBSEARCH_HOME || DEFAULT_INSTALL_DIR);
  const entryPath = typeof entry === "string" && entry.trim() !== ""
    ? resolve(entry)
    : join(baseDir, "node_modules", "open-websearch", "build", "index.js");
  return {
    installDir: baseDir,
    entryPath,
    packageRoot: resolve(dirname(entryPath), "..")
  };
}

export function validateInstalledPackage(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  if (!fileExists(manifestPath)) {
    throw new LauncherError(
      "package_manifest_missing",
      `open-websearch package manifest not found: ${manifestPath}`
    );
  }
  const manifest = readJson(manifestPath, null);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new LauncherError("package_manifest_invalid", "open-websearch package manifest is not a JSON object");
  }
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (name !== EXPECTED_PACKAGE_NAME) {
    throw new LauncherError(
      "package_identity_mismatch",
      `open-websearch package identity mismatch: expected ${EXPECTED_PACKAGE_NAME}, found ${sanitize(name) || "(missing)"}`
    );
  }
  if (version !== EXPECTED_VERSION) {
    throw new LauncherError(
      "package_version_mismatch",
      `open-websearch package version mismatch: expected ${EXPECTED_VERSION}, found ${sanitize(version) || "(missing)"}`
    );
  }
  return { name, version };
}

function assertEntryFile(entryPath) {
  if (!fileExists(entryPath)) {
    throw new LauncherError("entry_not_found", `open-websearch entry file not found: ${entryPath}`);
  }
  if (!statSync(entryPath).isFile()) {
    throw new LauncherError("entry_not_file", `open-websearch entry is not a file: ${entryPath}`);
  }
}

const FORCED_SAFE_DAEMON_ENV = Object.freeze({
  USE_PROXY: "false",
  FETCH_WEB_INSECURE_TLS: "false",
  ENABLE_CORS: "false",
  FAKE_IP_CIDRS: ""
});

export function buildChildEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "OPEN_WEBSEARCH_DAEMON_PORT" ||
      normalized === "OPEN_WEBSEARCH_DAEMON_URL" ||
      Object.hasOwn(FORCED_SAFE_DAEMON_ENV, normalized)
    ) {
      delete childEnv[key];
    }
  }
  return { ...childEnv, ...FORCED_SAFE_DAEMON_ENV };
}

function attachOutput(child, { verbose = false, stderr = process.stderr } = {}) {
  let stdoutBuffer = "";
  let stdoutTail = "";
  let stderrTail = "";
  let lineHandler = null;
  const appendTail = (current, text) => {
    const next = current + text;
    return next.length > MAX_OUTPUT_TAIL_CHARS ? next.slice(-MAX_OUTPUT_TAIL_CHARS) : next;
  };
  const writeVerbose = (streamName, text) => {
    if (!verbose) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) stderr.write(`[open-websearch ${streamName}] ${line}\n`);
    }
  };
  const onStdout = (chunk) => {
    const text = chunk.toString("utf8");
    stdoutTail = appendTail(stdoutTail, text);
    writeVerbose("stdout", text);
    stdoutBuffer = appendTail(stdoutBuffer, text);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (lineHandler !== null) lineHandler(line.trim());
    }
  };
  const onStderr = (chunk) => {
    const text = chunk.toString("utf8");
    stderrTail = appendTail(stderrTail, text);
    writeVerbose("stderr", text);
  };
  if (child.stdout) child.stdout.on("data", onStdout);
  if (child.stderr) child.stderr.on("data", onStderr);
  return {
    tail() {
      return { stdout: stdoutTail, stderr: stderrTail };
    },
    setLineHandler(handler) {
      lineHandler = handler;
    },
    dispose() {
      if (child.stdout) child.stdout.removeListener("data", onStdout);
      if (child.stderr) child.stderr.removeListener("data", onStderr);
    }
  };
}

function waitForAnnouncement(child, output, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      rejectPromise(new LauncherError(
        "child_exited_before_ready",
        `open-websearch exited before announcing a port (code ${child.exitCode ?? "null"}`
        + `${child.signalCode ? `, signal ${child.signalCode}` : ""})`
      ));
      return;
    }
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.setLineHandler(null);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback(value);
    };
    const onError = () => {
      finish(rejectPromise, new LauncherError("spawn_failed", "failed to spawn open-websearch"));
    };
    const onExit = (code, signal) => {
      finish(
        rejectPromise,
        new LauncherError(
          "child_exited_before_ready",
          `open-websearch exited before announcing a port (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`
        )
      );
    };
    output.setLineHandler((line) => {
      const match = ANNOUNCEMENT_PATTERN.exec(line);
      if (match === null) return;
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        finish(rejectPromise, new LauncherError("invalid_announced_port", "open-websearch announced an invalid port"));
        return;
      }
      finish(resolvePromise, { baseUrl: match[1], port });
    });
    timer = setTimeout(() => {
      finish(
        rejectPromise,
        new LauncherError("startup_timeout", `open-websearch did not announce a port within ${timeoutMs}ms`)
      );
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function runLauncher(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runtimeDir = resolveRuntimeDir(options.runtimeDir, env);
  ensureDir(runtimeDir);
  const lockPath = join(runtimeDir, LOCK_FILE_NAME);
  const endpointPath = join(runtimeDir, ENDPOINT_FILE_NAME);
  const paths = resolveInstallPaths({ installDir: options.installDir, entry: options.entry }, env);
  const startupTimeoutMs = positiveTimeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const statusTimeoutMs = positiveTimeout(options.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS);

  const instanceId = randomUUID();
  acquireLock(lockPath, { instanceId, createdAt: new Date().toISOString() });

  let child = null;
  let endpointWritten = false;
  let shuttingDown = false;
  let signalReceived = 0;
  let resolveSignal;
  const signalPromise = new Promise((resolvePromise) => {
    resolveSignal = resolvePromise;
  });

  const childPid = () => (child !== null && Number.isInteger(child.pid) ? child.pid : undefined);
  const removeOwnedEndpoint = () => {
    if (!endpointWritten) return;
    removeEndpointIfOwned(endpointPath, { pid: childPid(), instanceId });
  };
  const cleanup = () => {
    removeOwnedEndpoint();
    releaseLock(lockPath, { pid: process.pid, instanceId });
  };
  const cleanupOnExit = () => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // Best effort during process exit.
      }
    }
    cleanup();
  };
  const onSignal = () => {
    signalReceived += 1;
    if (signalReceived > 1) {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      cleanup();
      process.exit(1);
    }
    if (shuttingDown) return;
    shuttingDown = true;
    removeOwnedEndpoint();
    void terminateChild(child, SHUTDOWN_TIMEOUT_MS).then(() => {
      cleanup();
      resolveSignal(0);
    });
  };

  process.once("exit", cleanupOnExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (process.platform === "win32") process.once("SIGBREAK", onSignal);

  try {
    const existing = inspectEndpoint(endpointPath);
    if (existing.state === "live") {
      throw new AlreadyRunningError(
        `open-websearch daemon is already running (pid ${existing.endpoint.pid})`,
        { pid: existing.endpoint.pid }
      );
    }
    if (existing.state === "mismatch") {
      throw new LauncherError(
        "endpoint_identity_mismatch",
        "existing open-websearch endpoint has a live pid but invalid identity/version; refusing to replace it"
      );
    }
    if (existing.state === "invalid" || existing.state === "stale") {
      removeEndpoint(endpointPath);
    }

    validateInstalledPackage(paths.packageRoot);
    assertEntryFile(paths.entryPath);

    const startup = (async () => {
      if (shuttingDown) {
        throw new LauncherError("shutdown_requested", "shutdown requested before startup");
      }
      child = spawn(
        process.execPath,
        [paths.entryPath, "serve", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: dirname(paths.packageRoot),
          env: buildChildEnv(env),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        throw new LauncherError("spawn_failed", "open-websearch child did not start");
      }
      if (shuttingDown) {
        throw new LauncherError("shutdown_requested", "shutdown requested during startup");
      }
      const childStartedAt = new Date().toISOString();
      const output = attachOutput(child, { verbose: options.verbose === true, stderr });
      const announcement = await waitForAnnouncement(child, output, startupTimeoutMs);
      if (shuttingDown) {
        throw new LauncherError("shutdown_requested", "shutdown requested during startup");
      }
      await waitForStatus(announcement.baseUrl, statusTimeoutMs);
      if (shuttingDown) {
        throw new LauncherError("shutdown_requested", "shutdown requested during startup");
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new LauncherError("child_exited_before_ready", "open-websearch exited before the endpoint was published");
      }
      const endpoint = createEndpoint({
        port: announcement.port,
        pid: child.pid,
        instanceId,
        startedAt: childStartedAt
      });
      writeEndpointAtomic(endpointPath, endpoint);
      endpointWritten = true;
      return endpoint;
    })();

    const startupOutcome = await Promise.race([
      startup,
      signalPromise.then(() => null)
    ]);
    if (startupOutcome === null) {
      startup.catch(() => {});
      await terminateChild(child, SHUTDOWN_TIMEOUT_MS);
      cleanup();
      return 0;
    }

    const endpoint = startupOutcome;
    stdout.write(`open-websearch launcher ready at ${endpoint.baseUrl} (pid ${endpoint.pid})\n`);

    const runtimeOutcome = await Promise.race([
      new Promise((resolvePromise) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolvePromise({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      signalPromise.then(() => null)
    ]);

    if (runtimeOutcome === null || shuttingDown) {
      await terminateChild(child, SHUTDOWN_TIMEOUT_MS);
      cleanup();
      return 0;
    }

    cleanup();
    if (runtimeOutcome.code !== 0 || runtimeOutcome.signal !== null) {
      stderr.write(
        `open-websearch launcher: daemon exited (code ${runtimeOutcome.code ?? "null"}`
        + `${runtimeOutcome.signal ? `, signal ${runtimeOutcome.signal}` : ""})\n`
      );
    }
    return normalizeExitCode(runtimeOutcome.code, runtimeOutcome.signal);
  } catch (error) {
    await terminateChild(child, SHUTDOWN_TIMEOUT_MS);
    cleanup();
    throw error;
  } finally {
    process.removeListener("exit", cleanupOnExit);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGBREAK", onSignal);
  }
}
