#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { VERSION } from "../lib/constants.js";
import { validateRepoPath } from "../lib/git.js";
import { AlreadyRunningError, ConfigError } from "../lib/errors.js";
import { startCodeBridge } from "../lib/service.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function usage() {
  return [
    "Usage: code-bridge [--config <path>] [--check]",
    "",
    "Options:",
    "  --config <path>  Configuration file (default: <package>/config.json)",
    "  --check          Validate configuration without starting the service",
    "  --help           Show this help",
    "  --version        Show the package version"
  ].join("\n");
}

function parseArgs(argv) {
  let configPath = process.env.CODE_BRIDGE_CONFIG || join(packageRoot, "config.json");
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigError("--config requires a path");
      }
      configPath = value;
      index += 1;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg === "--version" || arg === "-v") {
      return { version: true };
    } else {
      throw new ConfigError(`unknown argument: ${arg}`);
    }
  }
  return { configPath, check };
}

function inspectConfig(config) {
  const repos = {};
  for (const alias of Object.keys(config.repos)) {
    repos[alias] = validateRepoPath(config.repos[alias]);
  }
  if (!existsSync(config.dshCommand) || !statSync(config.dshCommand).isFile()) {
    throw new ConfigError("dshCommand does not exist or is not a file");
  }
  return {
    ok: true,
    host: config.host,
    port: config.port,
    runtimeDir: config.runtimeDir,
    worktreeRoot: config.worktreeRoot,
    dshSessionsDir: config.dshSessionsDir,
    dshWorkspaceRoot: config.dshWorkspaceRoot,
    workspaceRoots: config.workspaceRoots,
    dshCommand: config.dshCommand,
    taskTimeoutMs: config.taskTimeoutMs,
    repos
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig(parsed.configPath);
    if (parsed.check) {
      process.stdout.write(`${JSON.stringify(inspectConfig(config), null, 2)}\n`);
      return;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof ConfigError ? 2 : 1;
    return;
  }

  let service;
  try {
    service = await startCodeBridge(config);
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    process.stderr.write(`code-bridge failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`code-bridge listening on http://127.0.0.1:${service.port}\n`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.stop();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => {
    shutdown().finally(() => process.exit());
  });
  process.once("SIGTERM", () => {
    shutdown().finally(() => process.exit());
  });
}

await main();
