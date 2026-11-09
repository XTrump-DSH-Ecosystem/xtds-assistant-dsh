# Acceptance Record

Date: 2026-11-05 (Asia/Shanghai)

Final state:

- Supervisor: PID 38456, `127.0.0.1:986`, version 0.1.0, started through the
  real `runtime/start-supervisor.cmd` boot path.
- ds-memory: `managed`, port 985, health `healthy` (PID sample `32064`; PIDs
  change on restart).
- qq-gateway: `managed`, port 803, health `healthy` and online as self QQ
  `10003` (PID sample `24656`).
- Autostart: registry backend selected and enabled. The Run value points to
  `runtime/start-supervisor.cmd`; `startServicesOnBoot` remains `false`.

## Automated

Commands:

```powershell
npm run check
npm test
node packages/supervisor/bin/supervisor.js --config config/supervisor.json --check
node packages/supervisor/bin/supervisor.js --config config/supervisor.json --selftest
npm run pack:plugin
```

Results:

- `node --check`: 21 files passed.
- Supervisor tests: 14/14 passed.
- DSH plugin tests: 2/2 passed.
- Config inspection: exit 0; both real service paths and working directories
  resolve.
- Selftest: exit 0.
- Packaging: `dist/xtds-assistant-dsh-0.1.1.tgz` produced.

Supervisor coverage includes:

- missing/wrong control token -> 401
- duplicate supervisor -> exit code 3
- startup order with two dummy Node services
- independent start/stop and PID-changing restart
- `startServicesOnBoot` skips an external service and starts the remaining one
- start failure and simulated crash -> `failed`; spawn count remains 1
- external instance -> `external`; stop -> 409; external PID stays alive
- external instance plus `--start-services` -> no duplicate spawn, including
  when `LOCALAPPDATA` is absent and resolved from `USERPROFILE`
- endpoint removal on shutdown and token redaction in child logs
- generated start script does not force `--start-services`
- Startup, ONLOGON XML task, and current-user registry Run autostart backends
  create/query/delete in temporary locations

DSH plugin coverage includes eight exact route registrations, origin fencing,
token forwarding, client bundle loading through `__ModuleLoader__`, and footer
action registration.

## Managed takeover validation

On 2026-11-05 the user explicitly authorized a controlled takeover of the two
real services. SnowLuma was not started, stopped, or modified.

- Preconditions: ds-memory `inbox.pending=0`, `inbox.busy=0`; old supervisor
  PID 38336; external ds-memory PID 24948 and qq-gateway PID 14052.
- The old supervisor was shut down through `/api/shutdown`; the two external
  services were then stopped and their ports 985/803 were confirmed released.
- `config/qq-gateway.env` was generated from the existing ds-memory hook token
  and SnowLuma WS 3001 access token. The file is gitignored, its ACL is
  restricted to the current user, SYSTEM, and Administrators, and no secret was
  printed in reports.
- The supervisor started both services through its control API. Initial managed
  PIDs were 9236 and 41720, both with parent PID 42136. The user then exercised
  the Desktop panel controls; the post-acceptance PID sample is 29704/39984 and
  both remain managed.
- qq-gateway was restarted through the supervisor API: PID changed from 43296
  to 41720, health returned online, and no QQ message was sent by the test.
- Final checks: both services healthy, ds-memory `inbox.pending=0` and
  `inbox.busy=0`, SnowLuma PID 32332 still alive, 11 log files scanned with
  zero exact token matches.
- No live model reply was generated during this takeover. The previously
  accepted real QQ roundtrip remains the functional baseline.

## Boot and autostart validation

The user's explicit boot policy is: start the supervisor automatically, but do
not automatically start the two services.

- `config/supervisor.json` has `startServicesOnBoot=false`.
- The generated `runtime/start-supervisor.cmd` contains no
  `--start-services` flag.
- The old supervisor was shut down, then the supervisor was launched through
  that exact script. Supervisor PID 38456 reached `127.0.0.1:986` while both
  ds-memory and qq-gateway remained `stopped`.
- The autostart API was re-applied and the real registry value was queried
  directly:
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\XTDS-Assistant` points to
  `cmd.exe /d /c ""...\runtime\start-supervisor.cmd""`.
- The two services were then started manually through the supervisor API and
  returned to healthy managed state; SnowLuma remained running throughout.
- This validates the boot script and registry entry without logging the user
  off. An actual Windows logoff/logon cycle remains unverified.

## Incident and cleanup

At approximately 02:39-02:41, a leftover scheduled task
`XTDS-Assistant-Launch2` launched this project's
`runtime/start-supervisor.cmd`. The script forced `--start-services`, so the
supervisor attempted managed starts even though the real services were already
running. Both attempts failed safely:

- ds-memory reported "已有 ds-memory 实例在运行".
- qq-gateway reported `MISSING_SECRET`.

PIDs 24948 and 14052 were not stopped or replaced. The unexpected supervisors
were shut down through `/api/shutdown`. The project-owned scheduled task and
two leftover Startup `.tmp` files were removed. Final queries confirm no
`XTDS-*` task, registry Run value, or Startup entry.

Root causes and fixes:

- The generated autostart script ignored `startServicesOnBoot` and always
  passed `--start-services`. The flag was removed; service startup now follows
  the config flag, currently `false`.
- `%LOCALAPPDATA%` and `%APPDATA%` could remain unresolved when a task launcher
  omitted those variables. Path expansion now derives them from
  `USERPROFILE`, with case-insensitive variable lookup.
- Atomic writes left temporary files when rename failed. The temporary path is
  now removed in a `finally` block.
- A regression test starts both services externally, removes `LOCALAPPDATA`
  from the supervisor environment, launches with `--start-services`, and
  verifies both are detected as `external` with exactly one spawn each.

## DSH packaging and profile

- Latest artifact: `dist/xtds-assistant-dsh-0.1.1.tgz`, 8,814 bytes,
  SHA-256 `765402B224E415E8FD7058A72D72B85961029B197E1CB5B1F1DC4C1385A11405`.
- The plugin was removed and re-added to the isolated `xtds-test` profile from
  the newly packed tarball.
- `dsh --profile xtds-test --host 127.0.0.1 --port 3199 --no-open` started.
- `GET /xtds/api/status` returned 200 with both services healthy. This check
  was performed while the services were still external; the later managed
  takeover is recorded above.
- A request with `Origin: https://example.com` returned 403.
- The test DSH process was stopped; the supervisor remained alive on 986. The
  supervisor used for that packaging check was PID 38336.
