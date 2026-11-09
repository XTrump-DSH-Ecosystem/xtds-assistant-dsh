import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_TITLE_CHARS,
  MAX_SESSION_WORKSPACE_CHARS,
  SESSION_ID_PATTERN
} from "./constants.js";
import {
  comparablePath,
  isPathWithinOrEqual,
  readGitCommonDir,
  samePath
} from "./git.js";

const SESSION_FILE_PATTERN = /^(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const UNTITLED_SESSION = "未命名会话";
const MAX_DISCOVERED_CHILDREN = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalDirectory(value) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) return null;
  try {
    const real = realpathSync.native(value);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function canonicalFile(value) {
  try {
    const real = realpathSync.native(value);
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function buildAllowedRoots(config, options = {}) {
  const env = options.env ?? process.env;
  const roots = [];
  const repos = [];
  const addRoot = (value) => {
    const real = canonicalDirectory(value);
    if (real === null) return null;
    if (!roots.some((root) => samePath(root, real))) roots.push(real);
    return real;
  };

  for (const [alias, repoPath] of Object.entries(config.repos)) {
    const real = addRoot(repoPath);
    if (real !== null) repos.push({ alias, path: real });
  }
  const worktreeRoot = addRoot(config.worktreeRoot);
  const dshWorkspaceRoot = addRoot(config.dshWorkspaceRoot);
  const workspaceRoots = [];
  for (const root of config.workspaceRoots ?? []) {
    const real = addRoot(root);
    if (real !== null) workspaceRoots.push(real);
  }

  return {
    env,
    roots,
    repos,
    worktreeRoot,
    dshWorkspaceRoot,
    workspaceRoots
  };
}

export function canonicalAllowedDirectory(value, allowed) {
  const real = canonicalDirectory(value);
  if (real === null) return null;
  return allowed.roots.some((root) => isPathWithinOrEqual(root, real)) ? real : null;
}

function unwrapRow(row) {
  if (isObject(row) && Object.hasOwn(row, "val")) return row.val;
  return row;
}

export function rowValue(rows, key) {
  if (Array.isArray(rows)) {
    const entry = rows.find((candidate) => {
      if (Array.isArray(candidate)) return candidate[0] === key;
      if (!isObject(candidate)) return false;
      return candidate.key === key || candidate.name === key || candidate.id === key;
    });
    if (entry === undefined) return undefined;
    if (Array.isArray(entry)) return unwrapRow(entry[1]);
    if (Object.hasOwn(entry, "value")) return unwrapRow(entry.value);
    if (Object.hasOwn(entry, "row")) return unwrapRow(entry.row);
    return unwrapRow(entry.val);
  }
  if (!isObject(rows) || !Object.hasOwn(rows, key)) return undefined;
  return unwrapRow(rows[key]);
}

function normalizeMillis(value) {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : numeric;
}

function capTitle(value) {
  return sanitizeText(value, MAX_SESSION_TITLE_CHARS);
}

function sanitizeText(value, maxChars) {
  const cleaned = value.replace(CONTROL_CHARS, " ").trim();
  const characters = [...cleaned];
  if (characters.length <= maxChars) return cleaned;
  return characters.slice(0, maxChars).join("");
}

function safeLabel(value) {
  const cleaned = sanitizeText(value, MAX_SESSION_WORKSPACE_CHARS);
  return cleaned.length > 0 ? cleaned : "workspace";
}

function ctPrefix(cwd) {
  const match = /^ct-([0-9a-f]{8})/i.exec(basename(cwd));
  return match === null ? null : `ct-${match[1].toLowerCase()}`;
}

function fallbackLabel(cwd) {
  const name = basename(cwd);
  return name.length > 0 && name !== "." && name !== ".." ? name : "workspace";
}

function repoForCwd(cwd, allowed) {
  return allowed.repos.find((repo) => samePath(repo.path, cwd)) ?? null;
}

function labelForCwd(cwd, allowed) {
  const repo = repoForCwd(cwd, allowed);
  if (repo !== null) {
    return {
      label: safeLabel(repo.alias),
      repoAlias: repo.alias,
      isRepoWorktree: false,
      isRepoRoot: true
    };
  }

  const commonDir = readGitCommonDir(cwd, allowed.env);
  if (commonDir !== null) {
    for (const candidate of allowed.repos) {
      const gitDir = canonicalFile(join(candidate.path, ".git"))
        ?? canonicalDirectory(join(candidate.path, ".git"));
      if (gitDir !== null && samePath(commonDir, gitDir)) {
        return {
          label: safeLabel(`${candidate.alias}@${ctPrefix(cwd) ?? fallbackLabel(cwd)}`),
          repoAlias: candidate.alias,
          isRepoWorktree: true,
          isRepoRoot: false
        };
      }
    }
  }

  if (allowed.worktreeRoot !== null && isPathWithinOrEqual(allowed.worktreeRoot, cwd)) {
    return {
      label: safeLabel(`worktree@${ctPrefix(cwd) ?? fallbackLabel(cwd)}`),
      repoAlias: null,
      isRepoWorktree: true,
      isRepoRoot: false
    };
  }

  return {
    label: safeLabel(fallbackLabel(cwd)),
    repoAlias: null,
    isRepoWorktree: false,
    isRepoRoot: false
  };
}

export function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function loadSessions(config, options = {}) {
  const allowed = options.allowed ?? buildAllowedRoots(config, options);
  let names;
  try {
    names = readdirSync(config.dshSessionsDir);
  } catch {
    return [];
  }

  const labelCache = new Map();
  const sessions = [];
  for (const name of names) {
    const match = SESSION_FILE_PATTERN.exec(name);
    if (match === null) continue;
    const filePath = join(config.dshSessionsDir, name);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) continue;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    if (!isObject(parsed) || !isObject(parsed.record)) continue;
    const record = parsed.record;
    const identity = isObject(record.identity) ? record.identity : {};
    const rows = record.rows;

    const metadata = rowValue(rows, "sessionListMetadata");
    if (isObject(metadata) && metadata.blank === true) continue;

    const cwd = canonicalAllowedDirectory(identity.cwd, allowed);
    if (cwd === null) continue;

    const createdAt = normalizeMillis(identity.createdAt);
    const lastPromptAt = isObject(metadata) ? normalizeMillis(metadata.lastPromptAt) : null;
    const lastUsedMs = lastPromptAt ?? createdAt;
    if (lastUsedMs === null) continue;

    let label = labelCache.get(comparablePath(cwd));
    if (label === undefined) {
      label = labelForCwd(cwd, allowed);
      labelCache.set(comparablePath(cwd), label);
    }

    const rawTitle = rowValue(rows, "title");
    const searchTitle = typeof rawTitle === "string"
      ? rawTitle.replace(CONTROL_CHARS, " ").trim()
      : "";
    const title = searchTitle.length > 0 ? capTitle(searchTitle) : UNTITLED_SESSION;
    const rawAgentPreset = rowValue(rows, "agentPreset");
    const agentPreset = typeof rawAgentPreset === "string" && rawAgentPreset.trim().length > 0
      ? rawAgentPreset.trim()
      : null;

    sessions.push({
      sessionId: match[1],
      title,
      searchTitle: searchTitle.length > 0 ? searchTitle : UNTITLED_SESSION,
      workspace: label.label,
      lastUsedAt: new Date(lastUsedMs).toISOString(),
      lastUsedMs,
      cwd,
      repoAlias: label.repoAlias,
      isRepoWorktree: label.isRepoWorktree,
      agentPreset,
      resumable: agentPreset === null
    });
  }

  sessions.sort((left, right) => {
    if (left.lastUsedMs !== right.lastUsedMs) return right.lastUsedMs - left.lastUsedMs;
    return left.sessionId.localeCompare(right.sessionId);
  });
  return sessions;
}

export function projectSession(session) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    workspace: session.workspace,
    lastUsedAt: session.lastUsedAt,
    resumable: session.resumable !== false
  };
}

