#!/usr/bin/env node
import { createLogger } from "../lib/logger.js";
import { AlreadyRunningError, inspectConfig, runSelftest, startSupervisor, VERSION } from "../lib/supervisor.js";

function usage() {
  process.stdout.write([
    "xtds-assistant-supervisor",
    "",
    "Usage:",
    "  node bin/supervisor.js [--config <path>] [--start-services]",
    "  node bin/supervisor.js --config <path> --check",
    "  node bin/supervisor.js --config <path> --selftest",
    "",
    "Options:",
    "  --config <path>   Supervisor JSON config (default config/supervisor.json)",
    "  --start-services Start managed services after the API is available",
    "  --check           Validate resolved configuration and exit",
    "  --selftest        Run local configuration checks and exit",
    "  --version         Print the supervisor version",
    "  --help            Show this help",
    ""
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    configPath: undefined,
    startServices: false,
    check: false,
    selftest: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--config requires a path");
      options.configPath = value;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
    } else if (arg === "--start-services") {
      options.startServices = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--version") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const logger = createLogger();
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n`);
  usage();
  process.exit(2);
}

if (options.check) {
  try {
    const result = inspectConfig(options.configPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (options.selftest) {
  try {
    const result = runSelftest(options.configPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

let supervisor;
let stopping = false;

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  try {
    if (supervisor) await supervisor.shutdown(reason);
  } catch (error) {
    logger.error(`shutdown failed: ${error.message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
if (process.platform === "win32") process.on("SIGBREAK", () => void stop("SIGBREAK"));

try {
  supervisor = await startSupervisor({
    configPath: options.configPath,
    startServices: options.startServices,
    logger
  });
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    logger.error(error.message);
    process.exit(3);
  }
  logger.error(`supervisor failed to start: ${error.message}`);
  process.exit(1);
}

process.stdout.write(`xtds-assistant-supervisor ${VERSION} ready\n`);
