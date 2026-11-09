import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { ConfigError, loadConfig } from "../lib/config.js";
import { createLogFailureThrottle } from "../lib/process-manager.js";
import { createLineRedactor, createRedactor } from "../lib/redact.js";
import { RotatingLogWriter, rotateFileIfNeeded } from "../lib/rotating-log.js";

function createTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "xtds-log-rotation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function archiveFiles(filePath) {
  const directory = dirname(filePath);
  const prefix = `${basename(filePath)}.`;
  const suffix = ".archive";
  const archives = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const middle = name.slice(prefix.length, -suffix.length);
    const match = /^(\d{12})-(\d{13})-(\d+)-([0-9a-f]{8})$/.exec(middle);
    if (match === null) continue;
    const path = join(directory, name);
    if (!statSync(path).isFile()) continue;
    archives.push({
      path,
      name,
      sequence: Number(match[1]),
      timestamp: Number(match[2])
    });
  }
  archives.sort((left, right) => left.sequence - right.sequence
    || left.timestamp - right.timestamp
    || left.name.localeCompare(right.name));
  return archives;
}

function readAllLogs(filePath) {
  return [
    ...archiveFiles(filePath).map((archive) => readFileSync(archive.path, "utf8")),
    readFileSync(filePath, "utf8")
  ].join("");
}

function createConfig(dir, overrides = {}) {
  const configPath = join(dir, "supervisor.json");
  const config = {
    host: "127.0.0.1",
    port: 0,
    runtimeDir: "runtime",
    serviceRuntimeDir: "services",
    nodePath: process.execPath,
    taskName: "XTDS-Assistant-Test",
    autostartBackend: "startup",
    processes: [
      {
        id: "dummy",
        cwd: dir,
        command: process.execPath,
        endpointFile: "dummy.endpoint.json"
      }
    ],
    ...overrides
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

test("writes without rotating below the byte limit", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 10, maxFiles: 2 });

  writer.append("12345");
  writer.append("6789");

  assert.equal(readFileSync(filePath, "utf8"), "123456789");
  assert.equal(archiveFiles(filePath).length, 0);
});

test("rotates before a write that would cross the byte limit", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 10, maxFiles: 2 });

  writer.append("123456");
  writer.append("78901");

  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(archives[0].path, "utf8"), "123456");
  assert.equal(readFileSync(filePath, "utf8"), "78901");
  assert.match(archives[0].name, /^service\.log\.\d{12}-\d{13}-\d+-[0-9a-f]{8}\.archive$/);
});

test("sorts immutable archives from oldest to newest", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 4, maxFiles: 3 });

  writer.append("aaaa");
  writer.append("bbbb");
  writer.append("cccc");
  writer.append("dddd");

  const archives = archiveFiles(filePath);
  assert.deepEqual(
    archives.map((archive) => readFileSync(archive.path, "utf8")),
    ["aaaa", "bbbb", "cccc"]
  );
  assert.equal(readFileSync(filePath, "utf8"), "dddd");
});

test("deletes the oldest immutable archive beyond maxFiles", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 4, maxFiles: 2 });

  writer.append("aaaa");
  writer.append("bbbb");
  writer.append("cccc");
  writer.append("dddd");

  const archives = archiveFiles(filePath);
  assert.deepEqual(
    archives.map((archive) => readFileSync(archive.path, "utf8")),
    ["bbbb", "cccc"]
  );
  assert.equal(readFileSync(filePath, "utf8"), "dddd");
});

test("a new writer continues after the highest existing archive sequence", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const first = new RotatingLogWriter({ filePath, maxBytes: 4, maxFiles: 10 });

  first.append("aaaa");
  first.append("bbbb");
  first.close();
  assert.deepEqual(archiveFiles(filePath).map((archive) => archive.sequence), [1]);

  const second = new RotatingLogWriter({ filePath, maxBytes: 4, maxFiles: 10 });
  second.append("cccc");

  const archives = archiveFiles(filePath);
  assert.deepEqual(archives.map((archive) => archive.sequence), [1, 2]);
  assert.deepEqual(
    archives.map((archive) => readFileSync(archive.path, "utf8")),
    ["aaaa", "bbbb"]
  );
  assert.equal(readFileSync(filePath, "utf8"), "cccc");
});