export function filterSessions(sessions, options = {}) {
  const limit = options.limit ?? 10;
  const query = typeof options.q === "string" ? options.q.trim().toLowerCase() : "";
  const filtered = query.length === 0
    ? sessions
    : sessions.filter((session) =>
      (session.searchTitle ?? session.title).toLowerCase().includes(query)
      || session.workspace.toLowerCase().includes(query)
      || session.sessionId.toLowerCase().includes(query));
  return filtered.slice(0, limit);
}

export function matchSessionQuery(sessions, query) {
  const raw = query.trim().toLowerCase();
  const stripped = raw.startsWith("session-") ? raw.slice("session-".length) : raw;
  return sessions.filter((session) => {
    const id = session.sessionId.toLowerCase();
    const idPart = id.slice("session-".length);
    return id === raw
      || idPart === stripped
      || (stripped.length >= 8 && idPart.startsWith(stripped))
      || (session.searchTitle ?? session.title).toLowerCase().includes(raw)
      || session.workspace.toLowerCase().includes(raw);
  });
}

export function findSessionById(sessions, sessionId) {
  const wanted = sessionId.toLowerCase();
  return sessions.find((session) => session.sessionId.toLowerCase() === wanted) ?? null;
}

function isRepoFamilyLabel(label, alias) {
  const normalized = label.toLowerCase();
  const normalizedAlias = alias.toLowerCase();
  return normalized === normalizedAlias || normalized.startsWith(`${normalizedAlias}@`);
}

function repoFamilyAlias(label, aliases) {
  return aliases.find((alias) => isRepoFamilyLabel(label, alias)) ?? null;
}

