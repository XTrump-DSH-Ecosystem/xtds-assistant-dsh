import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  api,
  createHarness,
  newSessionId,
  startHarness,
  submit,
  waitForTask,
  writeSessionFile
} from "./helpers.js";

const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeWorkspace(harness, name) {
  const dir = join(harness.dshWorkspaceRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function addWorktree(repo, root, name) {
  mkdirSync(root, { recursive: true });
  const target = join(root, name);
  const result = spawnSync("git", ["worktree", "add", "--detach", target, "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return target;
}

function ctName() {
  const uuid = randomUUID();
  return { taskId: `ct-${uuid}`, short: `ct-${uuid.slice(0, 8)}` };
}

function sameRealPath(left, right) {
  return realpathSync.native(left).toLowerCase() === realpathSync.native(right).toLowerCase();
}

test("sessions API lists, filters, limits, sorts, and requires auth", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  mkdirSync(harness.dshWorkspaceRoot, { recursive: true });

  const older = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Alpha Session",
    createdAt: 1000,
    lastPromptAt: 3000
  });
  const newest = writeSessionFile(harness.dshSessionsDir, {
    cwd: harness.dshWorkspaceRoot,
    title: "",
    createdAt: 1000,
    lastPromptAt: 4000
  });
  const middle = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Beta Keyword",
    createdAt: 1000,
    lastPromptAt: 2000
  });
  const arrayRows = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: null,
    createdAt: 900,
    lastPromptAt: 1000,
    rowsArray: true
  });

  const unauthorized = await api(harness.service, "/v1/sessions", { token: null });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(unauthorized.data, { ok: false, error: "unauthorized" });

  const listed = await api(harness.service, "/v1/sessions");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.ok, true);
  assert.equal(listed.data.sessions.length, 4);
  assert.deepEqual(listed.data.sessions.map((session) => session.sessionId), [
    newest.sessionId,
    older.sessionId,
    middle.sessionId,
    arrayRows.sessionId
  ]);
  for (const session of listed.data.sessions) {
    assert.match(session.sessionId, SESSION_ID_PATTERN);
    assert.deepEqual(Object.keys(session).sort(), [
      "lastUsedAt",
      "resumable",
      "sessionId",
      "title",
      "workspace"
    ]);
    assert.equal(session.resumable, true);
    assert.equal(new Date(session.lastUsedAt).toISOString(), session.lastUsedAt);
    assert.equal(session.workspace.includes(harness.dir), false);
    assert.equal(session.workspace.includes("\\"), false);
  }
  assert.equal(listed.data.sessions[0].title, "未命名会话");
  assert.equal(listed.data.sessions[3].title, "未命名会话");
  assert.equal(listed.data.sessions[0].workspace, "deepseek-harness");
  assert.equal(listed.data.sessions[1].workspace, "alpha");

  const limited = await api(harness.service, "/v1/sessions?limit=2");
  assert.deepEqual(limited.data.sessions.map((session) => session.sessionId), [
    newest.sessionId,
    older.sessionId
  ]);

  const filtered = await api(harness.service, "/v1/sessions?q=ALPHA");
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.data.sessions.map((session) => session.sessionId).sort(),
    [older.sessionId, middle.sessionId, arrayRows.sessionId].sort()
  );

  const byTitle = await api(harness.service, "/v1/sessions?q=beta%20keyword");
  assert.deepEqual(byTitle.data.sessions.map((session) => session.sessionId), [middle.sessionId]);

  const byIdPrefix = await api(
    harness.service,
    `/v1/sessions?q=${encodeURIComponent(older.sessionId.slice(8, 20))}`
  );
  assert.deepEqual(byIdPrefix.data.sessions.map((session) => session.sessionId), [older.sessionId]);

  for (const limit of ["0", "21", "abc", "-1"]) {
    const invalid = await api(harness.service, `/v1/sessions?limit=${encodeURIComponent(limit)}`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "invalid_request");
  }
});

