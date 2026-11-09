window.__ModuleLoader__.load({
  id: "xtds-assistant-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const reactDom = require("react-dom");
    const { useState, useEffect, useCallback } = react;
    const CSS_ID = "xtds-assistant-dsh";
    const THEME_KEY = "xtds-assistant-theme";
    const STATE_LABELS = {
      stopped: "已停止",
      starting: "启动中",
      running: "运行中",
      stopping: "停止中",
      failed: "失败",
      external: "外部实例"
    };
    const HEALTH_LABELS = {
      healthy: "健康",
      degraded: "等待 SnowLuma",
      unhealthy: "不健康",
      unknown: "未知"
    };

    function readThemePreference() {
      try {
        const saved = window.localStorage.getItem(THEME_KEY);
        if (saved === "light" || saved === "dark") return saved;
      } catch {
        // Default to the readable light palette when storage is unavailable.
      }
      return "light";
    }

    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = [
        ".xtds-foot{display:inline-flex;align-items:center;gap:6px;min-width:0;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a9a9b3);font:inherit;font-size:12px;cursor:pointer}",
        ".xtds-foot:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#eeeef2)}",
        ".xtds-foot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".xtds-foot-dot,.xtds-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#8b949e;box-shadow:0 0 0 2px rgba(139,148,158,.16)}",
        ".xtds-foot-dot.ok,.xtds-dot.ok{background:#3fb950;box-shadow:0 0 0 2px rgba(63,185,80,.16)}",
        ".xtds-foot-dot.warn,.xtds-dot.warn{background:#d29922;box-shadow:0 0 0 2px rgba(210,153,34,.16)}",
        ".xtds-foot-dot.bad,.xtds-dot.bad{background:#f85149;box-shadow:0 0 0 2px rgba(248,81,73,.16)}",
        ".xtds-foot-dot.busy,.xtds-dot.busy{background:#58a6ff;animation:xtds-pulse 1s ease-in-out infinite}",
        "@keyframes xtds-pulse{50%{opacity:.35}}",
        ".xtds-panel{position:fixed;left:18px;bottom:64px;width:min(440px,calc(100vw - 36px));max-height:min(72vh,620px);display:flex;flex-direction:column;z-index:2147483000;pointer-events:auto;isolation:isolate;background:var(--xtds-bg);color:var(--xtds-text);border:1px solid var(--xtds-border);border-radius:14px;box-shadow:var(--xtds-shadow);font-size:12px;overflow:hidden}",
        ".xtds-panel[data-theme=light]{color-scheme:light;--xtds-bg:#fff;--xtds-bg-soft:#f6f8fa;--xtds-bg-muted:#eef1f4;--xtds-text:#1f2328;--xtds-muted:#57606a;--xtds-border:#d0d7de;--xtds-border-strong:#8c959f;--xtds-hover:#eaeef2;--xtds-ok:#1a7f37;--xtds-warn:#9a6700;--xtds-bad:#cf222e;--xtds-accent:#0969da;--xtds-shadow:0 18px 50px rgba(31,35,40,.22)}",
        ".xtds-panel[data-theme=dark]{color-scheme:dark;--xtds-bg:#161b22;--xtds-bg-soft:#21262d;--xtds-bg-muted:#30363d;--xtds-text:#f0f6fc;--xtds-muted:#9da7b3;--xtds-border:#3d444d;--xtds-border-strong:#6e7681;--xtds-hover:#30363d;--xtds-ok:#3fb950;--xtds-warn:#d29922;--xtds-bad:#ff7b72;--xtds-accent:#58a6ff;--xtds-shadow:0 18px 50px rgba(1,4,9,.5)}",
        ".xtds-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--xtds-border);background:var(--xtds-bg-soft)}",
        ".xtds-title{font-size:13px;font-weight:600;flex:1}",
        ".xtds-theme,.xtds-close{border:1px solid var(--xtds-border);background:var(--xtds-bg);color:var(--xtds-text);line-height:1;cursor:pointer;border-radius:7px;font:inherit}",
        ".xtds-theme{font-size:11px;padding:4px 8px}",
        ".xtds-close{font-size:18px;padding:2px 7px 3px}",
        ".xtds-theme:hover,.xtds-close:hover{background:var(--xtds-hover)}",
        ".xtds-body{padding:10px 12px 12px;overflow:auto;display:flex;flex-direction:column;gap:9px}",
        ".xtds-meta{color:var(--xtds-muted);font-size:11px;display:flex;justify-content:space-between;gap:8px}",
        ".xtds-proc{padding:10px;border:1px solid var(--xtds-border);border-radius:10px;background:var(--xtds-bg-soft)}",
        ".xtds-proc-head{display:flex;align-items:center;gap:7px}",
        ".xtds-proc-name{font-weight:600;flex:1}",
        ".xtds-badge{font-size:10px;padding:1px 6px;border-radius:99px;background:var(--xtds-bg-muted);color:var(--xtds-muted)}",
        ".xtds-proc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px 8px;margin-top:7px;font-size:10.5px;color:var(--xtds-text)}",
        ".xtds-proc-grid b{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--xtds-muted);margin-bottom:1px}",
        ".xtds-actions{display:flex;gap:6px;margin-top:9px}",
        ".xtds-btn{border:1px solid var(--xtds-border-strong);background:var(--xtds-bg);color:var(--xtds-text);border-radius:7px;padding:5px 10px;font:inherit;cursor:pointer}",
        ".xtds-btn:hover:not(:disabled){background:var(--xtds-hover)}",
        ".xtds-btn.primary{border-color:var(--xtds-ok);color:var(--xtds-ok)}",
        ".xtds-btn.danger{border-color:var(--xtds-bad);color:var(--xtds-bad)}",
        ".xtds-btn:disabled{opacity:.45;cursor:default}",
        ".xtds-footnote{font-size:10.5px;color:var(--xtds-muted);line-height:1.45}",
        ".xtds-snowluma{display:flex;align-items:center;flex-wrap:wrap;gap:3px 8px;margin-top:8px;padding-top:7px;border-top:1px solid var(--xtds-border);font-size:10.5px;color:var(--xtds-muted);line-height:1.45}",
        ".xtds-snowluma-title{font-weight:600;color:var(--xtds-text)}",
        ".xtds-snowluma-address{color:var(--xtds-text);font-variant-numeric:tabular-nums}",
        ".xtds-snowluma-link{color:var(--xtds-accent);text-decoration:none;font-weight:600}",
        ".xtds-snowluma-link:hover{text-decoration:underline}",
        ".xtds-auto{display:flex;align-items:center;gap:8px;padding-top:3px}",
        ".xtds-auto input{accent-color:var(--xtds-ok)}",
        ".xtds-error{color:var(--xtds-bad);font-size:11px;white-space:pre-wrap}",
        ".xtds-empty{color:var(--xtds-muted);padding:8px 0}"
      ].join("");
      document.head.append(tag);
    }

    function requestJson(path, options) {
      const init = options ? { ...options } : {};
      init.headers = {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      };
      init.cache = "no-store";
      return window.fetch(path, init).then(async (response) => {
        const text = await response.text();
        let data = null;
        try {
          data = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (!response.ok) {
          const message = data && data.error ? data.error : `请求失败 (${response.status})`;
          throw new Error(message);
        }
        return data;
      });
    }

    function formatUptime(startedAt) {
      if (!startedAt) return "—";
      const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    }

    function overallClass(snapshot, error) {
      if (error && !snapshot) return "bad";
      if (!snapshot || !Array.isArray(snapshot.processes)) return "";
      if (snapshot.processes.some((entry) => entry.state === "failed")) return "bad";
      if (snapshot.processes.some((entry) => entry.state === "starting" || entry.state === "stopping")) return "busy";
      if (snapshot.processes.some((entry) => entry.health === "degraded")) return "busy";
      if (snapshot.processes.some((entry) => entry.state === "running" || entry.state === "external")) return "ok";
      return "";
    }

    function healthTone(entry, stateBusy, failed) {
      if (entry.health === "healthy") return "ok";
      if (entry.health === "unhealthy" || failed) return "bad";
      if (entry.health === "degraded") return "warn";
      return stateBusy ? "busy" : "";
    }

    function healthDetailNote(entry) {
      if (entry.id === "qq-gateway" && entry.online === false) {
        return "QQ 链路离线：SnowLuma 未运行或未连接";
      }
      if (entry.healthDetail === "health_invalid") return "健康检查响应无效或超过 64 KiB。";
      if (entry.healthDetail === "online_missing") return "健康检查缺少布尔 online 字段。";
      return null;
    }

    function snowlumaRowForProcess(entry, snowluma) {
      if (!entry || entry.id !== "qq-gateway") return null;
      const title = react.createElement("span", { className: "xtds-snowluma-title" }, "SnowLuma Web UI");
      const available = snowluma
        && snowluma.available === true
        && typeof snowluma.webUiHost === "string"
        && snowluma.webUiHost.length > 0
        && Number.isInteger(snowluma.webUiPort);
      if (!available) {
        return react.createElement("div", { className: "xtds-snowluma" },
          title,
          react.createElement("span", null, "未发现 SnowLuma 端口"));
      }

      const host = snowluma.webUiHost.includes(":") ? `[${snowluma.webUiHost}]` : snowluma.webUiHost;
      const address = react.createElement("span", { className: "xtds-snowluma-address" },
        `${host}:${snowluma.webUiPort}`);
      const hasUrl = typeof snowluma.webUiUrl === "string" && /^https?:\/\/\S+$/.test(snowluma.webUiUrl);
      return react.createElement("div", { className: "xtds-snowluma" },
        title,
        address,
        hasUrl
          ? react.createElement("a", {
            className: "xtds-snowluma-link",
            href: snowluma.webUiUrl,
            target: "_blank",
            rel: "noreferrer"
          }, "打开设置")
          : react.createElement("span", null, "非回环地址，无法直接打开"));
    }

    function XtDSAssistant(props) {
      const [open, setOpen] = useState(false);
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState({});
      const [autoBusy, setAutoBusy] = useState(false);
      const [theme, setTheme] = useState(readThemePreference);

      useEffect(() => {
        try {
          window.localStorage.setItem(THEME_KEY, theme);
        } catch {
          // Theme persistence is optional.
        }
      }, [theme]);

      const refresh = useCallback(async () => {
        try {
          const data = await requestJson("/xtds/api/status");
          setSnapshot(data);
          setError("");
        } catch (nextError) {
          setError(String((nextError && nextError.message) || nextError));
        }
      }, []);

      useEffect(() => {
        let alive = true;
        const tick = () => {
          refresh().catch(() => {
            // refresh already records the error
          });
        };
        tick();
        const timer = window.setInterval(() => {
          if (alive) tick();
        }, 3000);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [refresh]);

      const runAction = async (id, action) => {
        const key = `${id}:${action}`;
        setBusy((current) => ({ ...current, [key]: true }));
        setError("");
        try {
          await requestJson(`/xtds/api/processes/${id}/${action}`, { method: "POST" });
          await refresh();
        } catch (nextError) {
          setError(String((nextError && nextError.message) || nextError));
          await refresh();
        } finally {
          setBusy((current) => ({ ...current, [key]: false }));
        }
      };

      const toggleAutostart = async (enabled) => {
        setAutoBusy(true);
        setError("");
        try {
          await requestJson("/xtds/api/autostart", {
            method: "PUT",
            body: JSON.stringify({ enabled })
          });
          await refresh();
        } catch (nextError) {
          setError(String((nextError && nextError.message) || nextError));
        } finally {
          setAutoBusy(false);
        }
      };

      const tone = overallClass(snapshot, error);
      const supervisor = snapshot && snapshot.supervisor ? snapshot.supervisor : null;
      const autostart = snapshot && snapshot.autostart ? snapshot.autostart : null;
      const button = react.createElement("button", {
        type: "button",
        className: "xtds-foot",
        title: "XTDS 助手",
        "aria-label": "XTDS 助手",
        "aria-expanded": open,
        onClick: (event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        },
        onPointerDown: (event) => event.stopPropagation()
      },
      react.createElement("span", { className: `xtds-foot-dot ${tone}` }),
      react.createElement("span", { className: "xtds-foot-label" }, "XTDS 助手"));

      if (!open) return button;

      const processCards = snapshot && Array.isArray(snapshot.processes)
        ? snapshot.processes.map((entry) => {
          const stateBusy = entry.state === "starting" || entry.state === "stopping";
          const external = entry.state === "external";
          const running = entry.state === "running" || external;
          const failed = entry.state === "failed";
          const detailNote = healthDetailNote(entry);
          const snowlumaRow = snowlumaRowForProcess(entry, snapshot && snapshot.snowluma);
          return react.createElement("div", { className: "xtds-proc", key: entry.id },
            react.createElement("div", { className: "xtds-proc-head" },
              react.createElement("span", { className: `xtds-dot ${healthTone(entry, stateBusy, failed)}` }),
              react.createElement("span", { className: "xtds-proc-name" }, entry.label || entry.id),
              react.createElement("span", { className: "xtds-badge" }, STATE_LABELS[entry.state] || entry.state)),
            react.createElement("div", { className: "xtds-proc-grid" },
              react.createElement("div", null, react.createElement("b", null, "PID"), entry.pid || "—"),
              react.createElement("div", null, react.createElement("b", null, "端口"), entry.port || "—"),
              react.createElement("div", null, react.createElement("b", null, "健康"), HEALTH_LABELS[entry.health] || entry.health),
              react.createElement("div", null, react.createElement("b", null, "Uptime"), formatUptime(entry.startedAt))),
            external
              ? react.createElement("div", { className: "xtds-footnote" }, "该实例不是由 supervisor 启动，请在原终端手动处理。")
              : null,
            detailNote
              ? react.createElement("div", { className: "xtds-footnote" }, detailNote)
              : null,
            snowlumaRow,
            entry.lastError
              ? react.createElement("div", { className: "xtds-error" }, entry.lastError)
              : null,
            react.createElement("div", { className: "xtds-actions" },
              react.createElement("button", {
                type: "button",
                className: "xtds-btn primary",
                title: external ? "外部实例：请先在原终端停止，之后由 supervisor 接管" : "启动",
                disabled: external || running || stateBusy || Boolean(busy[`${entry.id}:start`]),
                onClick: () => runAction(entry.id, "start")
              }, "启动"),
              react.createElement("button", {
                type: "button",
                className: "xtds-btn danger",
                title: external ? "外部实例：supervisor 不会停止不是自己启动的进程" : "停止",
                disabled: external || !running || stateBusy || Boolean(busy[`${entry.id}:stop`]),
                onClick: () => runAction(entry.id, "stop")
              }, "停止"),
              react.createElement("button", {
                type: "button",
                className: "xtds-btn",
                title: external ? "外部实例：请先在原终端停止，之后由 supervisor 接管" : "重启",
                disabled: external || stateBusy || Boolean(busy[`${entry.id}:restart`]),
                onClick: () => runAction(entry.id, "restart")
              }, "重启")));
        })
        : [react.createElement("div", { className: "xtds-empty", key: "empty" }, "正在读取 supervisor 状态…")];

      const panel = react.createElement("section", {
        className: "xtds-panel",
        "data-theme": theme,
        role: "dialog",
        "aria-label": "XTDS 助手",
        onClick: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onPointerDown: (event) => event.stopPropagation()
      },
        react.createElement("div", { className: "xtds-head" },
          react.createElement("span", { className: `xtds-dot ${tone}` }),
          react.createElement("span", { className: "xtds-title" }, "XTDS 助手"),
          react.createElement("button", {
            type: "button",
            className: "xtds-theme",
            title: theme === "light" ? "切换到暗色主题" : "切换到亮色主题",
            "aria-label": theme === "light" ? "切换到暗色主题" : "切换到亮色主题",
            onClick: () => setTheme(theme === "light" ? "dark" : "light")
          }, theme === "light" ? "暗色" : "亮色"),
          react.createElement("button", {
            type: "button",
            className: "xtds-close",
            "aria-label": "关闭",
            onClick: () => setOpen(false)
          }, "×")),
        react.createElement("div", { className: "xtds-body" },
          react.createElement("div", { className: "xtds-meta" },
            react.createElement("span", null, supervisor
              ? `supervisor PID ${supervisor.pid} · :${supervisor.port} · ${formatUptime(supervisor.startedAt)}`
              : "supervisor 未连接"),
            react.createElement("span", null, "每 3 秒刷新")),
          error ? react.createElement("div", { className: "xtds-error" }, error) : null,
          ...processCards,
          react.createElement("div", { className: "xtds-auto" },
            react.createElement("input", {
              id: "xtds-autostart",
              type: "checkbox",
              checked: Boolean(autostart && autostart.enabled),
              disabled: autoBusy || !autostart || autostart.supported === false,
              onChange: (event) => toggleAutostart(event.target.checked)
            }),
            react.createElement("label", { htmlFor: "xtds-autostart" }, "开机自启 supervisor"),
            react.createElement("span", { className: "xtds-footnote" }, autostart
              ? `${autostart.backend === "registry" ? "注册表 Run" : autostart.backend === "startup" ? "Startup 文件夹" : "计划任务"} · ${autostart.enabled ? "已启用" : "已关闭"}`
              : "读取中")),
          react.createElement("div", { className: "xtds-footnote" },
            "关闭 DSH 不会停止后台 supervisor；这里只控制系统开机自启与两个服务进程。")));

      return react.createElement(react.Fragment, null,
        button,
        typeof document !== "undefined" && document.body
          ? reactDom.createPortal(panel, document.body)
          : panel);
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "xtds-assistant-dsh",
        order: 20,
        label: () => "XTDS 助手"
      }, XtDSAssistant));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
