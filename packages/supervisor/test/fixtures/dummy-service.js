import { createServer } from "node:http";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const name = arg("--name", "dummy");
const endpointFile = arg("--endpoint");
const countFile = arg("--count-file");
const healthFile = arg("--health-file");
const failExit = Number(arg("--fail-exit", "0"));
const crashAfterMs = Number(arg("--crash-after-ms", "0"));
const secret = process.env.TEST_SECRET ?? "";
const instanceId = randomUUID();

if (countFile) appendFileSync(countFile, `${Date.now()}\n`);

function removeOwnEndpoint() {
  if (!endpointFile) return;
  try {
    const parsed = JSON.parse(readFileSync(endpointFile, "utf8"));
    if (parsed.instanceId === instanceId) rmSync(endpointFile, { force: true });
  } catch {
    // Nothing to clean up.
  }
}

if (secret) process.stdout.write(`startup token=${secret}\n`);

if (failExit > 0) {
  process.stderr.write(`forced startup failure token=${secret}\n`);
  setTimeout(() => process.exit(failExit), 100);
} else {
  function healthResponse() {
    let override = null;
    if (healthFile) {
      try {
        override = JSON.parse(readFileSync(healthFile, "utf8"));
      } catch {
        // Fall back to the default healthy response when no override is ready.
      }
    }
    const status = Number.isInteger(override?.status) ? override.status : 200;
    const body = typeof override?.raw === "string"
      ? override.raw
      : JSON.stringify(override?.body ?? { name, ok: true, pid: process.pid, online: true });
    return { status, body };
  }

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const { status, body } = healthResponse();
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
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
    process.stdout.write(`ready name=${name} port=${port}\n`);
    if (crashAfterMs > 0) {
      setTimeout(() => {
        removeOwnEndpoint();
        process.stderr.write("simulated crash\n");
        process.exit(23);
      }, crashAfterMs);
    }
  });

  const shutdown = () => {
    removeOwnEndpoint();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