test("sessions scanning skips blank, corrupt, oversized, outside, and missing entries and labels workspaces", async (t) => {
  const harness = await startHarness(t);
  const repoSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: harness.repo,
    title: "Repo session",
    createdAt: 1000,
    lastPromptAt: null
  });
  const worktree = ctName();
  const worktreePath = addWorktree(harness.repo, harness.worktreeRoot, worktree.taskId);
  const repoWorktreeSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: worktreePath,
    title: "Repo worktree session",
    lastPromptAt: 2000
  });
  const plainWorktree = ctName();
  const plainWorktreePath = join(harness.worktreeRoot, plainWorktree.taskId);
  mkdirSync(plainWorktreePath, { recursive: true });
  const plainWorktreeSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: plainWorktreePath,
    title: "Plain worktree session",
    lastPromptAt: 3000
  });
  const alpha = makeWorkspace(harness, "alpha");
  const alphaSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Alpha session",
    lastPromptAt: 4000
  });

  writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Blank session",
    blank: true,
    lastPromptAt: 9000
  });
  writeSessionFile(harness.dshSessionsDir, {
    cwd: join(harness.dir, "missing-directory"),
    title: "Missing cwd",
    lastPromptAt: 8000
  });

  const corruptId = newSessionId();
  writeFileSync(join(harness.dshSessionsDir, `${corruptId}.json`), "{not json", "utf8");
  const oversizedId = newSessionId();
  writeFileSync(
    join(harness.dshSessionsDir, `${oversizedId}.json`),
    `{"padding":"${"x".repeat(1024 * 1024 + 32)}"}`,
    "utf8"
  );
  writeFileSync(join(harness.dshSessionsDir, "session-not-a-uuid.json"), "{}", "utf8");

  const outside = mkdtempSync(join(tmpdir(), "code-bridge-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeSessionFile(harness.dshSessionsDir, {
    cwd: outside,
    title: "Outside session",
    lastPromptAt: 7000
  });
  const junctionPath = join(harness.dshWorkspaceRoot, "escape");
  symlinkSync(outside, junctionPath, "junction");
  writeSessionFile(harness.dshSessionsDir, {
    cwd: junctionPath,
    title: "Junction escape",
    lastPromptAt: 6500
  });

  const listed = await api(harness.service, "/v1/sessions");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.data.sessions.map((session) => session.sessionId).sort(),
    [
      alphaSession.sessionId,
      plainWorktreeSession.sessionId,
      repoSession.sessionId,
      repoWorktreeSession.sessionId
    ].sort()
  );
  const byId = new Map(listed.data.sessions.map((session) => [session.sessionId, session]));
  assert.equal(byId.get(repoSession.sessionId).workspace, "test");
  assert.equal(
    byId.get(repoSession.sessionId).lastUsedAt,
    new Date(1000).toISOString()
  );
  assert.equal(
    byId.get(repoWorktreeSession.sessionId).workspace,
    `test@${worktree.short}`
  );
  assert.equal(
    byId.get(plainWorktreeSession.sessionId).workspace,
    `worktree@${plainWorktree.short}`
  );
  assert.equal(byId.get(alphaSession.sessionId).workspace, "alpha");
});

test("workspaceRoots extends the allowed roots for listing and new sessions", async (t) => {
  const extraRoot = mkdtempSync(join(tmpdir(), "code-bridge-extra-root-"));
  t.after(() => rmSync(extraRoot, { recursive: true, force: true }));
  const harness = await startHarness(t, { workspaceRoots: [extraRoot] });
  const custom = join(extraRoot, "custom-space");
  mkdirSync(custom, { recursive: true });
  const session = writeSessionFile(harness.dshSessionsDir, {
    cwd: custom,
    title: "Custom root session",
    lastPromptAt: 1000
  });

  const listed = await api(harness.service, "/v1/sessions");
  assert.deepEqual(listed.data.sessions.map((entry) => entry.sessionId), [session.sessionId]);
  assert.equal(listed.data.sessions[0].workspace, "custom-space");

  const accepted = await submit(harness.service, {
    requestId: `custom-root-${randomUUID()}`,
    workspace: "custom-space",
    task: "continue in custom root"
  });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.data.task.mode, "resume");
  assert.equal(accepted.data.task.sessionId, session.sessionId);
  await waitForTask(
    harness.service,
    accepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(sameRealPath(harness.observation().cwd, custom), true);
});

