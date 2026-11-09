#!/usr/bin/env node
import { AlreadyRunningError, LauncherError } from "../lib/errors.js";
import { runLauncher } from "../lib/launcher.js";

const USAGE = [
  "xtds-open-websearch-launcher",
  "",
  "Starts open-websearch 2.2.0 with a dynamically assigned loopback port,",
  "publishes open-websearch.endpoint.json, and stays in the foreground.",
  "",
  "Usage:",
  "  node bin/launcher.js [options]",
  "",
  "Options:",
  "  --install-dir <path>       open-websearch 2.2.0 install root",
  "                             (default: E:\\DSH-Services\\open-websearch\\2.2.0)",
  "  --entry <path>             Explicit .../open-websearch/build/index.js",
  "  --runtime-dir <path>       Endpoint/lock directory",
  "                             (default: %LOCALAPPDATA%\\DSH\\runtime)",
  "  --startup-timeout-ms <n>   Port announcement timeout (default 30000)",
  "  --status-timeout-ms <n>    /status identity timeout (default 8000)",
  "  --verbose                  Forward child stdout/stderr for diagnostics",
  "  --help, -h                 Show this help",
  "",
  "Exit codes:",
  "  0 daemon exited or launcher stopped",
  "  1 startup/identity/lifecycle failure",
  "  2 invalid arguments",
  "  3 another launcher/daemon is already running"
].join("\n");

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return number;
}

function parseArgs(argv) {
  const options = { verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--install-dir") {
      options.installDir = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--install-dir=")) {
      options.installDir = arg.slice("--install-dir=".length);
      continue;
    }
    if (arg === "--entry") {
      options.entry = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--entry=")) {
      options.entry = arg.slice("--entry=".length);
      continue;
    }
    if (arg === "--runtime-dir") {
      options.runtimeDir = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--runtime-dir=")) {
      options.runtimeDir = arg.slice("--runtime-dir=".length);
      continue;
    }
    if (arg === "--startup-timeout-ms") {
      const value = requireValue(argv, index, arg);
      options.startupTimeoutMs = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--startup-timeout-ms=")) {
      options.startupTimeoutMs = parsePositiveInteger(arg.slice("--startup-timeout-ms=".length), "--startup-timeout-ms");
      continue;
    }
    if (arg === "--status-timeout-ms") {
      const value = requireValue(argv, index, arg);
      options.statusTimeoutMs = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--status-timeout-ms=")) {
      options.statusTimeoutMs = parsePositiveInteger(arg.slice("--status-timeout-ms=".length), "--status-timeout-ms");
      continue;
    }
    throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  process.exit(2);
}

try {
  const exitCode = await runLauncher(options);
  process.exit(exitCode);
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  }
  if (error instanceof LauncherError) {
    process.stderr.write(`open-websearch launcher: [${error.code}] ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`open-websearch launcher: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
