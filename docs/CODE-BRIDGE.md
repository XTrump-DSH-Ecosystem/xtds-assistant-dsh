# Code Bridge

状态：独立包实现完成；已作为 supervisor 第 4 个受管进程接入，并通过真实
DSH/QQ 闭环（2026-11-09）。

## 目标与边界

`packages/code-bridge` 提供一条仅限本机回环的任务通道：

```text
本地调用方
  ├─ GET  http://127.0.0.1:<port>/v1/sessions
  └─ POST http://127.0.0.1:<port>/v1/tasks
       └─ code-bridge（独立 token、单实例、单执行槽）
            ├─ 枚举 DSH 会话并按会话/工作区恢复
            ├─ 新任务：allowlist 解析 repo
            ├─ git worktree add --detach <worktree>/<taskId> HEAD
            └─ dsh（固定 workspace-write 参数，恢复时加 --session-id）
```

约束：

- 只监听字面量 `127.0.0.1`，不提供 host 覆盖，不支持 `0.0.0.0`、局域网或 TLS。
- 新建 `repo` 任务使用独立 worktree；恢复会话沿用会话 cwd。两者都不 commit、
  push、merge。
- 不启动真实监听服务用于测试；测试只绑定临时端口。
- 由 supervisor 托管；token 只留在 runtime 目录，不进入浏览器或 DSH client。

## 包结构

```text
packages/code-bridge/
├─ package.json
├─ config.example.json
├─ bin/code-bridge.js
├─ lib/
│  ├─ config.js
│  ├─ constants.js
│  ├─ dsh.js
│  ├─ env.js
│  ├─ errors.js
│  ├─ fs-utils.js
│  ├─ git.js
│  ├─ manager.js
│  ├─ runtime.js
│  ├─ server.js
│  └─ service.js
├─ test/
│  ├─ bridge.test.js
│  ├─ security.test.js
│  ├─ helpers.js
│  └─ fixtures/fake-dsh.js
└─ scripts/check-syntax.js
```

## 配置

复制 `config.example.json` 到仓库外的本机路径，避免把真实路径配置提交进仓库：