test("session display text is control-free, bounded, and token-redacted", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: `line one\n${harness.service.token}\n${"x".repeat(400)}`,
    lastPromptAt: 1000
  });

  const listed = await api(harness.service, "/v1/sessions");
  assert.equal(listed.status, 200);
  const title = listed.data.sessions[0].title;
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(title), false);
  assert.equal(title.includes(harness.service.token), false);
  assert.equal(title.includes("[REDACTED]"), true);
  assert.equal([...title].length <= 200, true);
});

test("resuming a session passes --session-id with the session cwd and creates no worktree", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  const session = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Resume target",
    lastPromptAt: Date.now()
  });
  const requestId = `resume-${randomUUID()}`;

  const accepted = await submit(harness.service, {
    requestId,
    sessionId: session.sessionId,
    task: "resume this exact session"
  });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.data.task.repo, "dsh-session");
  assert.equal(accepted.data.task.sessionId, session.sessionId);
  assert.equal(accepted.data.task.workspace, "alpha");
  assert.equal(accepted.data.task.mode, "resume");
  assert.equal(accepted.data.task.worktree, null);
  assert.equal(existsSync(harness.worktreeRoot), false);

  const duplicate = await submit(harness.service, {
    requestId,
    sessionId: session.sessionId,
    task: "resume this exact session"
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.task.taskId, accepted.data.task.taskId);

  const succeeded = await waitForTask(
    harness.service,
    accepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(succeeded.worktree, null);
  assert.deepEqual(succeeded.changedFiles, []);
  assert.deepEqual(succeeded.diffStat, { files: 0, insertions: 0, deletions: 0 });
  const observation = harness.observation();
  assert.equal(observation.task, "resume this exact session");
  assert.equal(sameRealPath(observation.cwd, alpha), true);
  const flagIndex = observation.args.indexOf("--session-id");
  assert.notEqual(flagIndex, -1);
  assert.equal(observation.args[flagIndex + 1], session.sessionId);
  assert.equal(existsSync(harness.worktreeRoot), false);

  const stateBefore = JSON.parse(
    readFileSync(join(harness.runtimeDir, "code-bridge.state.json"), "utf8")
  );
  const stored = stateBefore.tasks.find((task) => task.taskId === succeeded.taskId);
  assert.equal(stored.sessionId, session.sessionId);
  assert.equal(stored.workspace, "alpha");
  assert.equal(stored.mode, "resume");

  await harness.stop();
  await harness.start();
  const reloaded = await api(harness.service, `/v1/tasks/${succeeded.taskId}`);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.data.task.sessionId, session.sessionId);
  assert.equal(reloaded.data.task.workspace, "alpha");
  assert.equal(reloaded.data.task.mode, "resume");
});

test("desktop-preset sessions are listed as non-resumable and rejected before execution", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  const desktop = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Desktop Session",
    lastPromptAt: Date.now(),
    agentPreset: "standard"
  });

  const listed = await api(harness.service, "/v1/sessions");
  assert.equal(listed.status, 200);
  const row = listed.data.sessions.find((session) => session.sessionId === desktop.sessionId);
  assert.equal(row.resumable, false);

  const rejected = await submit(harness.service, {
    requestId: `desktop-session-${randomUUID()}`,
    sessionId: desktop.sessionId,
    task: "must not reach DSH"
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.data, { ok: false, error: "session_preset_incompatible" });
  assert.equal(harness.observation(), null);

  const fallback = await submit(harness.service, {
    requestId: `desktop-workspace-${randomUUID()}`,
    workspace: "alpha",
    task: "start a fresh session in alpha"
  });
  assert.equal(fallback.status, 202, fallback.text);
  assert.equal(fallback.data.task.mode, "workspace");
  assert.equal(fallback.data.task.sessionId, null);
  const succeeded = await waitForTask(
    harness.service,
    fallback.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(succeeded.sessionId, null);
  assert.equal(sameRealPath(harness.observation().cwd, alpha), true);
  assert.equal(harness.observation().args.includes("--session-id"), false);
});