- A separate headless Edge session loaded the test profile at 3199 and verified:
  - the panel's DOM parent is `BODY`;
  - the light theme is readable and the default;
  - the theme button switches to dark, persists `dark` in local storage, and
    switches back to light;
  - the close button removes the panel;
  - no page or console errors were reported.

The `desktop` profile was updated from plugin `0.1.0` to `0.1.1`; DSH Desktop
must be restarted before the new client bundle is loaded.

## 2026-11-08 desktop profile link repair

- The desktop profile still declared `xtds-boot-suite` with a link target of
  `E:/workspace/xtds-boot-suite/dsh-boot-suite`, which does not
  exist. The actual package is `xtds-start-dsh` at the repository root.
- `package.json` was backed up, the dependency and bundle entry were renamed
  to `xtds-start-dsh`, and `dsh plugin --profile desktop install` recreated the
  junction.
- A hidden DSH Desktop launch loaded the profile successfully. The plugin route
  `GET /xtds/api/status` returned 200, with ds-memory, qq-gateway, and
  open-websearch present. The temporary DSH process was then closed; the
  supervisor and its managed services were not stopped.
- `xtds-assistant-dsh` `0.1.4` is installed in the desktop profile.

## Not verified

- Actual logout/login execution of the registry, scheduled-task, or Startup
  autostart paths.
- A new live QQ/model roundtrip after takeover was not part of that validation;
  the 2026-11-09 code-bridge section records the later real roundtrip.

## 2026-11-09 code-bridge integration

- `config/supervisor.json` now manages four processes. After a graceful
  supervisor restart, ds-memory, qq-gateway, open-websearch, and code-bridge
  all reported `running/healthy`; qq-gateway reported `online=true`.
- Plugin `xtds-assistant-dsh@0.1.5` was packed and installed into the desktop
  profile. Artifact: `dist/xtds-assistant-dsh-0.1.5.tgz`, 11,234 bytes,
  SHA-256 `BCB4BAB576F26DB804DBA028A280D71D937DD2917BBE48ABB23B9CFB0797C876`.
  The package adds the three `code-bridge` panel routes.
- The machine-local headless DSH profile was changed to
  `provider: deepseek-account`; `authorization`, `deepseek-account`, and
  `credentials` are re-enabled with `desktopPlatform: win32`. Original patch
  backup: `cordis.patch.yml.bak-xtds-code-bridge`.
- Direct bridge task `ct-bba0a55a-4749-4c65-aeff-66c4135a4b50` succeeded with
  summary `bridge-direct-ok`; `changedFiles=[]`, diff `0/+0/-0`.
- Owner-private hook event `evt:10003:message:e2e-code-1794155786080`
  produced bridge task `ct-e1add584-3b76-44ac-af85-83ed8f39c33e`, status
  `succeeded`, summary `ds-memory-code-ok`, `notificationStatus=sent`.
  Gateway logs show the immediate reply and the proactive terminal message both
  as `outcome=all_sent` to the owner private chat.
- Verification: plugin tests 21/21; code-bridge tests 20/20 in a non-sandboxed
  run (including real process-tree timeout and cancel); code-bridge security
  tests 10/10; `code-bridge --check` and `supervisor --check` pass.
- Residual risk: a DSH upgrade may rewrite the headless profile and require the
  patch to be re-applied. Expired desktop account grants require a DSH
  re-login. Worktrees are not garbage-collected automatically, and force-killing
  the bridge itself can leave a DSH child process behind.

## 2026-11-09 code-bridge session/workspace finalization

- `code-bridge` now covers DSH session enumeration, bounded filtering, safe
  workspace labels, resume-by-session, workspace continuation, ambiguous-target
  rejection, redaction, and restart compatibility. The full package suite is
  **35/35 passing**, including real process-tree timeout and cancel coverage.
- Root `npm test` now includes `test:code-bridge`; the complete XTDS run is
  supervisor **77/77**, plugin **21/21**, open-websearch **44/44**, and
  code-bridge **35/35**.
- ds-memory: typecheck clean, **53 files / 1054 passed, 1 skipped**, contract
  **26/26**. qq-gateway: typecheck clean, **25 files / 305 passed**, contract
  **26/26**.
- No commit or push was performed.
