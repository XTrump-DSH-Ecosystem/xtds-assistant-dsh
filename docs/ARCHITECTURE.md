# Architecture

## Boundaries

`packages/supervisor` is a standalone Node process. It owns only processes it
started and never depends on DSH. `packages/dsh-plugin` is disposable: DSH can
close or unload it without affecting the supervisor or child processes.

## Supervisor

- Binds `127.0.0.1` only. Preferred port is 986; `EADDRINUSE` falls back to an
  OS-assigned port.
- Uses an exclusive `runtime/supervisor.lock` plus endpoint/PID validation to
  reject a second instance.
- Writes `runtime/supervisor.endpoint.json` without a token.
- Stores the control token in `runtime/config.json` (mode 0600 where supported).
- Reads the services' DSH runtime endpoint files. A live PID means `external`;
  no duplicate child is started.
- Per-service `endpointPid` defaults to `self`. `any` is reserved for launcher
  processes that publish an endpoint from a spawned daemon child; the endpoint
  name must still equal the service id and its PID must be alive.
- Expands `%VAR%`, `${VAR}`, and `~` in configured paths, deriving
  `LOCALAPPDATA` / `APPDATA` from `USERPROFILE` when a task launcher omits them.
- State machine per service:

```text
stopped -> starting -> running -> stopping -> stopped
                         \-> failed
external (not owned; stop/restart -> 409)
```

- Starting all services follows config order and waits for readiness between
  services, so ds-memory is ready before qq-gateway.
- The fourth managed process, `code-bridge`, is an independent loopback task
  service. It owns a separate token in `%LOCALAPPDATA%\DSH\runtime`, creates
  isolated git worktrees, and invokes the local DSH CLI with fixed arguments.
  The supervisor never reads or forwards its token. ds-memory is the only
  caller and accepts `code` commands from the owner private chat only.
- Health probes read at most 64 KiB of the JSON response body and never expose
  the raw body in logs or status. HTTP failure changes `health` to `unhealthy`
  with `online=null`. A 2xx response is `healthy` by default and can
  opportunistically sync a boolean `online` field.
- Per-service `healthRequireOnline` defaults to `false`. When enabled,
  `online=true` is healthy, `online=false` is `degraded` with
  `healthDetail=onebot_offline`, invalid/oversized JSON is `degraded` with
  `healthDetail=health_invalid`, and a missing/non-boolean `online` is
  `degraded` with `healthDetail=online_missing`.
- Startup readiness requires only an available HTTP health endpoint, not
  `online=true`. An offline qq-gateway can therefore start in `running` and
  remain `degraded` until the next health loop observes recovery. Health state
  never kills or restarts a process.
- Unexpected exit is recorded in `failed`. There is no automatic restart loop.
- Shutdown stops managed children in reverse order and leaves external
  processes untouched.

## DSH host

- Registers exact routes under `/xtds/api/*` with `ctx.webServer.register`.
- Validates loopback remote address, loopback Host, Origin equality and
  `Sec-Fetch-Site`.
- Ensures the supervisor is alive; if not, spawns it detached and unref'd.
  Failure is logged and returns 503, never preventing DSH startup.
- Reads the control token from local runtime config and attaches it to the
  upstream request. The browser never receives it.
- Does not stop the supervisor on plugin disposal.

## DSH client

- Loads via `window.__ModuleLoader__.load`.
- Registers one `sidebar.footer.action` entry.
- Renders the panel through a `document.body` portal so the sidebar slot's
  stacking context, clipping, and pointer-event layers cannot block controls.
- Stops click/pointer propagation at the panel boundary.
- Ships self-contained high-contrast light/dark palettes, defaults to light,
  and persists the choice in local storage.
- Polls same-origin `/xtds/api/status` every three seconds.
- Renders a fixed floating panel with status and controls. `degraded` appears
  as “等待 SnowLuma” with an amber dot; any degraded process forces the footer
  tone to busy. qq-gateway with `online=false` renders an explicit offline
  footnote.

## Autostart

- Default: current-user registry Run value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- Optional: current-user ONLOGON XML scheduled task, and a user Startup folder
  entry. The protected Startup folder rejects writes with EPERM on this
  machine, so it is not the default.
- Every backend launches `runtime/start-supervisor.cmd`. That script starts
  only the supervisor; `startServicesOnBoot` (default `false`) controls whether
  the three managed services are also started. An external instance is never
  duplicated by an autostart cycle.

## Secrets

- No secret in endpoint files, API responses, browser bundle, or docs.
- Basic redaction covers exact control token plus common token/password/Bearer
  shapes in child logs.
- Managed child stdout/stderr are buffered by complete logical line before
  writing. Lines longer than 8 MiB are discarded as a whole and replaced with
  `[REDACTED] log line exceeded 8388608 characters`; flush writes a normal
  unterminated tail but never discarded content. Each child has its own line
  session. `exit` only changes process state; the session is flushed on
  `close`, after stdout/stderr close. A descendant that keeps an inherited
  pipe open therefore retains the session, bounded by the same 8 MiB line
  limit, and its late output is still logged.
- Each service keeps one `RotatingLogWriter` across stop/start, so late output
  from an old session and output from a restarted child share one active path.
  The writer closes only on supervisor shutdown, a synchronous spawn failure
  with no child, or an external/unmanaged handoff. Closing is idempotent.
- Supervisor shutdown stops managed processes first, then waits up to 5000ms
  for open log sessions to close naturally. A normal close completes the wait
  immediately and flushes the tail. On timeout, the supervisor warns once per
  affected service with the remaining session count, then force-flushes and
  closes; output after that timeout can still be lost. The same bounded drain
  and cleanup run even if `stopAllManaged()` throws, and the original error is
  rethrown.
- Failure to create `runtime/logs` is reported through the existing log-failure
  warning path but does not block managed service startup or supervision.
- Managed child stdout/stderr logs rotate synchronously by size into immutable
  `<id>.log.<12-digit-sequence>-<13-digit-epoch-ms>-<pid>-<8-hex>.archive`
  files. The sequence is one greater than the maximum scanned from existing
  archives and is independent of the system clock. Retention sorts by sequence
  first and epoch second, so clock rollback cannot delete higher-sequence
  archives.
- Failed active renames leave the active log and existing archives in place but
  pause logging; later appends retry the rotation and resume only after it
  succeeds, so a persistent rename lock cannot grow the active file. If
  post-rotation cleanup cannot reach `logMaxFiles`, logging also pauses without
  creating or growing the active file; later appends retry cleanup first.
  Permanent deletion failure caps archives at `logMaxFiles + 1` and leaves the
  active file below `logMaxBytes` except for the existing
  single-oversized-chunk allowance. `supervisor-boot.log` is excluded.
- Service-specific secrets belong in the parent environment or an optional
  git-ignored `envFile`.
