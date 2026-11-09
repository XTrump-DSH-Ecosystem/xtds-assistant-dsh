import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_SESSION_LIMIT,
  MAX_CHANGED_FILES,
  MAX_QUEUED,
  MAX_SESSION_LIMIT,
  MAX_SESSION_TITLE_CHARS,
  MAX_SESSION_WORKSPACE_CHARS,
  MAX_SUMMARY_CHARS
} from "./constants.js";
import { collectWorktreeChanges, createTaskWorktree, validateRepoPath } from "./git.js";
import { killProcessTree, launchDsh } from "./dsh.js";
import { ApiError, RepoValidationError, WorktreeError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";
import { stateFilePath } from "./runtime.js";
import {
  buildAllowedRoots,
  canonicalAllowedDirectory,
  filterSessions,
  findSessionById,
  isValidSessionId,
  loadSessions,
  matchSessionQuery,
  projectSession,
  resolveWorkspaceQuery,
  workspaceMatchesLabel
} from "./sessions.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "timed_out"]);
const ALL_STATUSES = new Set(["queued", "running", ...TERMINAL_STATUSES]);
const TASK_MODES = new Set(["worktree", "resume", "workspace"]);
const SESSION_TARGET_REPO = "dsh-session";
const TASK_ID_PATTERN = /^ct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STABLE_ERROR = /^[a-z0-9_]{1,80}$/;

function isoNow() {
  return new Date().toISOString();
}

function emptyDiffStat() {
  return { files: 0, insertions: 0, deletions: 0 };
}

function stableError(value) {
  return typeof value === "string" && STABLE_ERROR.test(value) ? value : null;
}

const DSH_FAILURE_CLASSIFIERS = [
  [/runs under agent preset "[^"]+", which the one-shot runner does not compose/, "session_preset_incompatible"],
  [/is a subagent session and cannot be driven directly/, "session_subagent"],
  [/recorded no working directory, so it cannot be adopted/, "session_invalid"],
  [/was recorded in "[^"]*", not "[^"]*"/, "session_cwd_mismatch"],
  [/permission: unknown preset/, "permission_preset_invalid"]
];

export function classifyDshFailure(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return null;
  for (const [pattern, code] of DSH_FAILURE_CLASSIFIERS) {
    if (pattern.test(stderr)) return code;
  }
  return null;
}

function codePointLength(value) {
  return [...value].length;
}

function capCodePoints(value, limit, fromEnd = false) {
  const characters = [...value];
  if (characters.length <= limit) return value;
  return (fromEnd ? characters.slice(-limit) : characters.slice(0, limit)).join("");
}

function sanitizeSessionText(value, token, limit, fallback) {
  let text = value;
  if (typeof token === "string" && token.length > 0) {
    text = text.split(token).join("[REDACTED]");
  }
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  const characters = [...text];
  if (characters.length > limit) text = characters.slice(0, limit).join("");
  return text.length > 0 ? text : fallback;
}

function sessionQueryMatchesExisting(existing, query) {
  const raw = query.trim().toLowerCase();
  if (raw.length === 0) return false;
  const stripped = raw.startsWith("session-") ? raw.slice("session-".length) : raw;
  if (typeof existing.sessionId === "string") {
    const id = existing.sessionId.toLowerCase();
    const idPart = id.slice("session-".length);
    if (
      id === raw
      || idPart === stripped
      || (stripped.length >= 8 && idPart.startsWith(stripped))
    ) {
      return true;
    }
  }
  return typeof existing.workspace === "string"
    && existing.workspace.toLowerCase().includes(raw);
}

function workspaceQueryMatchesExisting(workspace, query) {
  if (typeof workspace !== "string") return false;
  const normalized = workspace.toLowerCase();
  const wanted = query.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return normalized === wanted
    || normalized.startsWith(`${wanted}@`)
    || normalized.includes(wanted);
}

function firstString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["result", "summary", "text", "message", "content"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return null;
}

export function extractSummary(stdout, secret = null, forbiddenText = null) {
  const fields = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const key of ["result", "summary", "text", "message"]) {
      const value = firstString(parsed[key]);
      if (typeof value === "string" && value.length > 0) fields[key] = value;
    }
  }
  let summary = fields.result ?? fields.summary ?? fields.text ?? fields.message ?? null;
  if (summary === null) {
    const trimmed = stdout.trim();
    summary = trimmed.length > 0 ? capCodePoints(trimmed, MAX_SUMMARY_CHARS, true) : null;
  }
  if (summary !== null && typeof secret === "string" && secret.length > 0) {
    summary = summary.split(secret).join("[REDACTED]");
  }
  if (summary !== null && typeof forbiddenText === "string" && forbiddenText.length > 0) {
    summary = summary.split(forbiddenText).join("[REDACTED_TASK]");
  }
  return summary === null ? null : capCodePoints(summary, MAX_SUMMARY_CHARS);
}