test("a DSH preset rejection is mapped to a stable error code", async (t) => {
  const harness = await startHarness(t, { mode: "preset-error" });
  const alpha = makeWorkspace(harness, "alpha");
  const session = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Compatible",
    lastPromptAt: Date.now()
  });

  const accepted = await submit(harness.service, {
    requestId: `preset-stderr-${randomUUID()}`,
    sessionId: session.sessionId,
    task: "should fail with a classified error"
  });
  assert.equal(accepted.status, 202, accepted.text);
  const failed = await waitForTask(
    harness.service,
    accepted.data.task.taskId,
    (task) => task.status === "failed"
  );
  assert.equal(failed.error, "session_preset_incompatible");
});

test("workspace queries resume the latest session and repo aliases include their worktrees", async (t) => {
  const harness = await startHarness(t);
  const first = ctName();
  const second = ctName();
  const firstPath = addWorktree(harness.repo, harness.worktreeRoot, first.taskId);
  const secondPath = addWorktree(harness.repo, harness.worktreeRoot, second.taskId);
  const firstSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: firstPath,
    title: "Older repo worktree",
    lastPromptAt: 1000
  });
  const secondSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: secondPath,
    title: "Newer repo worktree",
    lastPromptAt: 2000
  });

  const byRepoAlias = await submit(harness.service, {
    requestId: `workspace-repo-${randomUUID()}`,
    workspace: "test",
    task: "continue the newest test workspace"
  });
  assert.equal(byRepoAlias.status, 202, byRepoAlias.text);
  assert.equal(byRepoAlias.data.task.mode, "resume");
  assert.equal(byRepoAlias.data.task.sessionId, secondSession.sessionId);
  assert.equal(byRepoAlias.data.task.workspace, `test@${second.short}`);
  const resumed = await waitForTask(
    harness.service,
    byRepoAlias.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(resumed.worktree, null);
  assert.ok(resumed.changedFiles.includes("README.md"));
  assert.ok(resumed.diffStat.files >= 1);
  assert.equal(sameRealPath(harness.observation().cwd, secondPath), true);
  assert.equal(
    harness.observation().args[harness.observation().args.indexOf("--session-id") + 1],
    secondSession.sessionId
  );
  assert.equal(readdirSync(harness.worktreeRoot).filter((name) => name.startsWith("ct-")).length, 2);

  const byExactLabel = await submit(harness.service, {
    requestId: `workspace-label-${randomUUID()}`,
    workspace: `test@${first.short}`,
    task: "continue the older test workspace"
  });
  assert.equal(byExactLabel.status, 202, byExactLabel.text);
  assert.equal(byExactLabel.data.task.sessionId, firstSession.sessionId);
  await waitForTask(
    harness.service,
    byExactLabel.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(sameRealPath(harness.observation().cwd, firstPath), true);

  const alpha = makeWorkspace(harness, "alpha");
  const olderAlpha = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Older alpha",
    lastPromptAt: 3000
  });
  const newerAlpha = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Newer alpha",
    lastPromptAt: 4000
  });
  const byWorkspace = await submit(harness.service, {
    requestId: `workspace-alpha-${randomUUID()}`,
    workspace: "alpha",
    task: "continue alpha"
  });
  assert.equal(byWorkspace.status, 202, byWorkspace.text);
  assert.equal(byWorkspace.data.task.sessionId, newerAlpha.sessionId);
  assert.notEqual(byWorkspace.data.task.sessionId, olderAlpha.sessionId);
  await waitForTask(
    harness.service,
    byWorkspace.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(sameRealPath(harness.observation().cwd, alpha), true);
});