```powershell
Copy-Item packages\code-bridge\config.example.json "$env:LOCALAPPDATA\DSH\code-bridge.json"
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 只允许该值；省略也固定为它 |
| `port` | `9787` | 被占用或 `EACCES` 时回退到系统临时端口 |
| `runtimeDir` | `%LOCALAPPDATA%\DSH\runtime` | token、endpoint、state 所在目录 |
| `worktreeRoot` | `E:\workspace\.code-worktrees` | 每个新任务 worktree 的父目录，也是允许根 |
| `dshSessionsDir` | `%USERPROFILE%\.dsh\storages\session_projcache\sessions` | DSH `session-*.json` 会话索引目录 |
| `dshWorkspaceRoot` | `%USERPROFILE%\Documents\deepseek-harness` | 非 repo 默认工作区根，也是允许根 |
| `workspaceRoots` | `[]` | 额外允许根数组；与 repos/worktreeRoot/dshWorkspaceRoot 一起 realpath 校验 |
| `dshCommand` | 无（必填） | DSH 可执行文件路径；Windows 通常为 `dsh.cmd` |
| `taskTimeoutMs` | `1200000`（20 分钟） | 单任务超时，允许 50 ms 到 24 小时 |
| `repos` | 无（至少一个） | 别名到本机 git 顶层目录的 allowlist 映射 |

配置路径支持 `%VAR%`、`${VAR}`、`~`，相对路径以配置文件所在目录为基准。
示例包含 `ds-memory`、`qq-gateway`、`xtds`、`xtds-assistant-dsh` 四个别名，
并固定使用当前 Windows 本机 `E:\workspace` 布局。`xtds` 映射到
`E:\workspace\xtds-boot-suite`，这是实际 git 顶层。
仓库移动或目录布局变化时，必须同步修正全部 `repos` 路径。配置中不保存 token。

校验配置但不起服务：

```powershell
node packages\code-bridge\bin\code-bridge.js --config "$env:LOCALAPPDATA\DSH\code-bridge.json" --check
```

`--check` 只读取配置、检查 DSH 命令文件并执行只读 git 顶层校验，不创建
token/endpoint、不绑定端口、不启动任务。包测试还会直接读取
`config.example.json`，检查四个示例映射均指向 git 顶层；仓库移动后该测试会
失败，直到示例同步更新。

前台运行：

```powershell
node packages\code-bridge\bin\code-bridge.js --config "$env:LOCALAPPDATA\DSH\code-bridge.json"
```

CLI 默认读取 `packages/code-bridge/config.json`；也可用
`CODE_BRIDGE_CONFIG` 或 `--config` 覆盖。正常停止用 `Ctrl+C`，停止时只在
endpoint 的 `instanceId` 与当前实例匹配时删除 endpoint。

## 运行时文件

默认目录：`%LOCALAPPDATA%\DSH\runtime`。

| 文件 | 内容 |
|---|---|
| `code-bridge.token` | 64 位小写 hex token；独立生成、复用，原子写，模式尽量设为 `0600` |
| `code-bridge.endpoint.json` | 严格只含 endpoint 字段，不含 token |
| `code-bridge.state.json` | 任务状态；queued 任务可含待执行正文 |
| `code-bridge.lock` | 原子启动锁；仅含 pid、instanceId、startedAt，不含 token |

endpoint 结构：

```json
{
  "v": 1,
  "name": "code-bridge",
  "host": "127.0.0.1",
  "port": 9787,
  "pid": 1234,
  "startedAt": 1760000000000,
  "instanceId": "uuid"
}
```

`startedAt` 是 epoch milliseconds。单实例同时使用 endpoint 存活 PID 检查和
原子 `code-bridge.lock` 启动锁；后者消除两个进程在 endpoint 写入前同时启动
的竞态。停止时以 `pid + instanceId` 双重匹配后才删除 endpoint，并在
instanceId 匹配时清理 lock。state 和 endpoint 都通过临时文件加 rename 原子替换。

启动时：

- state 中遗留的 `running` 任务改为 `failed`，`error=bridge_restarted`。
- `queued` 任务保留并继续调度；缺失任务正文时改为
  `failed`/`state_task_missing`。
- 已在 endpoint 中存活的 PID 会拒绝第二实例。

## API

### 认证

`GET /health` 不需要 token。其余路径要求：

```text
x-code-bridge-token: <token>
```

或：

```text
Authorization: Bearer <token>
```

比较使用 SHA-256 固定长度摘要加 `timingSafeEqual`。错误鉴权返回 `401`。
请求体上限 32 KiB，超过返回 `413`。

### 健康检查

```http
GET /health
```

```json
{
  "ok": true,
  "name": "code-bridge",
  "version": "0.1.0",
  "pid": 1234,
  "uptimeMs": 12345,
  "running": 1,
  "queued": 2
}
```

### 枚举会话

```http
GET /v1/sessions?q=<可选>&limit=<可选 1..20，默认 10>
x-code-bridge-token: <token>
```

```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "session-554acb97-28fd-4057-bf5a-e6e195af5d75",
      "title": "修复 bridge 会话恢复",
      "workspace": "xtds-assistant-dsh@ct-e348815c",
      "lastUsedAt": "2026-11-08T16:10:26.000Z",
      "resumable": true
    }
  ]
}
```

- 只读扫描 `dshSessionsDir` 下的 `session-<uuid>.json`，读取
  `record.identity.cwd`、`record.identity.createdAt`、
  `record.rows.title.val`、`record.rows.sessionListMetadata.val.lastPromptAt`、
  `record.rows.sessionListMetadata.val.blank`；`rows` 支持对象或数组。
- 跳过 `blank=true`、`cwd` 不存在或不在允许根内、文件损坏、文件超过
  1 MiB 的条目，不返回 500。
- `lastUsedAt` 优先取 `lastPromptAt`，缺失时回退 `createdAt`；按时间降序。
- `resumable` 来自 `record.rows.agentPreset.val`：没有非空 `agentPreset` 时为
  `true`；带桌面端命名预设的会话为 `false`。后者只能继续在 DSH 桌面端使用，
  headless 一次性运行器不能恢复。
- `q` 对 title、workspace、sessionId 做大小写不敏感子串过滤。
- `limit` 必须是 1..20；非法值返回 `400 invalid_request`。
- 按 `workspace` 解析目标时只优先选择 `resumable=true` 的会话；该工作区只有
  不可恢复会话时，回退为新建会话或 worktree。显式指定不可恢复会话时，在启动
  DSH 前返回 `409 session_preset_incompatible`。
- `workspace` 只是展示标签，绝不返回绝对路径。标签规则：
  repo 根 → `<别名>`；repo 的 git worktree → `<别名>@<ct-前8位>`；
  其余 `worktreeRoot` 下的目录 → `worktree@<ct-前8位>`；其他目录 → basename。

### 提交任务

```http
POST /v1/tasks
Content-Type: application/json
x-code-bridge-token: <token>

