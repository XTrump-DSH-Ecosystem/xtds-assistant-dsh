# XTDS Assistant DSH

Windows 本机 MVP：独立后台 `supervisor` 持有 `ds-memory`、`qq-gateway`、
`open-websearch` 与 `code-bridge`，
DSH 插件只做状态展示和遥控，不持有子进程。关闭 DSH 不会停止 supervisor。

## 相关仓库

- [ds-memory](https://github.com/XTrump-DSH-Ecosystem/ds-memory)：QQ 脑侧、记忆、权限与回复生成；
  跨项目接口的权威副本是该仓库的
  [`docs/CONTRACT.md`](https://github.com/XTrump-DSH-Ecosystem/ds-memory/blob/main/docs/CONTRACT.md)。
- [qq-gateway](https://github.com/XTrump-DSH-Ecosystem/qq-gateway)：SnowLuma OneBot v11 薄网关。
- [XTrump-DSH-Ecosystem](https://github.com/XTrump-DSH-Ecosystem)：组织主页。

## 当前形态

```text
xtds-assistant-dsh/
├─ packages/supervisor/      零运行期依赖的 Node 后台
├─ packages/dsh-plugin/      DSH host + client 插件（包名 xtds-assistant-dsh）
├─ config/supervisor.json    实际配置（真实路径，无 token）
├─ config/snowluma.json      SnowLuma home，用于只读发现 Web UI 端口
├─ runtime/                  自动生成：endpoint、token、日志
├─ docs/                     架构与验收记录
└─ dist/                     npm pack 产物
```

适配层不单开仓库：`packages/dsh-plugin` 已经把 DSH host/client 适配隔离成
独立包，后续只有在需要独立版本节奏或独立发布责任时，才值得拆成另一个仓库。

数据面：

```text
DSH Web UI
  └─ 同源 /xtds/api/*
       └─ DSH host 插件：校验回环 + Origin，附加 control token
            └─ 127.0.0.1:986 supervisor（端口被占用时回退系统端口）
                 ├─ ds-memory
                 ├─ qq-gateway
                 ├─ open-websearch
                 └─ code-bridge
```

## 环境

- Windows 10/11，Node.js 24+
- DSH `0.2.1-rc.5`
- 本项目默认路径：`E:\workspace\xtds-assistant-dsh`
- DSH CLI：`E:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd`

## 开发运行

检查配置：

```powershell
cd E:\workspace\xtds-assistant-dsh
node packages/supervisor/bin/supervisor.js --config config/supervisor.json --check
```

前台启动 supervisor：

```powershell
node packages/supervisor/bin/supervisor.js --config config/supervisor.json
```

正常启动时，supervisor：

1. 只监听 `127.0.0.1`，首选 `986`；占用时回退系统分配端口。
2. 生成 `runtime/config.json`（control token）和
   `runtime/supervisor.endpoint.json`（不含 token）。
3. 读取 DSH runtime 下的
   `ds-memory.endpoint.json` / `qq-gateway.endpoint.json` /
   `open-websearch.endpoint.json` / `code-bridge.endpoint.json`。
   PID 存活则标记为 `external`，绝不重复启动。

手动查看状态（token 只在本机读取，不粘贴到浏览器）：

```powershell
$endpoint = Get-Content runtime\supervisor.endpoint.json -Raw | ConvertFrom-Json
$token = (Get-Content runtime\config.json -Raw | ConvertFrom-Json).controlToken
Invoke-RestMethod "http://127.0.0.1:$($endpoint.port)/api/status" -Headers @{ "x-xtds-token" = $token }
```

关闭 supervisor（会停止它自己启动的受管子进程；不会碰 `external` 实例）：

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:$($endpoint.port)/api/shutdown" -Headers @{ "x-xtds-token" = $token }
```

## API

所有 `/api/*` 都需要 `x-xtds-token` 请求头（或 `Authorization: Bearer`）：

| 方法 | 路径 |
|---|---|
| `GET` | `/api/status` |
| `POST` | `/api/processes/ds-memory/start` |
| `POST` | `/api/processes/ds-memory/stop` |
| `POST` | `/api/processes/ds-memory/restart` |
| `POST` | `/api/processes/qq-gateway/start` |
| `POST` | `/api/processes/qq-gateway/stop` |
| `POST` | `/api/processes/qq-gateway/restart` |
| `POST` | `/api/processes/open-websearch/start` |
| `POST` | `/api/processes/open-websearch/stop` |
| `POST` | `/api/processes/open-websearch/restart` |
| `POST` | `/api/processes/code-bridge/start` |
| `POST` | `/api/processes/code-bridge/stop` |
| `POST` | `/api/processes/code-bridge/restart` |
| `GET` | `/api/autostart` |
| `PUT` | `/api/autostart`，body `{"enabled":true|false}` |
| `POST` | `/api/shutdown` |

`external` 进程的 stop/restart 返回 `409`，必须在原终端手动处理。

## 构建并验证插件

```powershell
cd E:\workspace\xtds-assistant-dsh
npm run check
npm test
npm run pack:plugin
```

产物：`dist/xtds-assistant-dsh-0.1.0.tgz`。

安装到独立测试 profile：

```powershell
& 'E:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd' plugin --profile xtds-test add file:E:\workspace\xtds-assistant-dsh\dist\xtds-assistant-dsh-0.1.0.tgz
```

启动测试 Web（不要与正在使用的 Desktop 实例混用端口）：

```powershell
& 'E:\DeepseekHarness\resources\runtime\cli\bin\dsh.cmd' --profile xtds-test --host 127.0.0.1 --port 3199 --no-open
```

已验证 `GET http://127.0.0.1:3199/xtds/api/status` 返回 200，错误 Origin 返回 403。

## 安装到 DSH Desktop

本次发布基线为 `0.1.0`。2026-11-08 同时修复了旧的
`xtds-boot-suite` 坏链：依赖与 bundle 名已统一为实际包名 `xtds-start-dsh`，
并验证 DSH 桌面端能加载 `/xtds/api/status`。后续安装或升级优先走 DSH 的
“插件 → 添加插件 → 安装第三方插件”，输入本地
`dist\xtds-assistant-dsh-0.1.0.tgz` 的绝对路径。如果当前版本的管理器不接受本地
tgz，再发布到 npm 或 GitHub Release 后用包名安装。

插件加载后：

- host 自动确保 supervisor 启动；启动失败只写日志，不影响 DSH。
- 侧栏 footer 出现带状态圆点的“XTDS 助手”按钮。
- 面板通过 `document.body` portal 渲染，不受侧栏插槽层级和事件遮挡影响。
- 面板显示三个进程的 state、PID、端口、uptime、health；`degraded` 显示
  “等待 SnowLuma”并使用琥珀色状态点。任一进程 degraded 时底部总状态为 busy，
  不会误显示全绿。qq-gateway 的 `online=false` 会显示
  “QQ 链路离线：SnowLuma 未运行或未连接”。
- qq-gateway 卡片另有一行 `SnowLuma Web UI`：回环 host 显示 `host:port` 和
  `打开设置`；非回环 host 只显示地址并提示不可直接打开；未发现端口时显示
  `未发现 SnowLuma 端口`。该信息只读，不改变 SnowLuma 生命周期。
- 面板提供启动/停止/重启和“开机自启”开关。
- 面板自带亮色/暗色切换，选择保存在本机浏览器；默认亮色。
- 浏览器只访问同源 `/xtds/api/*`，永远拿不到 control token。

如果仓库移动位置，给 DSH 进程设置环境变量：

```text
XTDS_ASSISTANT_HOME=E:\path\to\xtds-assistant-dsh
```

也可用 `XTDS_SUPERVISOR_CONFIG` 指定单独的 supervisor 配置。

## 开机自启

默认后端是当前用户注册表 Run 项，不需要管理员权限：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
值名：XTDS-Assistant
```

开关 API 会写入/删除该值，值只调用 `runtime/start-supervisor.cmd`。当前已启用。
自启脚本只启动 supervisor，不会强制启动四个服务；是否启动服务由
`startServicesOnBoot` 控制，当前配置为 `false`，这是本机明确采用的策略。

也可把配置改成 `"autostartBackend": "schtasks"`（当前用户 ONLOGON XML 计划任务）
或 `"startup"`（用户 Startup 文件夹）。本机受保护 Startup 目录写入返回 EPERM，
因此只作为显式回退。三种后端都由 `GET/PUT /api/autostart` 控制。

## 进程配置

`config/supervisor.json` 已包含真实路径。首次使用前确认：

- `ds-memory.cwd` / `qq-gateway.cwd` / `open-websearch.cwd` / `code-bridge.cwd`
- `nodePath`（默认 `C:\Program Files\nodejs\node.exe`）
- `serviceRuntimeDir`（默认 `%LOCALAPPDATA%\DSH\runtime`）
- `preferredPort`（985 / 803；0 表示只依赖 endpoint）
- `healthRequireOnline`（每服务健康检查是否要求 `online=true`，默认 `false`；
  qq-gateway 显式设为 `true`）
- `endpointPid`（默认 `self`；open-websearch 使用 `any`，因为 launcher 由子进程发布 endpoint）
- `config/code-bridge.json`（本机 repo allowlist、`dshCommand`、worktree 根目录）
- 本机 code-bridge 的 `runtimeDir` 固定为
  `runtime/code-bridge`，endpoint/token/state 都由 supervisor 与 ds-memory
  共享这一目录；避免 Codex 宿主与 supervisor 子进程对
  `%LOCALAPPDATA%\DSH\runtime` 产生不同文件视图
- `logMaxBytes` / `logMaxFiles`（默认 `5242880` 字节 / `5` 个归档；允许范围
  1024..1073741824 字节、1..50 个归档）

`ds-memory` 自己读取其项目 `.env`。`qq-gateway` 需要
`QQ_GATEWAY_ONEBOT_TOKEN` 与 `QQ_GATEWAY_MEMORY_TOKEN`：

1. 让 DSH/supervisor 的父进程环境包含它们；或
2. 把 `config/qq-gateway.env.example` 复制为 `config/qq-gateway.env`，填入值，
   再给 qq-gateway 配置加 `"envFile": "config/qq-gateway.env"`。

该文件已被 `.gitignore` 忽略。缺少环境变量时 qq-gateway 会进入 `failed`，
日志在 `runtime/logs/qq-gateway.log`，不会无限重启。

## 健康检查

supervisor 对每个服务的 `healthPath` 发起 HTTP GET，最多读取 64 KiB 响应体并
尝试解析 JSON。响应体原文不会写入日志或 status 响应。

- HTTP 失败：`health=unhealthy`，`online=null`。
- HTTP 成功且 `healthRequireOnline=false`：`health=healthy`；响应含布尔
  `online` 时同步该字段。
- HTTP 成功且 `healthRequireOnline=true`、`online=true`：`health=healthy`。
- HTTP 成功且 `healthRequireOnline=true`、`online=false`：
  `health=degraded`，`healthDetail=onebot_offline`。
- 要求 online 时，JSON 无效或超过 64 KiB：`health=degraded`，
  `healthDetail=health_invalid`；JSON 有效但缺少布尔 `online`：
  `healthDetail=online_missing`。

启动 readiness 只要求 HTTP 可用，不要求 `online=true`。因此 SnowLuma 未运行时
qq-gateway 仍可成功启动并进入 `running`，但 health 为 `degraded`；health loop
会在链路恢复后更新为 `healthy`。健康状态不触发自动重启。

## SnowLuma 隐藏启动

SnowLuma 仍是外部进程，supervisor 不启动、不停止、不托管它。用户可手动双击
`tools/start-snowluma-hidden.vbs`，以隐藏窗口方式启动默认的 `E:\SnowLuma`；
目录和 Node 路径可用 `SNOWLUMA_HOME` / `SNOWLUMA_NODE` 覆盖。隐藏后请通过
SnowLuma 自身日志或默认 Web UI `http://127.0.0.1:5099` 查看登录与运行状态。
详见 `tools/README.md`。

DSH 插件的 `config/snowluma.json` 只保存 SnowLuma home（当前为 `E:\SnowLuma`）。
host 每次成功获取 `/xtds/api/status` 时读取 `<home>\config\runtime.json`，只把
`webuiHost`、`webuiPort`、`webuiTls.enabled` 投影为 `snowluma` 字段；home、
原始 runtime 内容和其他字段不会进入 API 或日志。仅回环 host 生成可点击 URL；
配置或 runtime 缺失、损坏时返回稳定失败原因，不会让状态 API 失败。

## 安全与日志

- supervisor 和 DSH host 都只接受回环客户端。
- host 额外校验 `Origin` 与 `Sec-Fetch-Site`。
- control token 只在 `runtime/config.json`；endpoint、状态响应、浏览器均不返回 token。
- 服务 health 响应最多读取 64 KiB；原始 health body 不进入日志、status 或浏览器。
- 子进程 stdout/stderr 分别按完整逻辑行累积后写入 `runtime/logs/*.log`，对常见
  token/secret/Bearer 形式做脱敏；stderr 每行保留 `[stderr] ` 前缀。单行缓冲
  上限为 8 MiB（`8388608` 字符）；超过时整行丢弃（包括尚未换行的剩余内容），
  只写入固定标记 `[REDACTED] log line exceeded 8388608 characters`，并在下一个
  换行处恢复。每个子进程有独立的行缓冲会话；`exit` 只迁移进程状态，待子进程
  `close`（stdout/stderr 均关闭）后才 flush 该会话。因此后代继承管道时，父进程
  退出后晚到的输出仍会写入；`close` 长期不到达时会话保留，但内存仍受 8 MiB
  上限约束。flush 会写出未换行的普通残余，但不会输出已丢弃行的内容；因此超长行
  可能丢失。
- 每个服务只保留一个 `RotatingLogWriter`，跨 stop/start 复用；旧会话尾部与重启
  后的新输出共用同一 active 路径。writer 仅在 supervisor shutdown、同步 spawn
  抛错且无子进程、或记录转为不受管的外部实例时关闭，关闭操作幂等。
- supervisor shutdown 会先停止受管进程，再最多等待 5000ms，让仍打开的日志会话
  自然 `close`；正常 `close` 后尾部完整落盘。超时则按服务记录一条含剩余会话数的
  supervisor 告警，然后强制 flush/close；极端情况下超时后的尾部仍可能丢失。
  `stopAllManaged()` 抛错时也会执行同样有界收尾，并保留原错误。
- `ensureDir(runtime/logs)` 失败只通过日志失败告警上报，不阻止服务启动或监督。
- 日志写入或轮转失败只告警且不影响监督，告警按进程每 60 秒最多一条。
- 受管服务子进程日志按大小轮转：跨过 `logMaxBytes` 前将当前
  `runtime/logs/<id>.log` 重命名为不可变归档
  `runtime/logs/<id>.log.<12位单调序号>-<13位epoch-ms>-<pid>-<8位hex>.archive`。
  归档创建后不再改名；序号取现有归档中的最大序号 +1，不依赖系统时钟。
  `logMaxFiles` 表示保留的归档数（不含当前 `.log`），超出时按序号优先、
  epoch 次序删除最旧项；系统时钟回拨也不会删除更高序号的归档。单次超大 chunk
  可能暂时越过大小上限，下一次写入前会轮转。rename 失败时活动文件与现有归档
  原样保留，但本次 append 返回失败并暂停；后续 append 重试轮转，成功后才会
  恢复写入，因此持续 rename 失败不会让 active 继续增长。若轮转后无法清理到
  `logMaxFiles`，该服务同样暂停写日志且不创建/增长 active；后续 append 先重试
  cleanup，恢复达标后才继续。永久删除失败时归档数不超过 `logMaxFiles + 1`，
  active 不超过 `logMaxBytes`（单次超大 chunk 语义保持不变）。活动日志路径始终
  不变。该机制只覆盖 supervisor 管理的服务子进程 stdout/stderr，不覆盖低频的
  `runtime/logs/supervisor-boot.log`。
- 不启动、不停止 SnowLuma。

## 已知限制

- 2026-11-05 后 ds-memory / qq-gateway 已由 supervisor 接管；2026-11-08 起
  open-websearch 作为第三个受管进程接入；2026-11-09 起 code-bridge 作为
  第四个受管进程接入。若服务再次在
  supervisor 外启动，面板会标记为 `external`；此时必须先显式停止并重新接管，
  supervisor 不会杀死或重复启动外部实例。
- 开机自启已启用，但只启动 supervisor；`startServicesOnBoot` 为 `false`，因此
  登录后四个服务仍需要在面板中手动启动。真实注销/登录路径尚未执行，已通过
  实际启动脚本验证“supervisor 启动、服务保持 stopped”。
- supervisor 优雅退出会停止它启动的受管子进程；关闭 DSH 本身不会通知 supervisor 退出。
- host 插件默认仓库路径写死为本机路径；移动仓库需设置 `XTDS_ASSISTANT_HOME`。
- 插件路由按四个固定进程 ID 注册；新增进程需要补路由。
- 注册表 Run、Startup 或计划任务启动时可能显示最小化控制台窗口。
- 已在隔离 Web profile 中做无头浏览器视觉验收；Desktop 内用户已确认亮/暗主题、
  打开、关闭及服务的启动/停止/重启操作可用。
- 仅单用户、本机回环、无 TLS。

## 测试

```powershell
npm test
```

覆盖：鉴权 401、单实例、双 dummy 子进程 start/stop/restart、独立停止、
启动顺序、启动失败/崩溃不重启、外部实例 409、endpoint 清理、日志脱敏、
不可变归档轮转、序号续接/时钟回拨保留、rename 失败暂停/恢复、目录占位、
整行 8 MiB 上限与超长行丢弃、cleanup 失败暂停/恢复、跨重启单 writer 复用、
close 后后代晚到输出、shutdown 5 秒有界 drain 与超时告警、
日志目录创建失败不阻断启动、跨 chunk 脱敏与配置边界、
自启脚本不强制启动服务、
外部实例 + start-all 跳过、环境变量路径回退、
注册表/schtasks/Startup 三种自启后端、DSH host 路由/代理/Origin fence、
SnowLuma Web UI 只读发现与失败降级、status 透传边界、
client `__ModuleLoader__` 与 sidebar 注册。
code-bridge 任务/安全/队列、DSH 会话枚举与筛选、按会话恢复、按工作区续接、
工作区根校验、会话标题脱敏与重启状态兼容。
code-bridge 的超时/取消用例需要 Windows `taskkill /T /F` 权限；在受限沙箱或 CI 中
应使用普通 PowerShell 或允许终止进程树的 runner 运行，否则会表现为 `Access denied`
或测试无法退出，而不是业务回归。

详细记录见 `docs/ACCEPTANCE.md`。
