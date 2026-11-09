# xtds-code-bridge

独立的本地 DSH 任务桥：只监听 `127.0.0.1`，用独立 token 接收任务，
为新任务创建独立 git worktree，也可按会话或工作区恢复 DSH 会话。零运行期
依赖，只使用 Node.js 24 标准库。

本包已由 `xtds-assistant-dsh` supervisor 作为第 4 个受管进程接入；也仍可按
下面的快速开始独立前台运行。

## 快速开始

1. 复制 `config.example.json` 为仓库外的本机配置，例如
   `%LOCALAPPDATA%\DSH\code-bridge.json`。
2. 修改 `dshCommand`、`worktreeRoot` 和 `repos` allowlist。
3. 可选校验：

```powershell
node bin/code-bridge.js --config "$env:LOCALAPPDATA\DSH\code-bridge.json" --check
```

4. 前台启动：

```powershell
node bin/code-bridge.js --config "$env:LOCALAPPDATA\DSH\code-bridge.json"
```

默认端口 `9787`，被占用或返回 `EACCES` 时回退到系统临时端口。实际地址
写入 `%LOCALAPPDATA%\DSH\runtime\code-bridge.endpoint.json`。

`config.example.json` 使用本机 Windows 绝对路径，仅作为当前
`E:\workspace` 布局的示例。`xtds` 指向
`E:\workspace\xtds-boot-suite`（该目录自身是 git 顶层）。仓库移动
或目录布局变化时，必须同步修改
`repos` 映射，再运行 `--check`；包测试也会校验示例中的每个 repo 仍是 git 顶层。

## 认证与 API

除 `GET /health` 外，请求需要下列任一请求头：

```text
x-code-bridge-token: <token>
Authorization: Bearer <token>
```

token 位于 `%LOCALAPPDATA%\DSH\runtime\code-bridge.token`，不写入 endpoint。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 无 token；PID、uptime、running/queued 计数 |
| `GET` | `/v1/sessions` | 枚举 `{sessionId,title,workspace,lastUsedAt}`；支持 `q`/`limit` |
| `POST` | `/v1/tasks` | 提交 `{requestId,repo?,task,session?,sessionId?,workspace?,newSession?}` |
| `GET` | `/v1/tasks/:id` | 查询任务投影 |
| `POST` | `/v1/tasks/:id/cancel` | 取消 queued 或 running 任务 |

任务投影不包含任务正文、token、完整 stdout/stderr。完整接口、状态语义、
安全决策和测试记录见 [`docs/CODE-BRIDGE.md`](../../docs/CODE-BRIDGE.md)。

## 测试

```powershell
npm --prefix packages/code-bridge test
npm --prefix packages/code-bridge run check
```

测试只使用临时 git 仓库、临时端口和 fake `dsh.cmd`，不会调用真实 DSH 或
DeepSeek API。