{"requestId":"req-001","repo":"ds-memory","task":"执行任务"}
```

也可以恢复已有会话或在指定工作区继续：

```json
{"requestId":"req-002","sessionId":"session-554acb97-28fd-4057-bf5a-e6e195af5d75","task":"继续"}
{"requestId":"req-003","session":"bridge 会话","task":"继续"}
{"requestId":"req-004","workspace":"ds-memory","task":"继续最近会话"}
{"requestId":"req-005","workspace":"ds-memory","newSession":true,"task":"新建会话"}
```

校验：

- `requestId`：1..256 个 UTF-16 code unit，不允许 Unicode 控制字符。
- `task`：1..4000 个 Unicode code point。
- `repo`：命中配置 allowlist 别名时**永远表示新建隔离 worktree 任务**；
  指定 `session`/`sessionId`/`workspace` 时可省略。
- `session`：模糊查询；匹配完整 sessionId、去掉 `session-` 的 id、8 位以上
  id 前缀、title 子串或 workspace 子串。0 个返回 `404 session_not_found`，
  多个返回 `409 session_ambiguous`。
- `sessionId`：精确匹配，优先级最高；必须符合
  `^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`，
  格式非法返回 `400 invalid_session_id`，格式合法但不存在返回
  `404 session_not_found`。
- `workspace`：先精确/子串匹配 workspace 标签或 repo 别名。repo 别名会匹配
  该 repo 的 `别名@...` worktree 会话并选 `lastUsedAt` 最新的一个；非 repo
  工作区匹配多个 workspace 时返回 `409 workspace_ambiguous`；没有会话的
  repo 别名新建 worktree，没有会话的非 repo 工作区直接在该 cwd 新建会话。
- `newSession`：boolean，默认 false；为 true 时不恢复会话。与 `session` 或
  `sessionId` 同时使用返回 `400 invalid_request`。`workspace` 精确命中 repo
  别名时仍新建隔离 worktree；只有具体 worktree 标签（`别名@ct-...`）或非 repo
  目录才会原地新建会话。
- 目标优先级：`sessionId` > `session` > `workspace` > `repo`。
- `session`/`sessionId` 与 `workspace` 同时提供时必须严格一致（标签精确相等，
  或 workspace 查询本身是 repo 别名且标签为 `别名@...`），不使用任意子串，
  否则返回 `409 session_workspace_mismatch`。
- 没有任何目标返回 `400 invalid_request`。
- 物理 repo 必须是存在目录、realpath 后仍是 git 顶层；子目录和普通目录返回
  `400 invalid_repo`。
- 恢复会话不创建 worktree，使用会话 cwd 并在启动 DSH 时传
  `--session-id <id>`；提交时会重新校验 cwd 存在且位于允许根内，否则返回
  `404 session_not_found`。

响应：

| 情况 | 状态 | 关键字段 |
|---|---|---|
| 新建 | `202` | `{ok:true,duplicate:false,task}` |
| 相同 requestId/目标/task 重试 | `200` | `{ok:true,duplicate:true,task}` |
| 相同 requestId 但内容不同 | `409` | `{ok:false,error:"request_id_conflict"}` |
| 输入非法 | `400` | `invalid_request` 或 `invalid_repo` |
| 显式 sessionId 格式非法 | `400` | `invalid_session_id` |
| 会话不存在/会话 cwd 失效 | `404` | `session_not_found` |
| 会话查询命中多个 | `409` | `session_ambiguous` |
| 工作区查询命中多个 | `409` | `workspace_ambiguous` |
| 会话与工作区不一致 | `409` | `session_workspace_mismatch` |
| 会话属于不可恢复的桌面端预设 | `409` | `session_preset_incompatible` |
| 队列满 | `429` | `{ok:false,error:"queue_full"}` |
| 鉴权失败 | `401` | `{ok:false,error:"unauthorized"}` |

并发上限为 1 个 running、5 个 queued。重复 requestId 不占队列容量。

### 查询任务

```http
GET /v1/tasks/ct-<uuid>
```

返回 `200 {ok:true,task}`；不存在返回 `404`。

任务投影严格包含：

```json
{
  "taskId": "ct-...",
  "requestId": "req-001",
  "repo": "ds-memory",
  "sessionId": null,
  "workspace": null,
  "mode": "worktree",
  "status": "succeeded",
  "worktree": "E:\\workspace\\.code-worktrees\\ct-...",
  "changedFiles": ["README.md"],
  "diffStat": {"files": 1, "insertions": 3, "deletions": 0},
  "summary": "有界结果摘要",
  "error": null,
  "timestamps": {
    "createdAt": "2026-11-08T00:00:00.000Z",
    "queuedAt": "2026-11-08T00:00:00.000Z",
    "startedAt": "2026-11-08T00:00:01.000Z",
    "finishedAt": "2026-11-08T00:00:04.000Z",
    "updatedAt": "2026-11-08T00:00:04.000Z"
  },
  "outputTruncated": false,
  "cancelRequestedAt": null
}
```

状态至少覆盖：`queued`、`running`、`succeeded`、`failed`、`canceled`、
`timed_out`。

`mode` 为 `worktree`、`resume`、`workspace`。恢复会话和非 repo 新会话的
`repo` 固定为内部标签 `dsh-session`；`sessionId`、`workspace` 在不适用的
模式下为 `null`。旧 state 缺少这三个字段时按 `null` 读取。

相同 `requestId` 的幂等检查覆盖 `taskHash`、显式 `repo`/`sessionId`/
`workspace` 以及 `newSession` 语义；`session`/`workspace` 查询形式匹配既有
任务的 `sessionId`/`workspace`。任一不一致返回 `409 request_id_conflict`。
重复 requestId 在解析会话/工作区之前直接返回既有任务，因此会话文件或工作区
目录被删除后重试仍返回 `200 duplicate`。

投影不包含：

- 任务正文或 queue 内部字段；
- token；
- 完整 stdout/stderr；
- 原始进程错误或 git 错误输出。

### 取消任务

```http
POST /v1/tasks/ct-<uuid>/cancel
```

- queued：立即进入 `canceled`，不创建 worktree。
- running：写入 `cancelRequestedAt`，杀整个进程树，随后终态为 `canceled`。
- 已终态：幂等返回当前投影。

取消请求可能先返回 running 状态的投影，调用方应轮询到终态。

## 执行语义

每个新任务（`mode=worktree`）：

1. 从 allowlist 解析 repo，校验 realpath 和 git 顶层。
2. 以安全 ID `ct-<uuid>` 在 worktreeRoot 下创建目标。
3. 执行只读的 `git worktree add --detach <path> HEAD`。
4. 校验 worktree realpath 仍位于 worktreeRoot 内、且自身是 git 顶层。
5. 以 worktree 为 cwd 启动 DSH。
6. 结束后用 worktree 内的只读 `git status` / `git diff HEAD` 生成
   `changedFiles` 和 `diffStat`。

恢复会话（`mode=resume`）不创建 worktree，直接以会话 cwd 启动 DSH，并传
`--session-id`。在非 repo 工作区新建会话（`mode=workspace`）同样不创建
worktree，直接在该 cwd 启动 DSH。恢复和新会话结束后仍用该 cwd 的只读 git
查询生成 `changedFiles`/`diffStat`；非 git 目录返回空结果。

DSH 基础参数固定为：

```text
--profile headless --json --permission-mode workspace-write --approval-policy never
```

恢复会话时追加：

```text
--session-id session-<uuid>
```

sessionId 必须匹配
`^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`；
不合法时任务稳定失败为 `invalid_session_id`，且绝不会拼入 `.cmd` 命令行。

不使用 `danger-full-access`，也没有放宽权限的配置项。

worktree 默认保留供检查，不会自动删除。清理是显式人工操作，不能由 bridge
自动执行，以免误删仍需要的任务产物。`changedFiles` 最多 200 项，路径相对于
worktree。`diffStat` 统计相对 `HEAD` 的已跟踪变更；未跟踪新文件会出现在
`changedFiles`，但不计入 `diffStat` 行数。

## Windows `.cmd` 安全取舍

Node 的 `child_process.spawn(..., {shell:false})` 不能直接执行 `.cmd` / `.bat`。
本包不使用 `shell:true`，因为那会把任务文本和命令拼接成 shell 字符串。

实现方式：

- `.cmd` / `.bat`：通过 `cmd.exe /d /s /c` 执行一条**静态**命令行，只含经过
  校验的命令路径、固定 DSH 参数、经严格 regex 校验的 `--session-id` 值和
  `-`。任务文本从 stdin 传入，绝不进入 shell 命令行。命令路径包含 `"`、
  `%`、`!`、`&`、`|`、`<`、`>`、`^` 等 cmd 元字符时拒绝执行。
