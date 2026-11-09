import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("./dummy-service.js", import.meta.url));
const child = spawn(process.execPath, [childPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true
});

const shutdown = () => {
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already have exited.
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

child.once("exit", (code) => {
  process.exit(typeof code === "number" ? code : 0);
});