test("newSession forces a fresh session and empty workspaces create without a flag", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  const session = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Existing alpha",
    lastPromptAt: 1000
  });

  const fresh = await submit(harness.service, {
    requestId: `new-session-${randomUUID()}`,
    workspace: "alpha",
    newSession: true,
    task: "start fresh in alpha"
  });
  assert.equal(fresh.status, 202, fresh.text);
  assert.equal(fresh.data.task.mode, "workspace");
  assert.equal(fresh.data.task.repo, "dsh-session");
  assert.equal(fresh.data.task.sessionId, null);
  assert.equal(fresh.data.task.workspace, "alpha");
  assert.equal(fresh.data.task.worktree, null);
  const freshTask = await waitForTask(
    harness.service,
    fresh.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(freshTask.worktree, null);
  assert.equal(sameRealPath(harness.observation().cwd, alpha), true);
  assert.equal(harness.observation().args.includes("--session-id"), false);

  const freshSpace = makeWorkspace(harness, "fresh-space");
  const emptyWorkspace = await submit(harness.service, {
    requestId: `empty-workspace-${randomUUID()}`,
    workspace: "fresh-space",
    task: "start in an empty workspace"
  });
  assert.equal(emptyWorkspace.status, 202, emptyWorkspace.text);
  assert.equal(emptyWorkspace.data.task.mode, "workspace");
  assert.equal(emptyWorkspace.data.task.repo, "dsh-session");
  assert.equal(emptyWorkspace.data.task.sessionId, null);
  assert.equal(emptyWorkspace.data.task.workspace, "fresh-space");
  await waitForTask(
    harness.service,
    emptyWorkspace.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(sameRealPath(harness.observation().cwd, freshSpace), true);
  assert.equal(harness.observation().args.includes("--session-id"), false);

  const freshRepo = await submit(harness.service, {
    requestId: `new-session-repo-${randomUUID()}`,
    workspace: "test",
    task: "fresh worktree task"
  });
  assert.equal(freshRepo.status, 202, freshRepo.text);
  assert.equal(freshRepo.data.task.mode, "worktree");
  assert.equal(freshRepo.data.task.repo, "test");
  assert.equal(freshRepo.data.task.workspace, "test");
  const freshRepoTask = await waitForTask(
    harness.service,
    freshRepo.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.notEqual(freshRepoTask.worktree, null);
  assert.equal(existsSync(freshRepoTask.worktree), true);

  for (const body of [
    {
      requestId: `new-session-id-conflict-${randomUUID()}`,
      sessionId: session.sessionId,
      newSession: true,
      task: "invalid"
    },
    {
      requestId: `new-session-query-conflict-${randomUUID()}`,
      session: "existing alpha",
      newSession: true,
      task: "invalid"
    },
    {
      requestId: `new-session-type-conflict-${randomUUID()}`,
      workspace: "alpha",
      newSession: "yes",
      task: "invalid"
    }
  ]) {
    const rejected = await submit(harness.service, body);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error, "invalid_request");
  }
});