function validateTimestamps(value, fallbackCreatedAt) {
  const timestamps = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const normalize = (entry) => typeof entry === "string" && entry.length > 0 ? entry : null;
  return {
    createdAt: normalize(timestamps.createdAt) ?? fallbackCreatedAt,
    queuedAt: normalize(timestamps.queuedAt) ?? fallbackCreatedAt,
    startedAt: normalize(timestamps.startedAt),
    finishedAt: normalize(timestamps.finishedAt),
    updatedAt: normalize(timestamps.updatedAt) ?? fallbackCreatedAt
  };
}

function normalizeDiffStat(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return emptyDiffStat();
  const normalize = (entry) => Number.isInteger(entry) && entry >= 0 ? entry : 0;
  return {
    files: normalize(value.files),
    insertions: normalize(value.insertions),
    deletions: normalize(value.deletions)
  };
}

function normalizeChangedFiles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .slice(0, MAX_CHANGED_FILES);
}

export class TaskManager {
  constructor({ config, token, env = process.env }) {
    this.config = config;
    this.token = token;
    this.env = env;
    this.statePath = stateFilePath(config.runtimeDir);
    this.tasks = [];
    this.byId = new Map();
    this.byRequestId = new Map();
    this.repoPaths = new Map();
    this.active = null;
    this.activeHandle = null;
    this.activeTimer = null;
    this.activeRunPromise = null;
    this.started = false;
    this.stopping = false;
    this.stopPromise = null;
  }