test("retains higher-sequence archives when the clock rolls back", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const times = [2000, 1000, 3000];
  let index = 0;
  const writer = new RotatingLogWriter({
    filePath,
    maxBytes: 4,
    maxFiles: 1,
    now: () => times[index++]
  });

  writer.append("aaaa");
  writer.append("bbbb");
  writer.append("cccc");

  let archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].sequence, 2);
  assert.equal(archives[0].timestamp, 1000);
  assert.equal(readFileSync(archives[0].path, "utf8"), "bbbb");

  writer.append("dddd");
  archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].sequence, 3);
  assert.equal(archives[0].timestamp, 3000);
  assert.equal(readFileSync(archives[0].path, "utf8"), "cccc");
  assert.equal(readFileSync(filePath, "utf8"), "dddd");
});

test("allows one oversized chunk on an empty file and rotates on the next append", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 5, maxFiles: 2 });

  writer.append("0123456789");
  assert.equal(readFileSync(filePath, "utf8"), "0123456789");
  assert.equal(archiveFiles(filePath).length, 0);

  writer.append("x");
  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(archives[0].path, "utf8"), "0123456789");
  assert.equal(readFileSync(filePath, "utf8"), "x");
});

test("does not append after close", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const writer = new RotatingLogWriter({ filePath, maxBytes: 10, maxFiles: 2 });

  writer.append("before");
  writer.close();
  writer.close();
  assert.equal(writer.append("after"), false);
  assert.equal(readFileSync(filePath, "utf8"), "before");
});

test("reports write errors without throwing", (t) => {
  const dir = createTempDir(t);
  const errors = [];
  const writer = new RotatingLogWriter({
    filePath: join(dir, "missing", "service.log"),
    maxBytes: 10,
    maxFiles: 1,
    onError: (error) => {
      errors.push(error);
      throw error;
    }
  });

  assert.doesNotThrow(() => writer.append("hello"));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
});

test("persistent rename failure pauses writes and resumes after the lock clears", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const existingArchive = `${filePath}.000000000001-1700000000000-1-deadbeef.archive`;
  writeFileSync(existingArchive, "old");
  let locked = true;
  let renameFailures = 0;
  const errors = [];
  const fileSystem = {
    appendFileSync: fs.appendFileSync,
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    rmSync: fs.rmSync,
    renameSync(source, target) {
      if (source === filePath && locked) {
        renameFailures += 1;
        const error = new Error("file is locked");
        error.code = "EBUSY";
        throw error;
      }
      fs.renameSync(source, target);
    }
  };
  const writer = new RotatingLogWriter({
    filePath,
    maxBytes: 5,
    maxFiles: 2,
    fileSystem,
    onError: (error) => errors.push(error)
  });

  writer.append("first");
  assert.equal(writer.append("second"), false);
  assert.equal(renameFailures, 1);
  assert.equal(errors.at(-1)?.code, "EBUSY");
  assert.equal(readFileSync(existingArchive, "utf8"), "old");
  assert.equal(readFileSync(filePath, "utf8"), "first");

  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(writer.append("x"), false);
    assert.equal(statSync(filePath).size, 5);
  }
  assert.equal(renameFailures, 9);
  assert.equal(archiveFiles(filePath).length, 1);

  locked = false;
  assert.equal(writer.append("third"), true);
  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 2);
  assert.equal(readFileSync(archives[0].path, "utf8"), "old");
  assert.equal(readFileSync(archives[1].path, "utf8"), "first");
  assert.equal(readFileSync(filePath, "utf8"), "third");
});

test("ignores a directory that matches the archive name format", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const occupiedArchive = `${filePath}.000000000001-1700000000000-4242-deadbeef.archive`;
  mkdirSync(occupiedArchive);
  let random = 0;
  const writer = new RotatingLogWriter({
    filePath,
    maxBytes: 4,
    maxFiles: 1,
    now: () => 1700000000000,
    pid: 4242,
    randomHex: () => ["deadbeef", "cafebabe"][random++]
  });

  writer.append("aaaa");
  writer.append("bbbb");

  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(archives[0].name, "service.log.000000000002-1700000000000-4242-cafebabe.archive");
  assert.equal(readFileSync(archives[0].path, "utf8"), "aaaa");
  assert.equal(fs.statSync(occupiedArchive).isDirectory(), true);
  assert.equal(readFileSync(filePath, "utf8"), "bbbb");
});