test("newSession on an exact repo alias creates a worktree instead of reusing a session cwd", async (t) => {
  const harness = await startHarness(t);
  const previous = ctName();
  const previousPath = addWorktree(harness.repo, harness.worktreeRoot, previous.taskId);
  writeSessionFile(harness.dshSessionsDir, {
    cwd: previousPath,
    title: "Previous repo worktree",
    lastPromptAt: 5000
  });
  const previousReadme = readFileSync(join(previousPath, "README.md"), "utf8");

  const accepted = await submit(harness.service, {
    requestId: `new-session-alias-${randomUUID()}`,
    workspace: "test",
    newSession: true,
    task: "fresh worktree from alias"
  });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.data.task.mode, "worktree");
  assert.equal(accepted.data.task.repo, "test");
  assert.equal(accepted.data.task.workspace, "test");
  assert.equal(accepted.data.task.sessionId, null);

  const created = await waitForTask(
    harness.service,
    accepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.notEqual(created.worktree, null);
  assert.equal(sameRealPath(created.worktree, previousPath), false);
  assert.equal(sameRealPath(harness.observation().cwd, created.worktree), true);
  assert.equal(readFileSync(join(previousPath, "README.md"), "utf8"), previousReadme);
  assert.equal(readdirSync(harness.worktreeRoot).filter((name) => name.startsWith("ct-")).length, 2);

  const inPlace = await submit(harness.service, {
    requestId: `new-session-worktree-${randomUUID()}`,
    workspace: `test@${previous.short}`,
    newSession: true,
    task: "fresh session in the concrete worktree"
  });
  assert.equal(inPlace.status, 202, inPlace.text);
  assert.equal(inPlace.data.task.mode, "workspace");
  assert.equal(inPlace.data.task.repo, "dsh-session");
  assert.equal(inPlace.data.task.sessionId, null);
  assert.equal(inPlace.data.task.workspace, `test@${previous.short}`);
  await waitForTask(
    harness.service,
    inPlace.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  assert.equal(sameRealPath(harness.observation().cwd, previousPath), true);
});

test("session and workspace target errors are stable and never guess", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  const projectA = makeWorkspace(harness, "project-alpha");
  const projectB = makeWorkspace(harness, "project-beta");
  const first = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "shared needle",
    lastPromptAt: 1000
  });
  const second = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "shared needle again",
    lastPromptAt: 2000
  });
  const projectSession = writeSessionFile(harness.dshSessionsDir, {
    cwd: projectA,
    title: "project one",
    lastPromptAt: 3000
  });
  writeSessionFile(harness.dshSessionsDir, {
    cwd: projectB,
    title: "project two",
    lastPromptAt: 4000
  });

  const notFound = await submit(harness.service, {
    requestId: `missing-${randomUUID()}`,
    sessionId: `session-${randomUUID()}`,
    task: "missing session"
  });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.data.error, "session_not_found");

  const ambiguous = await submit(harness.service, {
    requestId: `ambiguous-${randomUUID()}`,
    session: "shared needle",
    task: "ambiguous session"
  });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.data.error, "session_ambiguous");

  const workspaceAmbiguous = await submit(harness.service, {
    requestId: `workspace-ambiguous-${randomUUID()}`,
    workspace: "project",
    task: "ambiguous workspace"
  });
  assert.equal(workspaceAmbiguous.status, 409);
  assert.equal(workspaceAmbiguous.data.error, "workspace_ambiguous");

  const mismatch = await submit(harness.service, {
    requestId: `mismatch-${randomUUID()}`,
    sessionId: first.sessionId,
    workspace: "project-beta",
    task: "mismatched target"
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.data.error, "session_workspace_mismatch");

  const substringMismatch = await submit(harness.service, {
    requestId: `substring-mismatch-${randomUUID()}`,
    sessionId: projectSession.sessionId,
    workspace: "alpha",
    task: "must not match by substring"
  });
  assert.equal(substringMismatch.status, 409);
  assert.equal(substringMismatch.data.error, "session_workspace_mismatch");

  const noTarget = await submit(harness.service, {
    requestId: `no-target-${randomUUID()}`,
    task: "no target"
  });
  assert.equal(noTarget.status, 400);
  assert.equal(noTarget.data.error, "invalid_request");

  const workspaceMissing = await submit(harness.service, {
    requestId: `workspace-missing-${randomUUID()}`,
    workspace: "no-such-workspace",
    task: "missing workspace"
  });
  assert.equal(workspaceMissing.status, 404);
  assert.equal(workspaceMissing.data.error, "workspace_not_found");

  const requestId = `idempotent-${randomUUID()}`;
  const accepted = await submit(harness.service, {
    requestId,
    sessionId: first.sessionId,
    task: "idempotent resume"
  });
  assert.equal(accepted.status, 202, accepted.text);
  await waitForTask(
    harness.service,
    accepted.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  const conflict = await submit(harness.service, {
    requestId,
    sessionId: second.sessionId,
    task: "idempotent resume"
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "request_id_conflict");

  const prefix = await submit(harness.service, {
    requestId: `prefix-${randomUUID()}`,
    session: first.sessionId.slice(8, 20),
    task: "find a session by id prefix"
  });
  assert.equal(prefix.status, 202, prefix.text);
  assert.equal(prefix.data.task.sessionId, first.sessionId);
  await waitForTask(
    harness.service,
    prefix.data.task.taskId,
    (task) => task.status === "succeeded"
  );
});

test("retrying a requestId succeeds after session files or workspace directories disappear", async (t) => {
  const harness = await startHarness(t);
  const alpha = makeWorkspace(harness, "alpha");
  const beta = makeWorkspace(harness, "beta");
  const session = writeSessionFile(harness.dshSessionsDir, {
    cwd: alpha,
    title: "Alpha retry",
    lastPromptAt: 1000
  });
  writeSessionFile(harness.dshSessionsDir, {
    cwd: beta,
    title: "Beta retry",
    lastPromptAt: 2000
  });

  const sessionRequestId = `retry-session-${randomUUID()}`;
  const sessionBody = {
    requestId: sessionRequestId,
    sessionId: session.sessionId,
    task: "resume then delete the session file"
  };
  const first = await submit(harness.service, sessionBody);
  assert.equal(first.status, 202, first.text);
  await waitForTask(
    harness.service,
    first.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  rmSync(join(harness.dshSessionsDir, `${session.sessionId}.json`));
  const sessionRetry = await submit(harness.service, sessionBody);
  assert.equal(sessionRetry.status, 200, sessionRetry.text);
  assert.equal(sessionRetry.data.duplicate, true);
  assert.equal(sessionRetry.data.task.taskId, first.data.task.taskId);

  const workspaceRequestId = `retry-workspace-${randomUUID()}`;
  const workspaceBody = {
    requestId: workspaceRequestId,
    workspace: "beta",
    task: "resume then delete the workspace"
  };
  const second = await submit(harness.service, workspaceBody);
  assert.equal(second.status, 202, second.text);
  await waitForTask(
    harness.service,
    second.data.task.taskId,
    (task) => task.status === "succeeded"
  );
  const betaSessionFile = readdirSync(harness.dshSessionsDir)
    .find((name) => name.endsWith(".json")
      && JSON.parse(readFileSync(join(harness.dshSessionsDir, name), "utf8"))
        .record?.identity?.cwd === beta);
  assert.notEqual(betaSessionFile, undefined);
  rmSync(join(harness.dshSessionsDir, betaSessionFile));
  rmSync(beta, { recursive: true, force: true });
  const workspaceRetry = await submit(harness.service, workspaceBody);
  assert.equal(workspaceRetry.status, 200, workspaceRetry.text);
  assert.equal(workspaceRetry.data.duplicate, true);
  assert.equal(workspaceRetry.data.task.taskId, second.data.task.taskId);
});

test("explicit malformed sessionId returns invalid_session_id instead of session_not_found", async (t) => {
  const harness = await startHarness(t);
  for (const sessionId of [
    "bad id",
    "../../evil",
    "session-1234ABCD-1234-1234-1234-123456789ABC",
    "",
    42
  ]) {
    const response = await submit(harness.service, {
      requestId: `bad-session-id-${randomUUID()}`,
      sessionId,
      task: "invalid session id"
    });
    assert.equal(response.status, 400);
    assert.equal(response.data.error, "invalid_session_id");
  }

  const missing = await submit(harness.service, {
    requestId: `missing-session-${randomUUID()}`,
    sessionId: `session-${randomUUID()}`,
    task: "valid shape but missing"
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, "session_not_found");
});

test("legacy state without session fields loads with null projections", async (t) => {
  const harness = createHarness();
  t.after(async () => {
    await harness.stop();
    harness.cleanup();
  });
  const taskId = `ct-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  mkdirSync(harness.runtimeDir, { recursive: true });
  writeFileSync(join(harness.runtimeDir, "code-bridge.state.json"), JSON.stringify({
    v: 1,
    tasks: [{
      taskId,
      requestId: `legacy-${randomUUID()}`,
      repo: "test",
      status: "succeeded",
      worktree: null,
      changedFiles: [],
      diffStat: { files: 0, insertions: 0, deletions: 0 },
      summary: "legacy",
      error: null,
      timestamps: {
        createdAt,
        queuedAt: createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        updatedAt: createdAt
      },
      outputTruncated: false,
      cancelRequestedAt: null
    }]
  }), "utf8");

  const service = await harness.start();
  const response = await api(service, `/v1/tasks/${taskId}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.task.sessionId, null);
  assert.equal(response.data.task.workspace, null);
  assert.equal(response.data.task.mode, null);
  const persisted = JSON.parse(
    readFileSync(join(harness.runtimeDir, "code-bridge.state.json"), "utf8")
  );
  assert.equal(persisted.tasks[0].sessionId, null);
  assert.equal(persisted.tasks[0].workspace, null);
  assert.equal(persisted.tasks[0].mode, null);
});
