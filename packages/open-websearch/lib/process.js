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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function terminateChild(child, timeoutMs = 3000) {
  if (child === null || child === undefined) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(forceTimer);
      resolve();
    };
    const graceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      forceTimer = setTimeout(finish, 250);
    }, timeoutMs);
    child.once("exit", finish);
    try {
      if (!child.kill("SIGTERM")) finish();
    } catch {
      finish();
    }
  });
}
