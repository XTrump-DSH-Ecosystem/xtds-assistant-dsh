import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

if (process.argv.includes("--late-writer")) {
  setTimeout(() => {
    process.stdout.write("LATE-GRANDCHILD-LINE\n");
    process.exit(0);
  }, Number(arg("--delay-ms", "500")));
} else {
  const name = arg("--name", "late-stdout");
  const endpointFile = arg("--endpoint");
  const manualExit = process.argv.includes("--manual-exit");
  const instanceId = randomUUID();
  let exitRequested = false;

  function spawnLateGrandchild() {
    const grandchild = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      "--late-writer",
      "--delay-ms",
      arg("--grandchild-delay-ms", "500")
    ], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "inherit", "ignore"]
    });
    grandchild.unref();
  }

  function removeOwnEndpoint() {
    if (!endpointFile) return;
    try {
      const parsed = JSON.parse(readFileSync(endpointFile, "utf8"));
      if (parsed.instanceId === instanceId) rmSync(endpointFile, { force: true });
    } catch {}
  }

  const server = createServer((request, response) => {
    if (request.url === "/exit") {
      if (!exitRequested) {
        exitRequested = true;
        spawnLateGrandchild();
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("exiting\n");
        setTimeout(() => {
          removeOwnEndpoint();
          process.exit(0);
        }, 100);
      } else {
        response.writeHead(409, { "content-type": "text/plain" });
        response.end("already exiting\n");
      }
      return;
    }
    if (request.url === "/health") {
      const body = JSON.stringify({ name, ok: true, pid: process.pid });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    if (endpointFile) {
      writeFileSync(endpointFile, `${JSON.stringify({
        v: 1,
        name,
        host: "127.0.0.1",
        port,
        pid: process.pid,
        startedAt: Date.now(),
        instanceId
      })}\n`);
    }

    if (!manualExit) {
      setTimeout(spawnLateGrandchild, Number(arg("--spawn-grandchild-ms", "800")));

      setTimeout(() => {
        removeOwnEndpoint();
        process.exit(0);
      }, Number(arg("--exit-after-ms", "1000")));
    }
  });
}