  initialize() {
    const stored = readJson(this.statePath, null);
    const candidates = stored !== null && typeof stored === "object"
      && stored.v === 1 && Array.isArray(stored.tasks)
      ? stored.tasks
      : [];
    const now = isoNow();
    for (const raw of candidates) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      if (typeof raw.taskId !== "string" || !TASK_ID_PATTERN.test(raw.taskId)) continue;
      if (typeof raw.requestId !== "string" || raw.requestId.length === 0) continue;
      if (typeof raw.repo !== "string") continue;
      const mode = TASK_MODES.has(raw.mode) ? raw.mode : null;
      if (raw.repo === SESSION_TARGET_REPO) {
        if (mode !== "resume" && mode !== "workspace") continue;
      } else if (!Object.hasOwn(this.config.repos, raw.repo)) {
        continue;
      }
      if (!ALL_STATUSES.has(raw.status)) continue;
      if (this.byId.has(raw.taskId) || this.byRequestId.has(raw.requestId)) continue;

      const createdAt = typeof raw.timestamps?.createdAt === "string"
        ? raw.timestamps.createdAt
        : now;
      const task = {
        taskId: raw.taskId,
        requestId: raw.requestId,
        repo: raw.repo,
        status: raw.status,
        worktree: typeof raw.worktree === "string" && raw.worktree.length > 0 ? raw.worktree : null,
        changedFiles: normalizeChangedFiles(raw.changedFiles),
        diffStat: normalizeDiffStat(raw.diffStat),
        summary: typeof raw.summary === "string" ? capCodePoints(raw.summary, MAX_SUMMARY_CHARS) : null,
        error: stableError(raw.error),
        timestamps: validateTimestamps(raw.timestamps, createdAt),
        outputTruncated: raw.outputTruncated === true,
        cancelRequestedAt: typeof raw.cancelRequestedAt === "string" ? raw.cancelRequestedAt : null,
        taskHash: typeof raw.taskHash === "string" && /^[0-9a-f]{64}$/.test(raw.taskHash)
          ? raw.taskHash
          : null,
        taskText: typeof raw.taskText === "string" ? raw.taskText : null,
        sessionId: typeof raw.sessionId === "string" && raw.sessionId.length > 0
          ? raw.sessionId
          : null,
        workspace: typeof raw.workspace === "string" && raw.workspace.length > 0
          ? raw.workspace
          : null,
        mode,
        targetCwd: typeof raw.targetCwd === "string" && raw.targetCwd.length > 0
          ? raw.targetCwd
          : null
      };

      if (task.status === "running") {
        task.status = "failed";
        task.error = "bridge_restarted";
        task.timestamps.finishedAt = now;
        task.timestamps.updatedAt = now;
        task.taskText = null;
      } else if (task.status === "queued" && task.taskText === null) {
        task.status = "failed";
        task.error = "state_task_missing";
        task.timestamps.finishedAt = now;
        task.timestamps.updatedAt = now;
      }
      if (task.taskText !== null && task.taskHash === null) {
        task.taskHash = createHash("sha256").update(task.taskText, "utf8").digest("hex");
      }

      this.tasks.push(task);
      this.byId.set(task.taskId, task);
      this.byRequestId.set(task.requestId, task);
    }
    this.persist();
  }

  start() {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule();
  }

  serializeTask(task) {
    return {
      taskId: task.taskId,
      requestId: task.requestId,
      repo: task.repo,
      status: task.status,
      worktree: task.worktree,
      changedFiles: [...task.changedFiles],
      diffStat: { ...task.diffStat },
      summary: task.summary,
      error: task.error,
      timestamps: { ...task.timestamps },
      outputTruncated: task.outputTruncated,
      cancelRequestedAt: task.cancelRequestedAt,
      sessionId: task.sessionId ?? null,
      workspace: task.workspace ?? null,
      mode: task.mode ?? null,
      targetCwd: task.targetCwd ?? null,
      taskHash: task.taskHash,
      ...(task.status === "queued" ? { taskText: task.taskText } : {})
    };
  }

  persist() {
    writeJsonAtomic(this.statePath, {
      v: 1,
      tasks: this.tasks.map((task) => this.serializeTask(task))
    });
  }

  persistBestEffort() {
    try {
      this.persist();
    } catch {
      // The in-memory state remains authoritative for this process.
    }
  }

  project(task) {
    return {
      taskId: task.taskId,
      requestId: task.requestId,
      repo: task.repo,
      status: task.status,
      worktree: task.worktree,
      changedFiles: [...task.changedFiles],
      diffStat: { ...task.diffStat },
      summary: task.summary,
      error: task.error,
      timestamps: { ...task.timestamps },
      outputTruncated: task.outputTruncated,
      cancelRequestedAt: task.cancelRequestedAt,
      sessionId: task.sessionId ?? null,
      workspace: task.workspace === null || task.workspace === undefined
        ? null
        : sanitizeSessionText(
          task.workspace,
          this.token,
          MAX_SESSION_WORKSPACE_CHARS,
          "workspace"
        ),
      mode: task.mode ?? null
    };
  }

  counts() {
    let running = 0;
    let queued = 0;
    for (const task of this.tasks) {
      if (task.status === "running") running += 1;
      else if (task.status === "queued") queued += 1;
    }
    return { running, queued };
  }

  validateRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "invalid_request");
    }
    const { requestId, repo, task, session, sessionId, workspace, newSession } = body;
    if (
      typeof requestId !== "string"
      || requestId.length < 1
      || requestId.length > 256
      || /\p{Cc}/u.test(requestId)
    ) {
      throw new ApiError(400, "invalid_request");
    }
    if (typeof task !== "string" || codePointLength(task) < 1 || codePointLength(task) > 4000) {
      throw new ApiError(400, "invalid_request");
    }
    if (repo !== undefined && (typeof repo !== "string" || !Object.hasOwn(this.config.repos, repo))) {
      throw new ApiError(400, "invalid_repo");
    }
    const optionalQuery = (value, maxLength) => {
      if (value === undefined) return null;
      if (
        typeof value !== "string"
        || value.trim().length < 1
        || value.length > maxLength
        || /\p{Cc}/u.test(value)
      ) {
        throw new ApiError(400, "invalid_request");
      }
      return value.trim();
    };
    let normalizedSessionId = null;
    if (sessionId !== undefined) {
      if (!isValidSessionId(sessionId)) {
        throw new ApiError(400, "invalid_session_id");
      }
      normalizedSessionId = sessionId;
    }
    const normalized = {
      requestId,
      task,
      repo: repo ?? null,
      sessionId: normalizedSessionId,
      session: optionalQuery(session, MAX_SESSION_WORKSPACE_CHARS),
      workspace: optionalQuery(workspace, MAX_SESSION_WORKSPACE_CHARS),
      newSession: newSession === true
    };
    if (newSession !== undefined && typeof newSession !== "boolean") {
      throw new ApiError(400, "invalid_request");
    }
    if (normalized.newSession && (normalized.sessionId !== null || normalized.session !== null)) {
      throw new ApiError(400, "invalid_request");
    }
    if (
      normalized.repo === null
      && normalized.sessionId === null
      && normalized.session === null
      && normalized.workspace === null
    ) {
      throw new ApiError(400, "invalid_request");
    }
    return normalized;
  }

  resolveRepo(alias) {
    const configured = this.config.repos[alias];
    try {
      return validateRepoPath(configured, { env: this.env });
    } catch (error) {
      if (error instanceof RepoValidationError) throw new ApiError(400, "invalid_repo");
      throw new ApiError(400, "invalid_repo");
    }
  }

  revalidateSessionCwd(value, code) {
    const allowed = buildAllowedRoots(this.config, { env: this.env });
    const cwd = canonicalAllowedDirectory(value, allowed);
    if (cwd === null) throw new ApiError(404, code);
    return cwd;
  }

  resumeTarget(session) {
    if (session.resumable === false) {
      throw new ApiError(409, "session_preset_incompatible");
    }
    return {
      mode: "resume",
      sessionId: session.sessionId,
      workspace: session.workspace,
      repo: SESSION_TARGET_REPO,
      repoAlias: null,
      cwd: this.revalidateSessionCwd(session.cwd, "session_not_found")
    };
  }

  resolveTarget(request) {
    const needsSessions = request.sessionId !== null
      || request.session !== null
      || request.workspace !== null;
    const sessions = needsSessions ? loadSessions(this.config, { env: this.env }) : [];
    let target = null;

    if (request.sessionId !== null) {
      const session = findSessionById(sessions, request.sessionId);
      if (session === null) throw new ApiError(404, "session_not_found");
      target = this.resumeTarget(session);
    } else if (request.session !== null) {
      const matches = matchSessionQuery(sessions, request.session);
      if (matches.length === 0) throw new ApiError(404, "session_not_found");
      if (matches.length > 1) throw new ApiError(409, "session_ambiguous");
      target = this.resumeTarget(matches[0]);
    }

    if (target !== null && request.workspace !== null) {
      if (!workspaceMatchesLabel(target.workspace, request.workspace)) {
        throw new ApiError(409, "session_workspace_mismatch");
      }
    }

    if (target === null && request.workspace !== null) {
      const resolved = resolveWorkspaceQuery(this.config, sessions, request.workspace, {
        env: this.env
      });
      if (resolved === null) throw new ApiError(404, "workspace_not_found");
      if (resolved.kind === "ambiguous") throw new ApiError(409, "workspace_ambiguous");
      if (resolved.kind === "worktree") {
        target = {
          mode: "worktree",
          sessionId: null,
          workspace: resolved.workspace,
          repo: resolved.repo,
          repoAlias: resolved.repo,
          cwd: null
        };
      } else if (resolved.kind === "resume" && !request.newSession) {
        target = this.resumeTarget(resolved.session);
      } else if (resolved.kind === "resume" && typeof resolved.repoAlias === "string") {
        target = {
          mode: "worktree",
          sessionId: null,
          workspace: resolved.repoAlias,
          repo: resolved.repoAlias,
          repoAlias: resolved.repoAlias,
          cwd: null
        };
      } else if (resolved.kind === "resume") {
        target = {
          mode: "workspace",
          sessionId: null,
          workspace: resolved.session.workspace,
          repo: SESSION_TARGET_REPO,
          repoAlias: null,
          cwd: this.revalidateSessionCwd(resolved.session.cwd, "session_not_found")
        };
      } else {
        target = {
          mode: "workspace",
          sessionId: null,
          workspace: resolved.workspace,
          repo: SESSION_TARGET_REPO,
          repoAlias: null,
          cwd: this.revalidateSessionCwd(resolved.cwd, "workspace_not_found")
        };
      }
    }

    if (target === null) {
      if (request.repo === null) throw new ApiError(400, "invalid_request");
      target = {
        mode: "worktree",
        sessionId: null,
        workspace: null,
        repo: request.repo,
        repoAlias: request.repo,
        cwd: null
      };
    }
    return target;
  }

  listSessions({ q, limit } = {}) {
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(Math.max(limit, 1), MAX_SESSION_LIMIT)
      : DEFAULT_SESSION_LIMIT;
    return filterSessions(loadSessions(this.config, { env: this.env }), {
      q,
      limit: normalizedLimit
    }).map((session) => {
      const projected = projectSession(session);
      projected.title = sanitizeSessionText(
        projected.title,
        this.token,
        MAX_SESSION_TITLE_CHARS,
        "未命名会话"
      );
      projected.workspace = sanitizeSessionText(
        projected.workspace,
        this.token,
        MAX_SESSION_WORKSPACE_CHARS,
        "workspace"
      );
      return projected;
    });
  }

  replayConflicts(existing, request, taskHash) {
    if (existing.taskHash !== taskHash) return true;
    if (request.sessionId !== null && (existing.sessionId ?? null) !== request.sessionId) {
      return true;
    }
    if (request.session !== null && !sessionQueryMatchesExisting(existing, request.session)) {
      return true;
    }
    if (request.workspace !== null) {
      if (!workspaceQueryMatchesExisting(existing.workspace, request.workspace)) return true;
      if (request.newSession) {
        const exactAlias = Object.keys(this.config.repos).find(
          (alias) => alias.toLowerCase() === request.workspace.toLowerCase()
        );
        if (exactAlias !== undefined && existing.mode !== "worktree") return true;
      }
    }
    if (request.newSession) {
      if (existing.mode === "resume") return true;
      if (request.workspace === null && existing.mode === "workspace") return true;
    }
    if (request.repo !== null) {
      const noOtherTarget = request.sessionId === null
        && request.session === null
        && request.workspace === null;
      if (noOtherTarget) {
        if (existing.mode !== "worktree" && existing.mode !== null) return true;
      }
      if (
        (existing.mode === "worktree" || existing.mode === null)
        && existing.repo !== request.repo
      ) {
        return true;
      }
    }
    return false;
  }

  submit(body) {
    const request = this.validateRequest(body);
    const taskHash = createHash("sha256").update(request.task, "utf8").digest("hex");
    const existing = this.byRequestId.get(request.requestId);
    if (existing !== undefined) {
      if (this.replayConflicts(existing, request, taskHash)) {
        throw new ApiError(409, "request_id_conflict");
      }
      return { statusCode: 200, duplicate: true, task: this.project(existing) };
    }

    const target = this.resolveTarget(request);
    const repoPath = target.mode === "worktree" ? this.resolveRepo(target.repo) : null;
    if (this.counts().queued >= MAX_QUEUED) {
      throw new ApiError(429, "queue_full");
    }

    const createdAt = isoNow();
    const task = {
      taskId: `ct-${randomUUID()}`,
      requestId: request.requestId,
      repo: target.repo,
      status: "queued",
      worktree: null,
      changedFiles: [],
      diffStat: emptyDiffStat(),
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
      taskHash,
      taskText: request.task,
      sessionId: target.sessionId,
      workspace: target.workspace,
      mode: target.mode,
      targetCwd: target.cwd
    };
    this.tasks.push(task);
    this.byId.set(task.taskId, task);
    this.byRequestId.set(task.requestId, task);
    if (repoPath !== null) this.repoPaths.set(task.taskId, repoPath);
    try {
      this.persist();
    } catch {
      this.tasks.pop();
      this.byId.delete(task.taskId);
      this.byRequestId.delete(task.requestId);
      this.repoPaths.delete(task.taskId);
      throw new ApiError(500, "state_write_failed");
    }
    queueMicrotask(() => this.schedule());
    return { statusCode: 202, duplicate: false, task: this.project(task) };
  }

  get(taskId) {
    const task = this.byId.get(taskId);
    return task === undefined ? null : this.project(task);
  }

  cancel(taskId) {
    const task = this.byId.get(taskId);
    if (task === undefined) return null;
    if (TERMINAL_STATUSES.has(task.status)) return this.project(task);

    if (task.status === "queued") {
      task.status = "canceled";
      task.error = null;
      task.summary = null;
      task.timestamps.finishedAt = isoNow();
      task.timestamps.updatedAt = task.timestamps.finishedAt;
      task.taskText = null;
      this.persist();
      return this.project(task);
    }

    if (task.cancelRequestedAt === null) {
      task.cancelRequestedAt = isoNow();
      task.timestamps.updatedAt = task.cancelRequestedAt;
      this.persistBestEffort();
    }
    this.clearActiveTimer();
    if (this.activeHandle?.pid) {
      killProcessTree(this.activeHandle.pid).catch(() => {});
    }
    return this.project(task);
  }

  finalizeTask(task, status, error = null, summary = null) {
    const now = isoNow();
    task.status = status;
    task.error = stableError(error);
    task.summary = summary === null ? null : capCodePoints(summary, MAX_SUMMARY_CHARS);
    task.timestamps.finishedAt = now;
    task.timestamps.updatedAt = now;
    task.taskText = null;
    this.persistBestEffort();
  }

  clearActiveTimer() {
    if (this.activeTimer !== null) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
  }

  schedule() {
    if (!this.started || this.stopping || this.active !== null) return;
    const task = this.tasks.find((candidate) => candidate.status === "queued");
    if (task === undefined) return;
    this.active = task;
    this.activeRunPromise = this.runTask(task)
      .catch(() => {
        if (task.status === "running") {
          this.finalizeTask(task, "failed", "internal_error");
        }
      })
      .finally(() => {
        this.clearActiveTimer();
        this.activeHandle = null;
        this.active = null;
        this.activeRunPromise = null;
        this.schedule();
      });
  }

  async runTask(task) {
    const taskText = task.taskText;
    if (typeof taskText !== "string" || taskText.length === 0) {
      this.finalizeTask(task, "failed", "state_task_missing");
      return;
    }

    const startedAt = isoNow();
    task.status = "running";
    task.timestamps.startedAt = startedAt;
    task.timestamps.updatedAt = startedAt;
    task.taskText = null;
    this.persist();

    const mode = task.mode ?? "worktree";
    let launchCwd = null;
    let sessionId;
    if (mode === "worktree") {
      let repoPath = this.repoPaths.get(task.taskId);
      if (repoPath === undefined) {
        try {
          repoPath = validateRepoPath(this.config.repos[task.repo], { env: this.env });
        } catch {
          this.finalizeTask(task, "failed", "invalid_repo");
          return;
        }
      }

      if (task.cancelRequestedAt !== null) {
        this.finalizeTask(task, "canceled");
        return;
      }

      try {
        task.worktree = createTaskWorktree({
          root: this.config.worktreeRoot,
          taskId: task.taskId,
          repoPath,
          env: this.env
        });
      } catch (error) {
        this.finalizeTask(
          task,
          "failed",
          error instanceof WorktreeError ? error.message : "worktree_create_failed"
        );
        return;
      }
      task.timestamps.updatedAt = isoNow();
      this.persistBestEffort();
      launchCwd = task.worktree;
    } else {
      if (mode === "resume" && !isValidSessionId(task.sessionId ?? "")) {
        this.finalizeTask(
          task,
          "failed",
          task.sessionId === null ? "session_not_found" : "invalid_session_id"
        );
        return;
      }
      const allowed = buildAllowedRoots(this.config, { env: this.env });
      const cwd = canonicalAllowedDirectory(task.targetCwd, allowed);
      if (cwd === null) {
        this.finalizeTask(
          task,
          "failed",
          mode === "resume" ? "session_not_found" : "workspace_not_found"
        );
        return;
      }
      task.targetCwd = cwd;
      launchCwd = cwd;
      if (mode === "resume") sessionId = task.sessionId;
    }

    if (task.cancelRequestedAt !== null) {
      this.finalizeTask(task, "canceled");
      return;
    }

    this.activeHandle = launchDsh({
      command: this.config.dshCommand,
      cwd: launchCwd,
      task: taskText,
      sessionId,
      env: this.env
    });

    if (!this.activeHandle.pid) {
      const spawnError = this.activeHandle.spawnError;
      this.finalizeTask(
        task,
        "failed",
        spawnError === "unsafe_cmd_path"
          ? "unsafe_dsh_command"
          : spawnError === "invalid_session_id"
            ? "invalid_session_id"
            : "dsh_spawn_failed"
      );
      return;
    }

    this.activeTimer = setTimeout(() => {
      if (task.status !== "running" || TERMINAL_STATUSES.has(task.status)) return;
      task.timeoutFired = true;
      killProcessTree(this.activeHandle?.pid).catch(() => {});
    }, this.config.taskTimeoutMs);
    this.activeTimer.unref?.();

    if (task.cancelRequestedAt !== null) {
      this.clearActiveTimer();
      killProcessTree(this.activeHandle.pid).catch(() => {});
    }

    const result = await this.activeHandle.done;
    this.clearActiveTimer();

    let status;
    let error = null;
    let summary = null;
    if (task.cancelRequestedAt !== null) {
      status = "canceled";
    } else if (task.shutdownRequested) {
      status = "failed";
      error = "bridge_shutdown";
    } else if (task.timeoutFired) {
      status = "timed_out";
      error = "dsh_timeout";
    } else if (result.spawnError) {
      status = "failed";
      error = "dsh_spawn_failed";
    } else if (result.code === 0) {
      status = "succeeded";
      summary = extractSummary(this.activeHandle.stdout.text(), this.token, taskText);
    } else {
      status = "failed";
      error = classifyDshFailure(this.activeHandle.stderr.text())
        ?? (Number.isInteger(result.code) ? `dsh_exit_code_${result.code}` : "dsh_terminated");
    }

    task.outputTruncated = this.activeHandle.stdout.truncated || this.activeHandle.stderr.truncated;
    try {
      const changes = collectWorktreeChanges(task.worktree ?? task.targetCwd, this.env);
      task.changedFiles = changes.changedFiles;
      task.diffStat = changes.diffStat;
    } catch {
      task.changedFiles = [];
      task.diffStat = emptyDiffStat();
    }
    this.finalizeTask(task, status, error, summary);
  }

  async stop() {
    if (this.stopPromise !== null) return this.stopPromise;
    this.started = false;
    this.stopping = true;
    this.stopPromise = (async () => {
      const active = this.active;
      if (active !== null && active.status === "running") {
        active.shutdownRequested = true;
        this.clearActiveTimer();
        if (this.activeHandle?.pid) {
          await killProcessTree(this.activeHandle.pid);
        }
        if (this.activeRunPromise !== null) {
          await Promise.race([
            this.activeRunPromise.catch(() => {}),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 8000);
              timer.unref?.();
            })
          ]);
        }
        if (active.status === "running") {
          this.finalizeTask(active, "failed", "bridge_shutdown");
        }
      }
      this.persistBestEffort();
    })();
    return this.stopPromise;
  }
}
