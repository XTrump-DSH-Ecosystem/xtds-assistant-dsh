import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const targets = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "runtime" || name === "dist") continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) targets.push(full);
  }
}

walk(root);

let failed = false;
for (const file of targets) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`FAIL ${relative(root, file)}\n${result.stderr ?? ""}`);
  }
}

if (failed) process.exitCode = 1;
else process.stdout.write(`node --check: ${targets.length} files OK\n`);
