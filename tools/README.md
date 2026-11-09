# SnowLuma 隐藏启动器

`start-snowluma-hidden.vbs` 是供用户手动双击的独立启动器。它只在用户主动运行时启动外部 SnowLuma 进程，并让该进程不显示控制台窗口；它不接管生命周期，也不提供自动启动或自动重启。

## 双击启动

直接双击 `start-snowluma-hidden.vbs`。默认启动：

- 目录：`E:\SnowLuma`
- Node：`E:\SnowLuma\node.exe`
- 入口：`E:\SnowLuma\index.mjs`
- 工作目录：`E:\SnowLuma`

启动器以隐藏窗口方式运行 Node 且不等待返回，所以双击后不会留下终端窗口。关闭启动器本身不会停止 SnowLuma；需要停止时请按 SnowLuma 自己的方式手动处理。

隐藏终端后，登录和运行状态请通过 SnowLuma 自己的 Web UI（当前部署默认为
`http://127.0.0.1:5099`）或其 `logs` 目录查看。

## 环境变量覆盖

需要切换目录或 Node 可执行文件时，可设置以下用户环境变量：

- `SNOWLUMA_HOME`：SnowLuma 目录，需包含 `index.mjs`。未设置或为空时使用 `E:\SnowLuma`。
- `SNOWLUMA_NODE`：Node 可执行文件的绝对路径。未设置或为空时使用 `<SNOWLUMA_HOME>\node.exe`。

双击方式会继承 Windows 用户环境变量。修改后若资源管理器尚未刷新环境，可重新登录或重启资源管理器。路径含空格可以直接设置，启动器会正确引用。

如果目录、`index.mjs` 或 Node 文件不存在，启动器会显示错误对话框，不打开控制台窗口。

## 进程边界

- SnowLuma 仍是外部进程，不属于 supervisor，也未加入 supervisor 配置。
- 本工具不会启动或停止 supervisor、DSH 或其他服务。
- 不注册开机自启、计划任务或注册表启动项。
- 不提供轮询守护、自动重启或服务化。
- 日志仍由 SnowLuma 自己写入，默认位于 `E:\SnowLuma\logs`；自定义目录时为 `<SNOWLUMA_HOME>\logs`。

本工具只解决“启动 SnowLuma 的终端窗口不能关闭”这一操作问题，不参与 SnowLuma 的运行管理。