test("cleanup failures pause writes, cap archives, and resume after cleanup succeeds", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  let denyDeletes = true;
  const errors = [];
  const fileSystem = {
    appendFileSync: fs.appendFileSync,
    lstatSync: fs.lstatSync,
    readdirSync: fs.readdirSync,
    renameSync: fs.renameSync,
    rmSync(path, options) {
      if (denyDeletes) {
        const error = new Error("delete denied");
        error.code = "EACCES";
        throw error;
      }
      fs.rmSync(path, options);
    }
  };
  const writer = new RotatingLogWriter({
    filePath,
    maxBytes: 4,
    maxFiles: 1,
    fileSystem,
    onError: (error) => errors.push(error)
  });

  assert.equal(writer.append("aaaa"), true);
  assert.equal(writer.append("bbbb"), true);
  assert.equal(writer.append("cccc"), false);

  assert.ok(errors.some((error) => error.code === "EACCES"));
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(archiveFiles(filePath).length, 2);

  assert.equal(writer.append("dddd"), false);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(archiveFiles(filePath).length, 2);

  denyDeletes = false;
  assert.equal(writer.append("eeee"), true);

  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(archives[0].path, "utf8"), "bbbb");
  assert.equal(readFileSync(filePath, "utf8"), "eeee");
});

test("rotateFileIfNeeded uses immutable archives above its limit", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  writeFileSync(filePath, "12345");

  assert.equal(rotateFileIfNeeded(filePath, { maxBytes: 5, maxFiles: 1 }), false);
  assert.equal(rotateFileIfNeeded(filePath, { maxBytes: 4, maxFiles: 1 }), true);
  assert.equal(fs.existsSync(filePath), false);
  const archives = archiveFiles(filePath);
  assert.equal(archives.length, 1);
  assert.equal(readFileSync(archives[0].path, "utf8"), "12345");
});

test("line redactor catches a token split across chunks before rotation", (t) => {
  const dir = createTempDir(t);
  const filePath = join(dir, "service.log");
  const secret = "split-secret-ABCDEF123456";
  const writer = new RotatingLogWriter({ filePath, maxBytes: 100, maxFiles: 3 });
  const redact = createRedactor([secret]);
  const stream = createLineRedactor({
    redact,
    secretValues: [secret],
    onLine: (text) => writer.append(text)
  });

  stream.push(`${"p".repeat(90)}\n`);
  stream.push("token=");
  stream.push(secret.slice(0, 10));
  stream.push(`${secret.slice(10)}\n`);
  stream.flush();

  const combined = readAllLogs(filePath);
  assert.ok(archiveFiles(filePath).length >= 1);
  assert.equal(combined.includes(secret), false);
  assert.equal(combined.includes(`token=${secret}`), false);
  assert.match(combined, /token=\[REDACTED\]/);
});

test("line redactor preserves exact secrets split without a generic key", () => {
  const secret = "exact-secret-123456789";
  const output = [];
  const stream = createLineRedactor({
    redact: createRedactor([secret]),
    secretValues: [secret],
    onLine: (text) => output.push(text)
  });

  stream.push("value ");
  stream.push(secret.slice(0, 6));
  stream.push(secret.slice(6));
  stream.push("\n");

  const combined = output.join("");
  assert.equal(combined.includes(secret), false);
  assert.match(combined, /value \[REDACTED\]/);
});

test("line redactor buffers and redacts a complete 1.15 MB line under the default limit", () => {
  const secret = `UNKNOWN-${"u".repeat(64)}`;
  const line = `token=${secret}${"x".repeat(Math.floor(1.15 * 1024 * 1024))}`;
  const output = [];
  const stream = createLineRedactor({ onLine: (text) => output.push(text) });

  for (let offset = 0; offset < line.length; offset += 64 * 1024) {
    stream.push(line.slice(offset, offset + 64 * 1024));
  }
  stream.push("\n");

  assert.equal(output.length, 1);
  assert.equal(output[0], "token=[REDACTED]\n");
});

test("line overflow discards the whole line and resumes at the next newline", () => {
  const secret = `UNKNOWN-${"s".repeat(64)}`;
  const marker = "[REDACTED] log line exceeded 1024 characters\n";
  const output = [];
  const stream = createLineRedactor({
    maxPendingChars: 1024,
    onLine: (text) => output.push(text)
  });

  stream.push(`prefix-${"x".repeat(2048)}-token=${secret}`);
  assert.deepEqual(output, [marker]);

  stream.push("-discarded-tail\nvisible-line\n");
  assert.deepEqual(output, [marker, "visible-line\n"]);

  stream.push("unterminated-tail");
  stream.flush();
  assert.deepEqual(output, [marker, "visible-line\n", "unterminated-tail"]);

  const combined = output.join("");
  assert.equal(combined.includes(secret), false);
  assert.equal(combined.includes("prefix-"), false);
  assert.equal(combined.includes("discarded-tail"), false);
  assert.ok(combined.length < 200);
});