- `.exe`：`shell:false` 直接 spawn，任务作为独立 argv 项传递。
- 两种模式都不经过 shell，也不把 bridge token 放入子进程环境。

`.exe` 模式下任务会出现在本机进程命令行中，这是 DSH CLI argv 模式的取舍；
进程命令行仅对本机用户可见。`.cmd` 模式使用 stdin，不在命令行暴露任务。

## 环境与输出

子进程环境从父环境过滤，包含 `qq`、`gateway`、`token`、`secret`、
`password`、`api_key`、`authorization`、`auth`、`credential`、`cookie`
等名称的变量全部剥离。bridge token 不会通过环境传递。

输出限制：

- stdout、stderr 各保留最多 64 KiB 尾部；
- 超过限制时 `outputTruncated=true`，原始输出不返回；
- 成功 summary 优先取 NDJSON 最后一个 `result`，其次 `summary`、`text`、
  `message`；
- 无 JSON 摘要时取有界 stdout 尾部；
- summary 最多 4000 个 Unicode code point；
- summary 中的 bridge token 替换为 `[REDACTED]`，完整任务原文替换为
  `[REDACTED_TASK]`；
- 失败任务不返回 stdout/stderr，只返回稳定短码。

稳定错误码示例：

- `dsh_exit_code_7`
- `dsh_timeout`
- `dsh_spawn_failed`
- `unsafe_dsh_command`
- `session_preset_incompatible`
- `session_subagent`
- `session_invalid`
- `session_cwd_mismatch`
- `permission_preset_invalid`
- `worktree_create_failed`
- `bridge_restarted`
- `bridge_shutdown`
- `internal_error`

