import { randomUUID } from "node:crypto";
import { NAME, VERSION } from "./constants.js";
import { AlreadyRunningError } from "./errors.js";
import { ensureDir } from "./fs-utils.js";
import { TaskManager } from "./manager.js";
import { createApiServer } from "./server.js";
import {
  acquireInstanceLock,
  assertNoLiveEndpoint,
  endpointFilePath,
  ensureToken,
  lockFilePath,
  removeEndpointIfOwned,
  releaseInstanceLock,
  tokenFilePath,
  writeEndpoint
} from "./runtime.js";

export async function startCodeBridge(config, options = {}) {
  ensureDir(config.runtimeDir);
  const env = options.env ?? process.env;
  const endpointPath = endpointFilePath(config.runtimeDir);
  const existing = assertNoLiveEndpoint(endpointPath);
  if (existing !== null) {
    throw new AlreadyRunningError(`code-bridge already running (pid ${existing.pid})`);
  }

  const startedAt = Date.now();
  const instanceId = randomUUID();
  const lockPath = lockFilePath(config.runtimeDir);
  try {
    acquireInstanceLock(lockPath, { pid: process.pid, instanceId, startedAt });
  } catch (error) {
    if (error.code === "EALREADYLOCKED") throw new AlreadyRunningError(error.message);
    throw error;
  }

  let token;
  let manager;
  let api;
  try {
    token = ensureToken(tokenFilePath(config.runtimeDir));
    manager = new TaskManager({ config, token, env });
    manager.initialize();
    api = createApiServer({ manager, token, startedAt, port: config.port });
    const listening = await api.listen();
    writeEndpoint(endpointPath, {
      port: listening.port,
      pid: process.pid,
      startedAt,
      instanceId
    });
    manager.start();

    let stopPromise = null;
    return {
      name: NAME,
      version: VERSION,
      token,
      manager,
      server: api.server,
      endpoint: endpointPath,
      port: listening.port,
      fellBack: listening.fellBack,
      baseUrl: `http://127.0.0.1:${listening.port}`,
      stop() {
        if (stopPromise !== null) return stopPromise;
        stopPromise = (async () => {
          try {
            await api.close();
          } finally {
            try {
              await manager.stop();
            } finally {
              removeEndpointIfOwned(endpointPath, { pid: process.pid, instanceId });
              releaseInstanceLock(lockPath, instanceId);
            }
          }
        })();
        return stopPromise;
      }
    };
  } catch (error) {
    if (api !== undefined) {
      await api.close().catch(() => {});
    }
    if (manager !== undefined) await manager.stop().catch(() => {});
    removeEndpointIfOwned(endpointPath, { pid: process.pid, instanceId });
    releaseInstanceLock(lockPath, instanceId);
    throw error;
  }
}