test("line redactor applies the pending limit to characters before the newline", () => {
  const output = [];
  const stream = createLineRedactor({
    maxPendingChars: 8,
    onLine: (text) => output.push(text)
  });

  stream.push("12345678");
  stream.push("\n");
  assert.deepEqual(output, ["12345678\n"]);

  stream.push("123456789\n");
  assert.deepEqual(output, ["12345678\n", "[REDACTED] log line exceeded 8 characters\n"]);

  stream.push("ok\n");
  assert.deepEqual(output, [
    "12345678\n",
    "[REDACTED] log line exceeded 8 characters\n",
    "ok\n"
  ]);
});

test("overflow marker stays fixed regardless of the configured redactor", () => {
  const output = [];
  const stream = createLineRedactor({
    redact: () => "rewritten",
    maxPendingChars: 8,
    onLine: (text) => output.push(text)
  });

  stream.push("123456789\n");

  assert.deepEqual(output, ["[REDACTED] log line exceeded 8 characters\n"]);
});

test("flush does not emit residual content from a discarded line", () => {
  const output = [];
  const stream = createLineRedactor({
    maxPendingChars: 64,
    onLine: (text) => output.push(text)
  });

  stream.push("x".repeat(128));
  stream.flush();

  assert.deepEqual(output, ["[REDACTED] log line exceeded 64 characters\n"]);
});

test("stderr prefix is applied once per logical line and flush keeps the tail", () => {
  const output = [];
  const stream = createLineRedactor({
    redact: createRedactor(),
    linePrefix: "[stderr] ",
    onLine: (text) => output.push(text)
  });

  stream.push("first");
  stream.push(" line\nsecond");
  stream.push(" line");
  assert.equal(output.join(""), "[stderr] first line\n");
  stream.flush();
  assert.equal(output.join(""), "[stderr] first line\n[stderr] second line");
});

test("stderr prefix is applied to overflow markers", () => {
  const output = [];
  const stream = createLineRedactor({
    maxPendingChars: 1024,
    linePrefix: "[stderr] ",
    onLine: (text) => output.push(text)
  });

  stream.push(`${"x".repeat(2048)}\nvisible\n`);

  assert.deepEqual(output, [
    "[stderr] [REDACTED] log line exceeded 1024 characters\n",
    "[stderr] visible\n"
  ]);
});

test("log failure warnings are limited to one per interval", () => {
  let now = 1000;
  const warnings = [];
  const throttle = createLogFailureThrottle({
    intervalMs: 60000,
    now: () => now,
    warn: (message) => warnings.push(message)
  });
  const error = Object.assign(new Error("denied"), { code: "EACCES" });

  throttle.failure(error, "service");
  throttle.failure(error, "service");
  assert.equal(warnings.length, 1);
  now += 59999;
  throttle.failure(error, "service");
  assert.equal(warnings.length, 1);
  now += 1;
  throttle.failure(error, "service");
  assert.equal(warnings.length, 2);
});

test("loadConfig supplies log rotation defaults", (t) => {
  const dir = createTempDir(t);
  const config = loadConfig(createConfig(dir));

  assert.equal(config.logMaxBytes, 5 * 1024 * 1024);
  assert.equal(config.logMaxFiles, 5);
});

test("loadConfig accepts inclusive log rotation boundaries", (t) => {
  const dir = createTempDir(t);
  const configPath = createConfig(dir, { logMaxBytes: 1024, logMaxFiles: 1 });
  assert.equal(loadConfig(configPath).logMaxBytes, 1024);
  assert.equal(loadConfig(configPath).logMaxFiles, 1);

  writeFileSync(configPath, JSON.stringify({
    ...JSON.parse(readFileSync(configPath, "utf8")),
    logMaxBytes: 1073741824,
    logMaxFiles: 50
  }, null, 2));
  assert.equal(loadConfig(configPath).logMaxBytes, 1073741824);
  assert.equal(loadConfig(configPath).logMaxFiles, 50);
});

test("loadConfig rejects invalid log rotation values", (t) => {
  const dir = createTempDir(t);
  const configPath = createConfig(dir);
  const base = JSON.parse(readFileSync(configPath, "utf8"));
  const invalid = [
    ["logMaxBytes", 1023],
    ["logMaxBytes", 1073741825],
    ["logMaxBytes", 1024.5],
    ["logMaxBytes", "1024"],
    ["logMaxFiles", 0],
    ["logMaxFiles", 51],
    ["logMaxFiles", 1.5],
    ["logMaxFiles", null]
  ];
  for (const [field, value] of invalid) {
    writeFileSync(configPath, JSON.stringify({ ...base, [field]: value }, null, 2));
    assert.throws(
      () => loadConfig(configPath),
      (error) => error instanceof ConfigError && error.message.includes(field),
      `${field}=${String(value)}`
    );
  }
});