function latest(sessions) {
  let selected = null;
  for (const session of sessions) {
    if (selected === null || session.lastUsedMs > selected.lastUsedMs) selected = session;
  }
  return selected;
}

function addChildren(allowed, root, add) {
  if (root === null) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_DISCOVERED_CHILDREN);
  } catch {
    return;
  }
  for (const name of entries) {
    const cwd = canonicalAllowedDirectory(join(root, name), allowed);
    if (cwd === null) continue;
    const label = labelForCwd(cwd, allowed);
    add({ label: label.label, cwd, repoAlias: label.repoAlias });
  }
}

export function discoverWorkspaces(config, options = {}) {
  const allowed = options.allowed ?? buildAllowedRoots(config, options);
  const discovered = [];
  const seen = new Set();
  const add = (entry) => {
    const key = comparablePath(entry.cwd);
    if (seen.has(key)) return;
    seen.add(key);
    discovered.push(entry);
  };

  for (const repo of allowed.repos) {
    add({ label: repo.alias, cwd: repo.path, repoAlias: repo.alias });
  }
  if (allowed.dshWorkspaceRoot !== null) {
    add({
      label: labelForCwd(allowed.dshWorkspaceRoot, allowed).label,
      cwd: allowed.dshWorkspaceRoot,
      repoAlias: null
    });
  }
  for (const root of allowed.workspaceRoots) {
    add({ label: labelForCwd(root, allowed).label, cwd: root, repoAlias: null });
  }
  addChildren(allowed, allowed.dshWorkspaceRoot, add);
  for (const root of allowed.workspaceRoots) addChildren(allowed, root, add);
  addChildren(allowed, allowed.worktreeRoot, add);

  return discovered;
}

export function resolveWorkspaceQuery(config, sessions, query, options = {}) {
  const allowed = options.allowed ?? buildAllowedRoots(config, options);
  const normalized = query.trim().toLowerCase();
  const aliases = Object.keys(config.repos);
  // Desktop sessions with a named agent preset cannot be adopted by the
  // headless one-shot runner. Prefer resumable sessions; when a workspace has
  // only such sessions, fall through to a fresh session/worktree.
  const resumable = sessions.filter((session) => session.resumable !== false);
  const exactAlias = aliases.find((alias) => alias.toLowerCase() === normalized);
  if (exactAlias !== undefined) {
    const family = resumable.filter((session) => isRepoFamilyLabel(session.workspace, exactAlias));
    if (family.length > 0) {
      return {
        kind: "resume",
        session: latest(family),
        workspace: exactAlias,
        repoAlias: exactAlias
      };
    }
    return { kind: "worktree", repo: exactAlias, workspace: exactAlias };
  }

  const exactSessions = resumable.filter(
    (session) => session.workspace.toLowerCase() === normalized
  );
  if (exactSessions.length > 0) {
    const session = latest(exactSessions);
    return { kind: "resume", session, workspace: session.workspace };
  }

  const candidates = [];
  const candidateKeys = new Set();
  const addCandidate = (key, value) => {
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push(value);
  };

  for (const alias of aliases) {
    if (!alias.toLowerCase().includes(normalized)) continue;
    const family = resumable.filter((session) => isRepoFamilyLabel(session.workspace, alias));
    if (family.length > 0) {
      addCandidate(`repo:${alias}`, {
        kind: "resume",
        session: latest(family),
        workspace: alias
      });
    } else {
      addCandidate(`repo:${alias}`, { kind: "worktree", repo: alias, workspace: alias });
    }
  }

  for (const session of resumable) {
    if (!session.workspace.toLowerCase().includes(normalized)) continue;
    if (repoFamilyAlias(session.workspace, aliases) !== null) continue;
    addCandidate(`label:${session.workspace.toLowerCase()}`, {
      kind: "resume",
      session: latest(resumable.filter(
        (candidate) => candidate.workspace.toLowerCase() === session.workspace.toLowerCase()
      )),
      workspace: session.workspace
    });
  }

  for (const entry of discoverWorkspaces(config, { allowed })) {
    if (!entry.label.toLowerCase().includes(normalized)) continue;
    const owner = repoFamilyAlias(entry.label, aliases);
    if (owner !== null && owner.toLowerCase().includes(normalized)) continue;
    if (resumable.some((session) => samePath(session.cwd, entry.cwd))) continue;
    addCandidate(`dir:${comparablePath(entry.cwd)}`, {
      kind: "workspace",
      cwd: entry.cwd,
      workspace: entry.label
    });
  }

  if (candidates.length === 0) return null;
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return candidates[0];
}

export function workspaceMatchesLabel(label, query) {
  const normalizedLabel = label.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return false;
  return normalizedLabel === normalizedQuery
    || normalizedLabel.startsWith(`${normalizedQuery}@`);
}