超时、取消和正常停止都会在 Windows 上通过
`taskkill.exe /PID <pid> /T /F` 终止整棵进程树。

## 安全边界

- 只面向本机单用户，无 TLS；本机其他同权限进程仍可读取 runtime token。
- repo 只能来自配置 allowlist；请求不能提交任意文件系统路径。
- 会话 cwd 只能来自 `dshSessionsDir` 中的索引，且必须 realpath 后位于
  repos、worktreeRoot、dshWorkspaceRoot 或 workspaceRoots 内；`..` 和
  junction/symlink 逃逸会被跳过。
- 工作树路径经过 realpath、相对边界和 junction/symlink 检查。
- 不把任务正文写入 API 响应或日志；state 中 queued 正文是必要的持久化例外。
- 不记录完整 stdout/stderr，不把 DSH/git 原始错误返回给调用方。
- 不 commit、push、merge，不修改主工作区文件。
- 任务执行权限为 DSH `workspace-write`，不是强安全沙箱；DSH 自身行为仍需
  由调用方和 allowlist 约束。

## 测试与验证

测试使用：

- `mkdtemp` 下的真实临时 git 仓库（含 baseline 和 empty commit）；
- 临时 fake `.cmd`，其路径包含空格，用于验证 Windows 引号路径；
- fake DSH 通过 stdin 接收任务，并用子进程验证 `taskkill /T`；
- 随机临时端口，不启动常驻服务。

