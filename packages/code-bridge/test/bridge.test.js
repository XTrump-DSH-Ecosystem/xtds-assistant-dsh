import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { AlreadyRunningError } from "../lib/errors.js";
import { startCodeBridge } from "../lib/service.js";
import {
  api,
  createHarness,
  isPidAlive,
  readJson,
  repoHead,
  repoStatus,
  startHarness,
  submit,
  waitFor,
  waitForTask
} from "./helpers.js";

const TASK_FIELDS = [
  "cancelRequestedAt",
  "changedFiles",
  "diffStat",
  "error",
  "mode",
  "outputTruncated",
  "repo",
  "requestId",
  "sessionId",
  "status",
  "summary",
  "taskId",
  "timestamps",
  "workspace",
  "worktree"
].sort();

function plannedTask(taskId, requestId, status, extra = {}) {
  const createdAt = new Date().toISOString();
  return {
    taskId,
    requestId,
    repo: "test",
    status,
    worktree: null,
    changedFiles: [],
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    summary: null,
    error: null,
    timestamps: {
      createdAt,
      queuedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt
    },
    outputTruncated: false,
    cancelRequestedAt: null,
    ...extra
  };
}

test("success path uses stdin, an isolated worktree, auth, and does not leak task or token", async (t) => {
  const taskText = "Inspect the fixture. & echo INJECTED>injected.txt\r\nKeep this on stdin.";
  const requestId = `success-${randomUUID()}`;
  const harness = await startHarness(t, {
    env: {
      QQ_GATEWAY_TOKEN: "synthetic-qq-token",
      API_KEY: "synthetic-api-key",
      AUTH_HEADER: "synthetic-auth",
      SNOWLUMA_SECRET: "synthetic-secret",
      SAFE_TEST_VALUE: "visible"
    }
  });
  const service = harness.service;
  const headBefore = repoHead(harness.repo);
  const statusBefore = repoStatus(harness.repo);

  const health = await api(service, "/health", { token: null });
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.data).sort(), [
    "name",
    "ok",
    "pid",
    "queued",
    "running",
    "uptimeMs",
    "version"
  ]);
  assert.equal(health.data.name, "code-bridge");

  const unauthorized = await submit(service, { requestId, repo: "test", task: taskText }, { token: null });
  assert.equal(unauthorized.status, 401);
  const wrongToken = await submit(service, { requestId, repo: "test", task: taskText }, { token: "wrong" });
  assert.equal(wrongToken.status, 401);

  const accepted = await submit(service, { requestId, repo: "test", task: taskText });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.data.ok, true);
  assert.equal(accepted.data.duplicate, false);
  assert.deepEqual(Object.keys(accepted.data.task).sort(), TASK_FIELDS);
  assert.equal(accepted.data.task.task, undefined);
  assert.equal(accepted.text.includes(taskText), false);
  assert.equal(accepted.text.includes(service.token), false);
  const taskId = accepted.data.task.taskId;
  assert.match(taskId, /^ct-[0-9a-f-]{36}$/);

  const duplicate = await submit(service, { requestId, repo: "test", task: taskText });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.task.taskId, taskId);
  const conflict = await submit(service, { requestId, repo: "test", task: `${taskText} changed` });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "request_id_conflict");

  const succeeded = await waitForTask(service, taskId, (task) => task.status === "succeeded");
  assert.deepEqual(Object.keys(succeeded).sort(), TASK_FIELDS);
  assert.equal(succeeded.repo, "test");
  assert.equal(succeeded.mode, "worktree");
  assert.equal(succeeded.sessionId, null);
  assert.equal(succeeded.workspace, null);
  assert.equal(succeeded.requestId, requestId);
  assert.equal(succeeded.summary, "fake success summary");
  assert.equal(succeeded.error, null);
  assert.equal(succeeded.outputTruncated, false);
  assert.equal(succeeded.cancelRequestedAt, null);
  assert.equal(typeof succeeded.timestamps.createdAt, "string");
  assert.equal(typeof succeeded.timestamps.startedAt, "string");
  assert.equal(typeof succeeded.timestamps.finishedAt, "string");
  assert.ok(succeeded.worktree !== null);
  assert.equal(isAbsolute(succeeded.worktree), true);
  assert.equal(existsSync(succeeded.worktree), true);
  assert.equal(
    relative(realpathSync.native(harness.worktreeRoot), succeeded.worktree).startsWith(".."),
    false
  );
  assert.ok(succeeded.changedFiles.includes("README.md"));
  assert.ok(succeeded.changedFiles.includes("new-file.txt"));
  assert.equal(succeeded.diffStat.files, 1);
  assert.ok(succeeded.diffStat.insertions >= 1);
  assert.equal(statSync(join(succeeded.worktree, ".git")).isFile(), true);
  assert.equal(statSync(join(harness.repo, ".git")).isDirectory(), true);
  assert.match(readFileSync(join(succeeded.worktree, "README.md"), "utf8"), /worktree change/);
  assert.equal(readFileSync(join(harness.repo, "README.md"), "utf8"), "baseline\n");
  assert.equal(existsSync(join(succeeded.worktree, "injected.txt")), false);
  assert.equal(existsSync(join(harness.repo, "injected.txt")), false);
  assert.equal(repoStatus(harness.repo), statusBefore);
  assert.equal(repoHead(harness.repo), headBefore);
  assert.equal(repoHead(succeeded.worktree), headBefore);

  const fetched = await api(service, `/v1/tasks/${taskId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.task.taskId, taskId);
  const bearer = await api(service, `/v1/tasks/${taskId}`, {
    token: null,
    headers: { authorization: `Bearer ${service.token}` }
  });
  assert.equal(bearer.status, 200);

  const observation = harness.observation();
  assert.notEqual(observation, null);
  assert.equal(observation.task, taskText);
  assert.deepEqual(observation.args, [
    "--profile",
    "headless",
    "--json",
    "--permission-mode",
    "workspace-write",
    "--approval-policy",
    "never",
    "-"
  ]);
  assert.equal(observation.args.join(" ").includes(taskText), false);
  assert.equal(observation.cwd.toLowerCase(), succeeded.worktree.toLowerCase());
  assert.deepEqual(observation.sensitiveKeys, []);
  assert.equal(JSON.stringify(observation).includes(service.token), false);

  const endpointText = readFileSync(join(harness.runtimeDir, "code-bridge.endpoint.json"), "utf8");
  const endpoint = JSON.parse(endpointText);
  assert.deepEqual(Object.keys(endpoint).sort(), [
    "host",
    "instanceId",
    "name",
    "pid",
    "port",
    "startedAt",
    "v"
  ]);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.equal(endpoint.name, "code-bridge");
  assert.equal(endpoint.port, Number(new URL(service.baseUrl).port));
  assert.equal(endpointText.includes(service.token), false);
  const lockText = readFileSync(join(harness.runtimeDir, "code-bridge.lock"), "utf8");
  assert.equal(lockText.includes(service.token), false);

  const second = await submit(service, {
    requestId: `second-${randomUUID()}`,
    repo: "test",
    task: "second isolated task"
  });
  assert.equal(second.status, 202);
  const secondTask = await waitForTask(
    service,
    second.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.notEqual(secondTask.worktree, succeeded.worktree);
  assert.equal(existsSync(secondTask.worktree), true);
  assert.equal(repoStatus(harness.repo), statusBefore);

  const stateText = readFileSync(join(harness.runtimeDir, "code-bridge.state.json"), "utf8");
  assert.equal(stateText.includes(service.token), false);
  assert.equal(stateText.includes(taskText), false);
  assert.equal(stateText.includes("FAKE-STDERR-MARKER"), false);
});

test("request validation enforces bounds, allowlists, and the 32 KiB body limit", async (t) => {
  const harness = await startHarness(t);
  const service = harness.service;
  const valid = { requestId: "valid", repo: "test", task: "ok" };

  for (const body of [
    {},
    { ...valid, requestId: "" },
    { ...valid, requestId: "x".repeat(257) },
    { ...valid, requestId: "bad\u0001id" },
    { ...valid, task: "" },
    { ...valid, task: "😀".repeat(4001) },
    { ...valid, task: 7 },
    { ...valid, repo: "../repo" },
    { ...valid, repo: "missing" }
  ]) {
    const response = await submit(service, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 100));
    assert.equal(response.data.ok, false);
  }

  const tooLarge = await submit(service, {
    requestId: "large-body",
    repo: "test",
    task: "z".repeat(33 * 1024)
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.data.error, "request_too_large");

  const boundary = await submit(service, {
    requestId: "r".repeat(256),
    repo: "test",
    task: "😀".repeat(4000)
  });
  assert.equal(boundary.status, 202);
  const boundaryTask = await waitForTask(
    service,
    boundary.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(boundaryTask.summary, "fake success summary");

  const missing = await api(service, "/v1/tasks/ct-00000000-0000-0000-0000-000000000000");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, "not_found");
  const missingToken = await api(service, "/v1/tasks/ct-00000000-0000-0000-0000-000000000000", {
    token: null
  });
  assert.equal(missingToken.status, 401);
});

test("failed DSH runs expose only a stable error and bounded output flag", async (t) => {
  const marker = `failure-${randomUUID()}`;
  const harness = await startHarness(t, { mode: "failure" });
  const service = harness.service;
  const accepted = await submit(service, {
    requestId: `failure-${randomUUID()}`,
    repo: "test",
    task: marker
  });
  assert.equal(accepted.status, 202);
  const failed = await waitForTask(
    service,
    accepted.data.task.taskId,
    (task) => task.status === "failed"
  );
  assert.equal(failed.error, "dsh_exit_code_7");
  assert.equal(failed.summary, null);
  assert.equal(failed.outputTruncated, true);
  assert.equal(failed.cancelRequestedAt, null);
  assert.equal(JSON.stringify(failed).includes(marker), false);
  assert.equal(JSON.stringify(failed).includes("FAKE-STDERR-MARKER"), false);
  assert.equal(failed.worktree !== null, true);
  assert.equal(existsSync(failed.worktree), true);
  const stateText = readFileSync(join(harness.runtimeDir, "code-bridge.state.json"), "utf8");
  assert.equal(stateText.includes(marker), false);
  assert.equal(stateText.includes("FAKE-STDERR-MARKER"), false);
});

test("timeout terminates the entire process tree", async (t) => {
  const harness = await startHarness(t, {
    mode: "timeout",
    taskTimeoutMs: 1200
  });
  const service = harness.service;
  const accepted = await submit(service, {
    requestId: `timeout-${randomUUID()}`,
    repo: "test",
    task: "hang until timeout"
  });
  assert.equal(accepted.status, 202);
  const taskId = accepted.data.task.taskId;
  const pids = await waitFor(() => harness.pids(), 5000);
  assert.ok(pids.self > 0);
  assert.ok(pids.grandchild > 0);
  const timedOut = await waitForTask(service, taskId, (task) => task.status === "timed_out", 10000);
  assert.equal(timedOut.error, "dsh_timeout");
  assert.equal(timedOut.summary, null);
  await waitFor(() => !isPidAlive(pids.self) && !isPidAlive(pids.grandchild), 5000);
});

test("queued and running cancellation are immediate and idempotent", async (t) => {
  const harness = await startHarness(t, { mode: "cancel", taskTimeoutMs: 10000 });
  const service = harness.service;
  const first = await submit(service, {
    requestId: `cancel-running-${randomUUID()}`,
    repo: "test",
    task: "running task"
  });
  assert.equal(first.status, 202);
  const runningId = first.data.task.taskId;
  const pids = await waitFor(async () => {
    const current = await api(service, `/v1/tasks/${runningId}`);
    return current.data.task.status === "running" ? harness.pids() : null;
  }, 5000);

  const second = await submit(service, {
    requestId: `cancel-queued-${randomUUID()}`,
    repo: "test",
    task: "queued task"
  });
  assert.equal(second.status, 202);
  const queuedId = second.data.task.taskId;
  const queuedCancel = await api(service, `/v1/tasks/${queuedId}/cancel`, { method: "POST" });
  assert.equal(queuedCancel.status, 200);
  assert.equal(queuedCancel.data.task.status, "canceled");
  assert.equal(queuedCancel.data.task.worktree, null);
  assert.equal(typeof queuedCancel.data.task.timestamps.finishedAt, "string");

  const runningCancel = await api(service, `/v1/tasks/${runningId}/cancel`, { method: "POST" });
  assert.equal(runningCancel.status, 200);
  assert.equal(typeof runningCancel.data.task.cancelRequestedAt, "string");
  const canceled = await waitForTask(
    service,
    runningId,
    (task) => task.status === "canceled",
    10000
  );
  assert.equal(canceled.error, null);
  assert.equal(canceled.summary, null);
  assert.equal(typeof canceled.timestamps.finishedAt, "string");
  await waitFor(() => !isPidAlive(pids.self) && !isPidAlive(pids.grandchild), 5000);

  const repeated = await api(service, `/v1/tasks/${runningId}/cancel`, { method: "POST" });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.task.status, "canceled");
  assert.equal(repeated.data.task.timestamps.finishedAt, canceled.timestamps.finishedAt);
});

test("queue capacity is one running and five queued", async (t) => {
  const harness = await startHarness(t, { mode: "hang", taskTimeoutMs: 10000 });
  const service = harness.service;
  const first = await submit(service, {
    requestId: `queue-first-${randomUUID()}`,
    repo: "test",
    task: "first"
  });
  const firstId = first.data.task.taskId;
  await waitForTask(service, firstId, (task) => task.status === "running");

  const queuedIds = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await submit(service, {
      requestId: `queued-${index}-${randomUUID()}`,
      repo: "test",
      task: `queued ${index}`
    });
    assert.equal(response.status, 202);
    assert.equal(response.data.task.status, "queued");
    queuedIds.push(response.data.task.taskId);
  }
  const full = await submit(service, {
    requestId: `overflow-${randomUUID()}`,
    repo: "test",
    task: "overflow"
  });
  assert.equal(full.status, 429);
  assert.deepEqual(full.data, { ok: false, error: "queue_full" });

  const health = await api(service, "/health", { token: null });
  assert.equal(health.data.running, 1);
  assert.equal(health.data.queued, 5);

  const duplicate = await submit(service, { requestId: first.data.task.requestId, repo: "test", task: "first" });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);

  for (const taskId of queuedIds) {
    const canceled = await api(service, `/v1/tasks/${taskId}/cancel`, { method: "POST" });
    assert.equal(canceled.data.task.status, "canceled");
  }
});

test("port fallback, endpoint ownership, and token reuse are enforced", async (t) => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const occupiedPort = occupied.address().port;
  const harness = createHarness({ port: occupiedPort });
  t.after(async () => {
    await harness.stop();
    harness.cleanup();
  });

  const firstService = await harness.start();
  assert.equal(firstService.fellBack, true);
  assert.notEqual(firstService.port, occupiedPort);
  const firstToken = firstService.token;
  assert.match(firstToken, /^[0-9a-f]{32,}$/);
  const endpointPath = join(harness.runtimeDir, "code-bridge.endpoint.json");
  const firstEndpoint = readJson(endpointPath);
  assert.equal(firstEndpoint.host, "127.0.0.1");
  assert.equal(firstEndpoint.port, firstService.port);
  assert.equal(firstEndpoint.pid, process.pid);
  assert.equal(existsSync(join(harness.runtimeDir, "code-bridge.lock")), true);
  await assert.rejects(
    () => startCodeBridge(harness.config, { env: harness.env }),
    (error) => error instanceof AlreadyRunningError
  );
  assert.deepEqual(readJson(endpointPath), firstEndpoint);

  await harness.stop();
  assert.equal(existsSync(endpointPath), false);
  assert.equal(existsSync(join(harness.runtimeDir, "code-bridge.lock")), false);
  const secondService = await harness.start();
  assert.equal(secondService.token, firstToken);

  const tampered = readJson(endpointPath);
  tampered.instanceId = randomUUID();
  writeFileSync(endpointPath, `${JSON.stringify(tampered)}\n`, "utf8");
  await harness.stop();
  assert.equal(existsSync(endpointPath), true);
});

test("startup fails legacy running tasks and resumes queued tasks", async (t) => {
  const harness = createHarness({ mode: "success" });
  t.after(async () => {
    await harness.stop();
    harness.cleanup();
  });
  mkdirSync(harness.runtimeDir, { recursive: true });
  const runningId = `ct-${randomUUID()}`;
  const queuedId = `ct-${randomUUID()}`;
  const taskText = "resume this queued task";
  writeFileSync(join(harness.runtimeDir, "code-bridge.state.json"), JSON.stringify({
    v: 1,
    tasks: [
      plannedTask(runningId, "startup-running", "running", {
        timestamps: {
          createdAt: new Date().toISOString(),
          queuedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          updatedAt: new Date().toISOString()
        }
      }),
      plannedTask(queuedId, "startup-queued", "queued", {
        taskText,
        taskHash: createHash("sha256").update(taskText, "utf8").digest("hex")
      })
    ]
  }), "utf8");

  await harness.start();
  const service = harness.service;
  const rejected = await waitForTask(
    service,
    runningId,
    (task) => task.status === "failed"
  );
  assert.equal(rejected.error, "bridge_restarted");
  assert.equal(typeof rejected.timestamps.finishedAt, "string");
  const resumed = await waitForTask(
    service,
    queuedId,
    (task) => task.status === "succeeded",
    10000
  );
  assert.equal(resumed.summary, "fake success summary");
  assert.equal(harness.observation().task, taskText);
  const stateText = readFileSync(join(harness.runtimeDir, "code-bridge.state.json"), "utf8");
  assert.equal(stateText.includes(taskText), false);
});

test("stdout truncation keeps the NDJSON result while plain output falls back to a bounded tail", async (t) => {
  const largeHarness = await startHarness(t, { mode: "large" });
  const largeAccepted = await submit(largeHarness.service, {
    requestId: `large-${randomUUID()}`,
    repo: "test",
    task: "large output"
  });
  const largeTask = await waitForTask(
    largeHarness.service,
    largeAccepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(largeTask.summary, "large success summary");
  assert.equal(largeTask.outputTruncated, true);
  assert.equal(JSON.stringify(largeTask).includes("EARLY-OUTPUT-MARKER"), false);

  const plainHarness = await startHarness(t, { mode: "plain" });
  const plainAccepted = await submit(plainHarness.service, {
    requestId: `plain-${randomUUID()}`,
    repo: "test",
    task: "plain output"
  });
  const plainTask = await waitForTask(
    plainHarness.service,
    plainAccepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(plainTask.outputTruncated, false);
  assert.equal(plainTask.summary.length, 4000);
  assert.equal(plainTask.summary.endsWith("PLAIN-TAIL"), true);
});

test("bin check mode validates without listening", async (t) => {
  const harness = createHarness();
  t.after(() => harness.cleanup());
  const { spawnSync } = await import("node:child_process");
  const cli = join(import.meta.dirname, "../bin/code-bridge.js");
  const result = spawnSync(process.execPath, [cli, "--config", harness.configPath, "--check"], {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.host, "127.0.0.1");
  assert.equal(output.repos.test.toLowerCase(), realpathSync.native(harness.repo).toLowerCase());
  assert.equal(existsSync(join(harness.runtimeDir, "code-bridge.endpoint.json")), false);
});
