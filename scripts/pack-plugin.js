import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageDir = join(root, "packages", "dsh-plugin");
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
const args = npmCli
  ? [npmCli, "pack", "--pack-destination", distDir]
  : ["pack", "--pack-destination", distDir];
const result = spawnSync(command, args, {
  cwd: packageDir,
  stdio: "inherit",
  windowsHide: true,
  shell: !npmCli && process.platform === "win32"
});
process.exit(result.status ?? 1);
