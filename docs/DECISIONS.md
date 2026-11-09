# Decisions

## D-001: One repository, two packages

`packages/supervisor` and `packages/dsh-plugin` are separate packages in one
repository for the MVP. The supervisor owns process lifecycle; the DSH package
only contains host/client adaptation and control-plane forwarding. This keeps
DSH-specific code isolated without forcing a cross-repository release and
version sync before the first usable version. Split the repository only if the
plugin later needs an independent release cadence.

## D-002: External processes are read-only

An endpoint with a live PID is shown as `external`. The supervisor must not
start a duplicate, stop it, or kill it. Manual stop/restart returns 409. This
protects the currently running QQ robot and memory service during the
transition.

## D-003: Current-user registry Run is the default autostart backend

The protected Windows Startup folder rejected the atomic write with EPERM on
this machine. Scheduled tasks work, but add a second scheduler-owned lifecycle
and generated task artifacts during testing. The default is therefore the
current-user registry Run value; Startup and ONLOGON XML task backends remain
available as explicit fallbacks. Autostart is disabled by default. It launches
only the supervisor; `startServicesOnBoot` (default `false`) decides whether
managed services are started too.

## D-004: DSH closure does not own supervisor lifetime

The plugin may spawn the supervisor when it is absent, but plugin disposal or
DSH shutdown never stops it. The supervisor is a separate detached process and
is the only component that owns managed child processes.

## D-005: Render the panel outside the sidebar slot

The panel is rendered with a React portal into `document.body` rather than
inside the `sidebar.footer.action` slot. The slot's DOM ancestry is controlled
by DSH and can clip the panel or intercept pointer events. The portal isolates
the control panel from that layout while the footer button remains the entry
point. Panel click events stop propagation for the same reason.

The panel owns its light/dark palette instead of relying on host theme
variables. The default is light for reliable contrast, and the selected theme
is persisted in local storage.

## D-006: Managed takeover requires explicit authorization

An external process is never adopted or killed implicitly. Moving a service
from external to managed is a controlled operation: the user must approve the
short service interruption, the old supervisor and external process must be
stopped, secrets must be supplied through a gitignored env file, and the
service must be started again through the supervisor API.

The 2026-11-05 takeover established managed PIDs for both services and verified
that qq-gateway can restart from the supervisor while reusing its WS token.
Once managed, start/stop/restart are supervisor-owned operations. If a service
is later started outside the supervisor again, it remains read-only under
D-002 until another explicit takeover.

## D-007: Boot starts the supervisor only

The user enabled Windows autostart on 2026-11-05 but explicitly chose not to
start ds-memory or qq-gateway automatically. `startServicesOnBoot` stays
`false`: logon starts only the supervisor, and the operator starts each service
from the XTDS panel.

The actual boot script was exercised: supervisor started, both services stayed
stopped, the registry Run value was present, and the services were then started
manually through the API. A real Windows logoff/logon cycle has not been
executed and remains a verification item.

## D-008: State backup restore is drill-only

The backup manifest is an unsigned, self-describing artifact. Size and SHA-256
checks detect corruption but cannot prove provenance; a forged manifest cannot
be made trustworthy without an external signing key. Therefore
`ops/backup-state.mjs restore` is restricted to a strict descendant of the
built-in `runtime/restore-drill` root, `create` rejects sources overlapping that
root, and the CLI exposes no root override. The tool must never be used for
live-state recovery. Real recovery remains a manual incident operation with its
own stop, backup, rollback, and approval steps. This separates the untrusted
manifest content from the target-path safety boundary.

## D-009: Service logs are bounded and may pause instead of dropping supervision

Managed service stdout/stderr is buffered by complete logical line before it is
written. A line over 8 MiB is discarded as a whole and replaced with a fixed
marker; a normal unterminated tail is flushed when the child stdio session
closes. This favors secret safety and bounded memory over preserving arbitrarily
large single lines.

Logs rotate at 5 MiB by default, retaining 5 archives (configurable within
1 KiB..1 GiB and 1..50 archives). Archive names contain a 12-digit monotonic
sequence, epoch milliseconds, PID, and random suffix. Retention is ordered by
sequence first, so a system clock rollback cannot cause a newer archive to be
deleted.

Each service keeps one writer across stop/start. The writer is closed only on
supervisor shutdown or a terminal unmanaged handoff. Shutdown waits up to 5
seconds for stdio sessions to close naturally, then warns with the remaining
session count and force-closes; output arriving after that bound may be lost.

