import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const command = argv[0];
if (command !== "serve") {
  process.stderr.write(`fake open-websearch: unexpected command ${command}\n`);
  process.exit(2);
}

function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const host = argValue("--host");
const portArgument = argValue("--port");
const observationFile = process.env.FAKE_OWS_OBSERVATION_FILE;
if (observationFile) {
  writeFileSync(observationFile, JSON.stringify({
    argv,
    pid: process.pid,
    cwd: process.cwd(),
    env: {
      OPEN_WEBSEARCH_DAEMON_PORT: process.env.OPEN_WEBSEARCH_DAEMON_PORT ?? null,
      OPEN_WEBSEARCH_DAEMON_URL: process.env.OPEN_WEBSEARCH_DAEMON_URL ?? null
    }
  }, null, 2));
}

if (host !== "127.0.0.1" || portArgument !== "0") {
  process.stderr.write(
    `fake open-websearch: expected --host 127.0.0.1 --port 0, got ${String(host)} ${String(portArgument)}\n`
  );
  process.exit(2);
}

const mode = process.env.FAKE_OWS_STATUS_MODE || "valid";
let baseUrl = "";
let exitTimer = null;

function buildStatus() {
  const summary = {
    defaultSearchEngine: "bing",
    allowedSearchEngines: [],
    searchMode: "request",
    effectiveSearchMode: "request",
    playwrightAvailable: false,
    playwrightUnavailableReason: "C:\\secret-playwright-path\\browser.exe",
    useProxy: false,
    fetchWebAllowInsecureTls: false
  };
  const data = {
    daemon: "running",
    runtime: "ready",
    activation: "active",
    version: "2.2.0",
    capabilities: ["search", "fetch-web"],
    baseUrl,
    configSummary: summary
  };
  if (mode === "wrong-version") data.version = "2.2.1";
  else if (mode === "wrong-base-url") data.baseUrl = "http://127.0.0.1:1";
  else if (mode === "wrong-identity") data.daemon = "stopped";
  else if (mode === "runtime-not-ready") data.runtime = "starting";
  else if (mode === "missing-capability") data.capabilities = ["search"];
  else if (mode === "proxy-enabled") summary.useProxy = true;
  else if (mode === "insecure-tls") summary.fetchWebAllowInsecureTls = true;
  return {
    status: "ok",
    data,
    error: null,
    hint: null
  };
}

const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/status") {
    response.statusCode = 404;
    response.setHeader("content-type", "text/plain");
    response.end("not found");
    return;
  }
  if (mode === "http-500") {
    response.statusCode = 500;
    response.end("error");
    return;
  }
  response.setHeader("content-type", "application/json");
  if (mode === "invalid-json") {
    response.end("{");
    return;
  }
  if (mode === "invalid-envelope") {
    response.end(JSON.stringify({
      status: "error",
      data: null,
      error: { code: "invalid", message: "no" },
      hint: null
    }));
    return;
  }
  response.end(JSON.stringify(buildStatus()));
});

function stop() {
  if (exitTimer !== null) {
    clearInterval(exitTimer);
    exitTimer = null;
  }
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250);
}

function armExitWatcher() {
  const exitFile = process.env.FAKE_OWS_EXIT_FILE;
  if (!exitFile) return;
  let stopping = false;
  exitTimer = setInterval(() => {
    if (stopping || !existsSync(exitFile)) return;
    stopping = true;
    stop();
  }, 50);
}

server.on("error", (error) => {
  process.stderr.write(`fake open-websearch: ${error.message}\n`);
  process.exit(1);
});

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.stderr.write("fake open-websearch: failed to resolve address\n");
    process.exit(1);
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  if (process.env.FAKE_OWS_EXIT_BEFORE_ANNOUNCE === "1") {
    setTimeout(() => process.exit(7), 50);
    return;
  }
  if (process.env.FAKE_OWS_NO_ANNOUNCE !== "1") {
    const announcedPort = process.env.FAKE_OWS_ANNOUNCE_PORT === "0" ? 0 : address.port;
    console.log(`Local open-websearch daemon running at http://127.0.0.1:${announcedPort}`);
  }
  armExitWatcher();
});
