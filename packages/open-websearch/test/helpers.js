import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = resolve(here, "..");
export const LAUNCHER_PATH = join(PACKAGE_ROOT, "bin", "launcher.js");
export const FAKE_ROOT = join(here, "fixtures", "fake-open-websearch");
export const FAKE_ENTRY = join(FAKE_ROOT, "build", "index.js");
export const ATOMIC_READER_PATH = join(here, "fixtures", "atomic-reader.js");

export function endpointPath(runtimeDir) {
  return join(runtimeDir, "open-websearch.endpoint.json");
}

export function lockPath(runtimeDir) {
  return join(runtimeDir, "open-websearch.lock");
}

export function createRuntimeDir() {
  return mkdtempSync(join(tmpdir(), "xtds-open-websearch-launcher-"));
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

export async function waitFor(predicate, timeoutMs = 10000, intervalMs = 25) {
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

export function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => rejectPromise(new Error("child exit timed out")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function spawnLauncher(runtimeDir, options = {}) {
  const args = [
    LAUNCHER_PATH,
    "--entry", options.entry ?? FAKE_ENTRY,
    "--runtime-dir", runtimeDir,
    "--startup-timeout-ms", String(options.startupTimeoutMs ?? 5000),
    "--status-timeout-ms", String(options.statusTimeoutMs ?? 2000)
  ];
  if (options.verbose) args.push("--verbose");
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-16384);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16384);
  });
  return {
    child,
    runtimeDir,
    output: () => ({ stdout, stderr })
  };
}

export async function stopEverything(handle, runtimeDir) {
  const killObserved = () => {
    const endpoint = readJsonSafe(endpointPath(runtimeDir));
    if (endpoint && endpoint.pid !== process.pid && endpoint.pid !== handle?.child?.pid) {
      killTree(endpoint.pid);
    }
    const observation = readJsonSafe(join(runtimeDir, "observation.json"));
    if (observation && observation.pid !== process.pid) {
      killTree(observation.pid);
    }
  };
  if (handle?.child && handle.child.exitCode === null) {
    if (process.platform === "win32") killTree(handle.child.pid);
    else {
      try {
        handle.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await waitForExit(handle.child, 5000).catch(() => {});
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    killObserved();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  handle?.child?.stdout?.destroy();
  handle?.child?.stderr?.destroy();
}