If archive cleanup or an over-limit rename cannot be completed, logging for that
service pauses instead of growing active or archive files without bound. Writes
resume after retention is enforceable. A permanent cleanup failure keeps at most
`logMaxFiles + 1` archives; active stays within `logMaxBytes` except for the
documented single-oversized-chunk allowance. Logging failures never block
managed service startup or process supervision. A fresh supervisor bootstrap
still requires a creatable `runtime/logs` directory.

## D-010: Offline QQ link is degraded, not healthy

An HTTP 2xx from qq-gateway's `/health` endpoint proves that the gateway process
can serve requests, but not that its OneBot connection is online. The gateway
already reports that distinction as `online`; the supervisor now consumes it
without changing the gateway or the `/health` contract.

`healthRequireOnline` is a per-service setting and defaults to `false` so
existing services keep their current HTTP-only health semantics. qq-gateway
sets it to `true`. The supervisor reads at most 64 KiB, never logs or returns
the raw health body, and adds `online` plus `healthDetail` to status items.
`online=false` is `degraded`/`onebot_offline`; invalid or oversized JSON is
`degraded`/`health_invalid`; a missing/non-boolean field is
`degraded`/`online_missing`.

Readiness deliberately requires only an available HTTP endpoint. Starting an
offline qq-gateway succeeds in `running`, then the health loop updates it to
`healthy` when SnowLuma reconnects. Degraded health is observational: it does
not trigger a restart or alter the gateway process.

## D-011: SnowLuma hidden launch stays user-owned

SnowLuma remains an external process. The supervisor does not start, stop,
restart, or supervise it, and no boot or scheduled-task integration is added.
The optional `tools/start-snowluma-hidden.vbs` launcher exists only for an
explicit user invocation: it starts the configured SnowLuma directory with a
hidden window so closing or losing the launcher console cannot terminate the
bot. It does not poll, guard, auto-restart, or alter SnowLuma files.

The control panel determines QQ link state from qq-gateway `/health.online`,
not from SnowLuma process presence. This keeps the external application
replaceable and avoids a second lifecycle owner while still surfacing a closed
SnowLuma as `degraded`.

## D-012: SnowLuma Web UI address is read-only discovery

The DSH plugin may display the SnowLuma Web UI address, but it does not manage
SnowLuma's lifecycle. `config/snowluma.json` stores only the user-owned
SnowLuma home. On a successful status response, the host reads that home's
`config/runtime.json` and projects only `webuiHost`, `webuiPort`, and
`webuiTls.enabled` into the status API. The home, raw runtime contents, and
unrelated fields are never returned or logged.

A URL is generated only for loopback hosts. Valid non-loopback hosts are shown
for diagnosis but cannot become a clickable link from DSH. Missing or malformed
configuration, runtime data, hosts, or ports produce stable non-fatal reasons
instead of an API error. The supervisor remains unchanged and is not involved
in SnowLuma discovery. Starting, stopping, restarting, configuring, and securing
SnowLuma remain the user's responsibility.

## D-013: open-websearch is the third supervised process

`open-websearch` is managed by the same supervisor as ds-memory and
qq-gateway. Its launcher owns the actual daemon child and publishes the
dynamic port through `open-websearch.endpoint.json`; the supervisor must
therefore accept an endpoint whose PID belongs to the launcher's child.
This is enabled only by the explicit `endpointPid: "any"` service option.
The default remains `"self"`, which preserves the existing identity check for
every other managed process. With `"any"`, the endpoint name must still match
the service id and the endpoint PID must be alive.

The DSH plugin exposes start/stop/restart routes for the fixed
`open-websearch` id, so the third card is controllable from the panel rather
than being display-only. The supervisor still refuses to adopt external
instances; a standalone launcher is shown as `external` until it is stopped
and started by the supervisor.

## D-014: code-bridge is the fourth supervised process

`code-bridge` is managed by the same supervisor as ds-memory, qq-gateway, and
open-websearch. It listens on loopback only, keeps its token in a configurable
`runtimeDir` (the default is `%LOCALAPPDATA%\DSH\runtime`), and publishes a
token-free endpoint file. The supervisor neither reads nor proxies that token;
ds-memory reads it directly when the owner sends a `code` command.

