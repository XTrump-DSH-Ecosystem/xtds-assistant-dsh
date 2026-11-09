import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

function writeObservation(mode, args, task) {
  const observationPath = process.env.FAKE_DSH_OBSERVATION;
  if (!observationPath) return;
  writeFileSync(observationPath, JSON.stringify({
    mode,
    args,
    task,
    cwd: process.cwd(),
    pid: process.pid,
    sensitiveKeys: [
      "QQ_GATEWAY_TOKEN",
      "API_KEY",
      "AUTH_HEADER",
      "SNOWLUMA_SECRET",
      "SOME_PASSWORD",
      "OPENAI_API_KEY",
      "CODE_BRIDGE_TOKEN"
    ].filter((name) => Object.hasOwn(process.env, name))
  }), "utf8");
}

const [mode, ...args] = process.argv.slice(2);
const task = await readStdin();
writeObservation(mode, args, task);

if (mode === "success") {
  appendFileSync("README.md", "\nworktree change\n", "utf8");
  writeFileSync("new-file.txt", "new file\n", "utf8");
  process.stdout.write(`${JSON.stringify({ type: "result", result: "fake success summary" })}\n`);
} else if (mode === "failure") {
  process.stderr.write(`FAKE-STDERR-MARKER\n${"x".repeat(70 * 1024)}`);
  process.exitCode = 7;
} else if (mode === "preset-error") {
  process.stderr.write(
    'dsh: session "session-00000000-0000-4000-8000-000000000000" runs under agent preset "standard", which the one-shot runner does not compose\n'
  );
  process.exitCode = 1;
} else if (mode === "large") {
  process.stdout.write(`EARLY-OUTPUT-MARKER\n${"y".repeat(70 * 1024)}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", result: "large success summary" })}\n`);
} else if (mode === "plain") {
  process.stdout.write(`PLAIN-START\n${"p".repeat(5000)}PLAIN-TAIL`);
} else if (mode === "timeout" || mode === "cancel" || mode === "hang") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  if (process.env.FAKE_DSH_PIDS) {
    writeFileSync(process.env.FAKE_DSH_PIDS, JSON.stringify({
      self: process.pid,
      grandchild: grandchild.pid
    }), "utf8");
  }
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("unknown fake mode\n");
  process.exitCode = 9;
}
