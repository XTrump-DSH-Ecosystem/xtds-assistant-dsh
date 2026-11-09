# open-websearch launcher

`packages/open-websearch` is the launcher for the fixed
`open-websearch@2.2.0` installation. It owns only the daemon process it starts.
The repository's `config/supervisor.json` manages this launcher as the third
service (`open-websearch`); it does not touch SnowLuma, ds-memory, qq-gateway,
or Windows service registration. Manual invocation remains supported.

## Install assumption

- Package: `open-websearch@2.2.0`
- Default install root: `E:\DSH-Services\open-websearch\2.2.0`
- Default entry point:
  `E:\DSH-Services\open-websearch\2.2.0\node_modules\open-websearch\build\index.js`

The launcher reads `<package root>/package.json` and fails before spawning if the
package name is not `open-websearch` or the version is not `2.2.0`.

## Usage

```powershell
node packages/open-websearch/bin/launcher.js
```

Options:

```text
--install-dir <path>       Override the 2.2.0 install root
--entry <path>             Override build/index.js (tests or isolated installs)
--runtime-dir <path>       Override %LOCALAPPDATA%\DSH\runtime
--startup-timeout-ms <n>   Port announcement timeout (default 30000)
--status-timeout-ms <n>    /status identity timeout (default 8000)
--verbose                  Forward child stdout/stderr for diagnostics
--help, -h                 Show help
```

`OPEN_WEBSEARCH_HOME` may be used instead of `--install-dir`. Start the launcher
with a hidden/non-interactive console when it is run from a task or tray helper;
do not register it as a system service and do not change `PATH`.

Exit codes:

- `0` — daemon exited or the launcher stopped after a signal
- `1` — startup, identity, or lifecycle failure
- `2` — invalid launcher arguments
- `3` — another launcher or a live daemon already exists

## Startup flow

1. Resolve the install root, entry point, and runtime directory.
2. Acquire the exclusive `open-websearch.lock`.
3. Inspect `open-websearch.endpoint.json`:
   - live, valid endpoint -> fail closed (exit `3`), leave the file untouched;
   - live pid with invalid identity/version -> fail closed (exit `1`);
   - dead pid or invalid JSON -> remove the stale file and continue.
4. Validate that the installed package is `open-websearch@2.2.0`.
5. Spawn:
   `node <entry> serve --host 127.0.0.1 --port 0`
6. Parse stdout for the announcement emitted after `listen()`:
   `Local open-websearch daemon running at http://127.0.0.1:<actual-port>`
7. Query `http://127.0.0.1:<actual-port>/status` and require:
   - `daemon=running`
   - `runtime=ready`
   - `activation=active`
   - `version=2.2.0`
   - `capabilities` includes `search` and `fetch-web`
   - `baseUrl` exactly equals the announced base URL
   - `configSummary.useProxy=false`
   - `configSummary.fetchWebAllowInsecureTls=false`
8. Write the endpoint atomically (same-directory temp file, `fsync`, rename).
9. Stay in the foreground until the child exits or the launcher receives
   `SIGINT`/`SIGTERM`/`SIGBREAK`.

The launcher never falls back to port 3210. It always passes `--port 0`, removes
`OPEN_WEBSEARCH_DAEMON_PORT` and `OPEN_WEBSEARCH_DAEMON_URL` from the child
environment, and fails if no announcement is observed.

## Endpoint file

Path: `%LOCALAPPDATA%\DSH\runtime\open-websearch.endpoint.json`

```json
{
  "v": 1,
  "name": "open-websearch",
  "host": "127.0.0.1",
  "port": 49152,
  "pid": 12345,
  "instanceId": "f6b1a3c8-...",
  "startedAt": "2026-11-08T03:00:00.000Z",
  "version": "2.2.0",
  "baseUrl": "http://127.0.0.1:49152"
}
```

- `pid` is the open-websearch child process, not the launcher process.
- The file contains no token, API key, password, or other credential.
- Writers reject endpoint objects with sensitive key names.
- Readers should still treat the endpoint as untrusted input and repeat the
  `/status` identity checks before using the daemon.

## Lock and stale handling

- Lock path: `%LOCALAPPDATA%\DSH\runtime\open-websearch.lock`
- The lock is created with exclusive-create semantics and records launcher
  `pid`, `instanceId`, and `createdAt`.
- A live valid lock or a live incompatible lock fails closed with exit `3`.
- A lock with a dead pid or invalid JSON is replaced.
- Endpoint and lock cleanup only removes files that still match the launcher's
  own `pid`/`instanceId`, so a successor's files are never deleted.

## Cleanup

- Child exit: remove the owned endpoint, release the lock, exit with the child
  code.
- Startup failure: terminate the child, remove any owned endpoint, release the
  lock, exit `1`.
- Signal: remove the endpoint first, terminate the child, release the lock, exit
  `0`.
- A forcibly killed launcher can leave a stale endpoint/lock. The next start
  detects the dead pid and replaces it.

## Tests

```powershell
npm --prefix packages/open-websearch test
```

Equivalent direct invocation from the package directory:

```powershell
cd packages/open-websearch
node --test test/*.test.js
```

The suite uses a fake `open-websearch serve` CLI with a real loopback status
server and covers:

- dynamic `--port 0` invocation and announced-port publication;
- atomic endpoint replacement with a concurrent cross-process reader;
- endpoint shape, no-token invariant, and stale/invalid endpoint replacement;
- exclusive lock, live-lock refusal, stale-lock replacement;
- package name/version mismatch fail-closed before spawn;
- `/status` version, identity, base URL, capabilities, proxy, and TLS mismatch
  fail-closed;
- no announcement, zero announced port, child exit before announcement;
- endpoint and lock cleanup on child exit;
- absence of any 3210 fallback.

## Security notes

- No new dependencies; Node built-ins only.
- No global install, `PATH` change, or Windows service registration.
- The daemon binds `127.0.0.1` only; the endpoint is local trust boundary data.
- The launcher does not print `/status` body fields such as
  `playwrightUnavailableReason`. `--verbose` is opt-in and may include local
  paths from child diagnostics.
- The launcher enforces the `/status`-visible `useProxy=false` and
  `fetchWebAllowInsecureTls=false` invariants. `ENABLE_CORS=false` and an empty
  `FAKE_IP_CIDRS` are not exposed by `/status`; the daemon environment must keep
  those secure for ds-memory to enable `web_fetch`.
- The launcher is wired into `packages/supervisor` as `open-websearch`.
  Supervisor uses `endpointPid: "any"` because the launcher publishes the
  endpoint from its daemon child; the endpoint name must still match the
  service id.

## Residual risks

- The lock's stale-break is best-effort; a simultaneous manual start during
  stale-lock recovery can still race.
- PID reuse can make a dead owner look alive; the launcher then fails closed
  instead of replacing the file.
- Windows forced termination does not run signal cleanup. Stale-file recovery on
  the next start is the fallback.
- The supervisor has no automatic crash-restart loop. If the daemon crashes,
  the launcher exits and the service is shown as `failed` until the operator
  starts it again from the panel.