The bridge creates one detached git worktree per task, invokes the local DSH
CLI with fixed workspace-write arguments, and never commits, pushes, merges, or
edits the main checkout. The DSH plugin exposes start/stop/restart routes for
the fixed `code-bridge` id. The command path is restricted to the owner's
private chat; group members and non-owner private chats cannot create tasks.

## D-015: headless DSH tasks reuse the desktop account credential

The DSH `headless` profile disables `authorization`, `deepseek-account`, and
`credentials` and defaults to `deepseek-official`, which requires an API key in
the child environment. Passing `DEEPSEEK_API_KEY` through code-bridge would
weaken its sensitive-environment filter and expose the key to the coding agent.

Instead, the machine-local headless profile patch now selects
`provider: deepseek-account`, re-enables the three credential plugins, and sets
`desktopPlatform: win32`. DSH CLI therefore resolves the same account grant as
DSH Desktop. The original file is backed up next to the profile as
`cordis.patch.yml.bak-xtds-code-bridge`. A DSH upgrade that rewrites the profile
may require re-applying this patch; without it, tasks fail with
`MISSING_CREDENTIAL` or `ACCOUNT_SIGN_IN_REQUIRED`.

## D-016: code-bridge enumerates and resumes DSH sessions

`code-bridge` reads DSH's read-only session index from `dshSessionsDir` and
exposes `GET /v1/sessions`. Session cwd values are accepted only after
`realpath` containment checks against the configured repos, `worktreeRoot`,
`dshWorkspaceRoot`, and optional `workspaceRoots`; blank, corrupt, oversized,
missing, or out-of-root entries are skipped. Workspace labels are display-only
(`<alias>`, `<alias>@<ct-prefix>`, `worktree@<ct-prefix>`, or a basename) and
never expose absolute paths.

`POST /v1/tasks` keeps `repo` as "create a new isolated worktree". A `session`
or `sessionId` resumes the existing cwd without creating a worktree and starts
DSH with a strictly validated `--session-id`. A `workspace` query resumes the
most recently used session in that workspace; repo aliases also include their
`<alias>@...` worktree sessions. Empty non-repo workspaces start a new session
in place, while empty repo aliases create a worktree. Resume and in-place
session tasks are projected with the internal `repo` label `dsh-session` and
`mode` (`resume` or `workspace`). Ambiguous session or workspace queries return
409 instead of guessing. `newSession=true` with an exact repo alias still
creates a fresh isolated worktree; in-place workspace mode is limited to a
concrete worktree label or a non-repo directory. Session/workspace consistency
uses exact labels or an `alias@...` prefix, never arbitrary substrings. An
explicit malformed `sessionId` is rejected with `400 invalid_session_id`, while
a well-formed missing id remains `404 session_not_found`. Duplicate requestId
replays are resolved before loading the session index, so deleting a session
file or workspace after submission still returns the existing task with `200`.

## D-017: Martilyric is an explicit code-bridge repo

DSH's workspace registry is not itself a code-bridge allowlist. A workspace
visible in the desktop UI is ignored by `/v1/sessions` and natural-language
workspace selection unless its path is also under the configured `repos`,
`worktreeRoot`, `dshWorkspaceRoot`, or `workspaceRoots`.

`Martilyric` is a git top-level directory at
`C:\Users\demo\Desktop\Martilyric`, so it is added as the explicit repo
alias `martilyric` rather than as a broad `Desktop` workspace root. QQ can now
recognize workspace labels derived from that repository and create isolated
worktrees there. Desktop-preset sessions such as the existing `Greeting`
session remain visible but non-resumable; the alias creates a fresh session
instead of bypassing the headless preset restriction.

## D-018: code-bridge runtime files live inside the repository on this host

The Codex desktop host and the supervisor-managed child could resolve the same
`%LOCALAPPDATA%\DSH\runtime\code-bridge.token` path to different file contents.
The bridge then started with one token while ds-memory and operator probes read
another, producing a persistent `401 unauthorized` even though the session API
itself was healthy.

This host therefore pins code-bridge to
`E:\workspace\xtds-assistant-dsh\runtime\code-bridge`. The
supervisor endpoint file and ds-memory `codeBridge.endpointFile`/`tokenFile`
use the same directory. `runtime/` is already ignored by git. This is a
deployment-level override of the package default, not a change to the
code-bridge protocol or to its optional standalone defaults.