必须命令与结果：

```text
npm --prefix packages/code-bridge test
33 tests, 33 pass

npm --prefix packages/code-bridge run check
node --check: 19 files OK
```

覆盖：

- 成功、失败、超时、取消、取消幂等；
- sessions 枚举/过滤/limit/鉴权、blank/损坏/超大/越界跳过、workspace 标签；
- 按 session 恢复（断言 `--session-id` 与 cwd、不创建 worktree）、按 workspace
  选最近会话、repo 别名匹配 worktree 会话、空工作区原地新建；
- session_not_found、session_ambiguous、workspace_ambiguous、
  session_workspace_mismatch、newSession 冲突、旧 state 兼容、requestId 冲突；
- sessionId 正则拒绝与 `.cmd`/`.exe` 参数构造；
- requestId 重复与内容冲突；
- requestId/task/body 边界和非法 repo；
- 1 running + 5 queued 上限；
- token、Bearer、401、endpoint 不含 token；
- endpoint 回环、PID 单实例、原子启动锁、instanceId 归属删除；
- 端口占用回退；
- stdout/stderr 上限、截断标记、NDJSON summary、纯文本尾部；
- 任务正文不进入响应、state（终态）或 endpoint；
- 主工作区未变、worktree 独立、junction 逃逸拒绝；
- 敏感环境变量剥离；
- `.cmd` 任务仅走 stdin，`.exe` 参数构造，不使用危险权限。

尚未执行的真实环境项：

- 未调用真实 DSH/DeepSeek API。
- 未启动真实常驻监听服务。
- `EACCES` 回退分支已实现，但 Windows 非管理员环境无法稳定构造该错误，测试
  只覆盖了 `EADDRINUSE` 回退。
- `.exe` 分支只做参数构造单元测试，未提供真实 fake `.exe`。
- CLI 的 Windows 控制台信号退出路径未做独立进程级验收；服务对象停止、
  endpoint 清理和任务终止已在进程内测试。

剩余风险：

- 强制杀死 bridge 本身不会执行正常清理，可能留下 DSH 子进程或 worktree；
  正常超时、取消和 `stop()` 会杀进程树。
- endpoint/lock 使用 PID 存活判断；操作系统快速复用 PID 时可能保守拒绝启动，
  需要人工确认后删除 stale 文件。
- worktree 默认不自动清理，长期运行会占用磁盘。
- 回环 HTTP 无 TLS；同一 Windows 用户下能读取 runtime 目录的进程也能读取
  token，这是本机单用户信任模型的一部分。

## supervisor 集成

2026-11-09 已接入：

- `config/supervisor.json` 将 `code-bridge` 作为第 4 个受管进程，首选端口
  `9787`，endpoint 为 `%LOCALAPPDATA%\DSH\runtime\code-bridge.endpoint.json`。
- 本机配置为 `config/code-bridge.json`；`dshCommand` 指向 DSH CLI，
  `repos` 覆盖四个仓库，`worktreeRoot` 位于
  `E:\workspace\.code-worktrees`。
- supervisor 只负责进程生命周期和健康检查，不读取、不复制 bridge token。
- DSH 插件 0.1.0 增加 `code-bridge` 的 start/stop/restart 路由；面板按
  supervisor 返回的进程列表动态渲染第 4 张卡片。
- headless profile 的账号凭据补丁保存在
  `ops/dsh-headless-account.patch.yml`；DSH 升级覆盖 profile 后可据此恢复。
- 真实闭环：direct bridge 任务 `ct-bba0a55a-4749-4c65-aeff-66c4135a4b50`
  返回 `bridge-direct-ok`；ds-memory `code` 命令任务
  `ct-e1add584-3b76-44ac-af85-83ed8f39c33e` 返回 `ds-memory-code-ok`，
  即时回执与终态通知均为 `all_sent`。

仍需人工运维的部分：worktree 不自动清理；bridge 被强杀时可能留下 DSH 子进程。
