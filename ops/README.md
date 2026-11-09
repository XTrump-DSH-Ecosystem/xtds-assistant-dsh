# Ops 工具

`ops/` 下的脚本只使用 Node.js 内置模块，不新增依赖，也不启停 `ds-memory`、`qq-gateway` 或 SnowLuma。

## 安全边界

- `soak-monitor.mjs` 只读取 supervisor endpoint、执行只读 GET 请求、统计目录大小，不修改 state，不发送 QQ 消息。
- `backup-state.mjs` 不修改源 state，不停止服务，不直接恢复 live state。
- 控制 token 只保留在进程内存和 `x-xtds-token` 请求头中，不写入采样、摘要、日志或异常文本。
- 采样不记录消息正文、token 或文件系统绝对路径。
- 备份包含私密会话、记忆和回执数据，应按敏感数据处理。

### 威胁模型

- 本工具只做隔离恢复演练，不提供生产/live state 恢复流程。
- `manifest.json` 是不可信输入。`verify` 只证明备份内容与 manifest 中的大小和 SHA-256 一致，不证明 manifest 来源真实或字段未被伪造。
- restore 的安全边界不依赖 manifest：target 必须位于代码固定的仓库内 `runtime/restore-drill` 之下。伪造 manifest 最多影响该演练根内部，不能把恢复写入 live state。
- 真实灾难恢复必须由人工评估、停机、备份和回滚方案执行，本工具不提供该能力。

## 24 小时 soak

先确认 supervisor 和两个服务已经在运行，然后在仓库根目录执行：

```powershell
npm run ops:soak -- --duration-minutes 1440 --interval-ms 60000
```

快速冒烟只采一次：

```powershell
npm run ops:soak:once
```

默认读取：

- supervisor endpoint：`runtime/supervisor.endpoint.json`
- control token：`runtime/config.json`
- ds-memory state：`../ds-memory/state`
- supervisor 日志：`runtime/logs`
- 输出：`runtime/soak/<UTC timestamp>-<pid>/`

如需显式指定目录：

```powershell
npm run ops:soak -- --once --state-dir ..\ds-memory\state --log-dir runtime\logs
```

每次运行生成：

- `run.json`：运行参数和 supervisor 身份信息，不含绝对路径。
- `samples.jsonl`：每个采样间隔一行，包含 supervisor 状态、两个服务的 state/health/pid/port/uptime、服务 `/health` 响应、state 目录字节/文件数、日志总字节和采集异常。
- `summary.json`：包含 `samples`、`unhealthySamples`、`errorSamples`、`pidChanges`、`maxStateBytes`、`maxLogBytes` 和 `pass`。

`pass=true` 要求至少有一个样本、未被中断、无采集异常、无 unhealthy 样本、两个服务在每个样本中都有正整数 PID，并且 PID 自首次观测后没有变化。计划内重启应另行记录；当前工具会把 PID 变化视为失败。

退出码：`pass=true` 为 `0`，正常完成但 `pass=false` 为 `2`，收到 SIGINT/SIGTERM 并写完 summary 后 `130`，启动或写文件失败 `1`。

## State 备份、校验与恢复演练

建议先在仓库根目录设置时间戳变量：

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "..\backups\ds-memory-state-$stamp"
$drill = "runtime\restore-drill\$stamp"
```

创建只读快照：

```powershell
npm run ops:backup -- create --source ..\ds-memory\state --dest $backup
```

校验快照：

```powershell
npm run ops:backup -- verify --backup $backup
```

恢复到隔离目录并再次校验：

```powershell
npm run ops:backup -- restore --backup $backup --target $drill
```

说明：

- `create` 递归复制普通文件，排除 `ds-memory.lock`、`*.tmp`、`*.partial`、Office 临时文件等；先写同盘临时目录，成功后原子改名为目标备份目录。
- `manifest.json` 只记录源目录 basename、相对路径、字节数和 SHA-256，不记录源绝对路径。version 为 `2`；`sourcePathHash` 与 `sourceAncestorPathHashes` 为必填字段，后者不得包含前者，字段缺失或格式错误时 verify/restore 直接失败。version 1 备份必须重建。
- `create` 会拒绝 source 与固定演练根 `runtime/restore-drill` 存在任何祖先/后代重叠，避免 live source 被放进演练根后形成父目录攻击面。
- 目标备份目录必须不存在或为空。`verify` 对缺少文件、大小或哈希不符返回非零；额外文件只告警。
- `restore` 先完整 verify，再复制到 target 旁的 staging 目录，校验通过后才替换 target。target 非空时必须显式加 `--force`，且会被整体替换。
- CLI 不提供任意演练根覆盖参数。target 必须是仓库内 `runtime/restore-drill` 的严格后代；等于根、位于根外、或通过 junction/symlink 解析到根外都会失败。
- target 不得等于、包含或位于备份目录内，也不得等于 live source、位于 live source 内，或成为 live source 的祖先目录。

**禁止把 `--target` 指向 `..\ds-memory\state`。** 恢复演练必须在隔离目录完成，并保留原 live state；需要真正切换时由人工决策，本工具不自动覆盖 live state，也不停止服务。即使 manifest 被伪造，固定演练根也会阻止恢复到 live state。

## 备份保留与敏感数据

- 备份包含私密会话、记忆和 QQ 回执，不应提交到 Git，不应放入同步盘或公开共享目录。
- 将备份放在受 ACL 限制的本地目录，使用磁盘加密；只允许必要运维账号读取。
- 建议至少保留最近 2 份已 verify 的快照；可按“每日 7 份 + 每周 4 份”保留，但不要在同一天删除最后一份可恢复副本。
- 删除旧备份前先运行 `verify`，并定期从最新备份恢复到 `runtime/restore-drill/` 做演练。
- soak 输出不含 token 和消息正文，但仍建议留在已被 Git 忽略的 `runtime/` 下。
