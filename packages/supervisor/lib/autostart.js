import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureDir, writeFileAtomic } from "./fs-utils.js";

const execFileAsync = promisify(execFile);
const SCHTASKS = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "schtasks.exe")
  : "schtasks.exe";
const REG = process.env.SystemRoot
  ? join(process.env.SystemRoot, "System32", "reg.exe")
  : "reg.exe";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

function commandLineQuote(value) {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

function registryCommand(scriptPath) {
  return `cmd.exe /d /c ""${scriptPath}""`;
}

export class AutostartError extends Error {
  constructor(message) {
    super(message);
    this.name = "AutostartError";
  }
}

function defaultStartupDir(env) {
  const appData = env.APPDATA
    ?? (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Roaming") : "");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function currentUser(env) {
  const domain = env.USERDOMAIN || env.COMPUTERNAME || "";
  const user = env.USERNAME || "";
  return domain ? `${domain}\\${user}` : user;
}

export class AutostartManager {
  constructor({
    taskName,
    startScriptPath,
    backend = "registry",
    startupDir,
    registryKey = RUN_KEY,
    registryValueName = taskName,
    platform = process.platform,
    env = process.env
  }) {
    this.taskName = taskName;
    this.startScriptPath = startScriptPath;
    this.backend = backend;
    this.startupDir = startupDir ?? defaultStartupDir(env);
    this.startupFilePath = join(this.startupDir, `${taskName}.cmd`);
    this.registryKey = registryKey;
    this.registryValueName = registryValueName;
    this.platform = platform;
    this.env = env;
  }

  get supported() {
    return this.platform === "win32";
  }

  async status() {
    if (!this.supported) {
      return { supported: false, enabled: false, taskName: this.taskName, backend: this.backend, error: "Windows only" };
    }
    try {
      const exists = await this.exists();
      return {
        supported: true,
        enabled: exists,
        taskName: this.taskName,
        backend: this.backend,
        ...(this.backend === "startup" ? { path: this.startupFilePath } : {}),
        ...(this.backend === "registry" ? { path: this.registryKey } : {})
      };
    } catch (error) {
      return {
        supported: true,
        enabled: false,
        taskName: this.taskName,
        backend: this.backend,
        error: this.redactError(error)
      };
    }
  }

  async exists() {
    if (this.backend === "startup") return existsSync(this.startupFilePath);
    if (this.backend === "registry") {
      const result = await this.run(["QUERY", this.registryKey, "/v", this.registryValueName], {
        reject: false
      });
      return result.code === 0;
    }
    const result = await this.run(["/Query", "/TN", this.taskName], { reject: false });
    return result.code === 0;
  }

  async enable() {
    if (!this.supported) throw new AutostartError("autostart is implemented for Windows only");
    if (!existsSync(this.startScriptPath)) {
      throw new AutostartError(`start script is missing: ${this.startScriptPath}`);
    }
    if (this.backend === "startup") {
      ensureDir(this.startupDir);
      writeFileAtomic(
        this.startupFilePath,
        `@echo off\r\ncall ${commandLineQuote(this.startScriptPath)}\r\n`,
        0o700
      );
      return this.status();
    }
    if (this.backend === "registry") {
      await this.run([
        "ADD",
        this.registryKey,
        "/v",
        this.registryValueName,
        "/t",
        "REG_SZ",
        "/d",
        registryCommand(this.startScriptPath),
        "/f"
      ]);
      return this.status();
    }
    const dir = mkdtempSync(join(tmpdir(), "xtds-autostart-"));
    const xmlPath = join(dir, "task.xml");
    writeFileSync(xmlPath, `\uFEFF${this.buildTaskXml()}`, "utf16le");
    try {
      await this.run([
        "/Create",
        "/F",
        "/TN",
        this.taskName,
        "/XML",
        xmlPath
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return this.status();
  }

  async disable() {
    if (!this.supported) throw new AutostartError("autostart is implemented for Windows only");
    if (this.backend === "startup") {
      rmSync(this.startupFilePath, { force: true });
      return this.status();
    }
    if (this.backend === "registry") {
      if (await this.exists()) {
        await this.run(["DELETE", this.registryKey, "/v", this.registryValueName, "/f"]);
      }
      return this.status();
    }
    if (!(await this.exists())) {
      return { supported: true, enabled: false, taskName: this.taskName, backend: this.backend };
    }
    await this.run(["/Delete", "/F", "/TN", this.taskName]);
    return this.status();
  }

  buildTaskXml() {
    const user = xmlEscape(currentUser(this.env));
    const script = xmlEscape(this.startScriptPath);
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
      "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
      "<RegistrationInfo><Description>XTDS assistant supervisor</Description></RegistrationInfo>",
      `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
      `<Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      "<Settings>",
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<AllowHardTerminate>true</AllowHardTerminate>",
      "<StartWhenAvailable>true</StartWhenAvailable>",
      "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
      "<AllowStartOnDemand>true</AllowStartOnDemand>",
      "<Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>",
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>",
      "</Settings>",
      "<Actions Context=\"Author\"><Exec><Command>cmd.exe</Command>",
      `<Arguments>/d /c ""${script}""</Arguments></Exec></Actions>`,
      "</Task>"
    ].join("\r\n");
  }

  async run(args, { reject = true } = {}) {
    try {
      const executable = this.backend === "registry" ? REG : SCHTASKS;
      const result = await execFileAsync(executable, args, {
        windowsHide: true,
        timeout: 20000,
        encoding: "utf8",
        env: this.env
      });
      return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
      if (!reject) return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
      throw new AutostartError(this.redactError(error));
    }
  }

  redactError(error) {
    const text = `${error?.message ?? error} ${error?.stderr ?? ""}`.replace(/\s+/g, " ").trim();
    return text.slice(0, 500);
  }
}

export function createStartScript({ config, cliPath, logPath }) {
  const lines = [
    "@echo off",
    "setlocal",
    `cd /d ${commandLineQuote(dirname(config.configPath))}`,
    `if not exist ${commandLineQuote(dirname(logPath))} mkdir ${commandLineQuote(dirname(logPath))}`,
    `${commandLineQuote(config.nodePath)} ${commandLineQuote(cliPath)} --config ${commandLineQuote(config.configPath)} >> ${commandLineQuote(logPath)} 2>&1`,
    "exit /b %ERRORLEVEL%",
    ""
  ];
  return lines.join("\r\n");
}

export function ensureStartScript({ config, cliPath, runtimeDir }) {
  const scriptPath = resolve(runtimeDir, "start-supervisor.cmd");
  const logPath = resolve(runtimeDir, "logs", "supervisor-boot.log");
  ensureDir(dirname(scriptPath));
  ensureDir(dirname(logPath));
  const content = createStartScript({ config, cliPath, logPath });
  try {
    const existing = readFileSync(scriptPath, "utf8");
    if (existing === content) return { scriptPath, logPath };
  } catch {
    // create below
  }
  writeFileAtomic(scriptPath, content, 0o700);
  return { scriptPath, logPath };
}
