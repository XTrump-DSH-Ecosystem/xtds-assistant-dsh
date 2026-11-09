import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const name = arg("--name", "chatty");
const endpointFile = arg("--endpoint");
const countFile = arg("--count-file");
const lineCount = Number(arg("--lines", "24"));
const lineSize = Number(arg("--line-size", "240"));
const stderrCount = Number(arg("--stderr-lines", "4"));
const secret = process.env.TEST_SECRET ?? "";
const instanceId = randomUUID();

if (countFile) appendFileSync(countFile, `${Date.now()}\n`);

function removeOwnEndpoint() {
  if (!endpointFile) return;
  try {
    const parsed = JSON.parse(readFileSync(endpointFile, "utf8"));
    if (parsed.instanceId === instanceId) rmSync(endpointFile, { force: true });
  } catch {}
}

for (let index = 0; index < lineCount; index += 1) {
  process.stdout.write(`chatty-line-${String(index).padStart(3, "0")}-${"x".repeat(lineSize)}\n`);
}
for (let index = 0; index < stderrCount; index += 1) {
  process.stderr.write(`chatty-err-${String(index).padStart(3, "0")}-${"y".repeat(lineSize)}\n`);
}
if (secret) process.stdout.write(`chatty token=${secret}\n`);

const server = createServer((request, response) => {
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
});

const shutdown = () => {
  removeOwnEndpoint();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
