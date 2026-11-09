# xtds-assistant-dsh

Current package version: `0.1.0`.

DSH host/client plugin for the XTDS assistant supervisor. The browser only talks
to same-origin `/xtds/api/*`; the host half attaches the local control token.
The floating panel is portalled to `document.body` and has a persisted
high-contrast light/dark theme switch.

## SnowLuma Web UI discovery

`config/snowluma.json` contains only the local SnowLuma home:

```json
{"home":"E:\\SnowLuma"}
```

On each successful `GET /xtds/api/status`, the host reads
`<home>\config\runtime.json` and projects only `webuiHost`, `webuiPort`, and
`webuiTls.enabled` into a `snowluma` field. The home path, the raw runtime
contents, and unrelated config/runtime fields are never returned or logged.
Other routes, non-200 upstream responses, and upstream bodies that are not
parseable JSON objects pass through unchanged.

A loopback Web UI host (`localhost`, `127.0.0.0/8`, or `::1`) produces a
clickable trailing-slash URL. A valid non-loopback host still reports that the
Web UI exists but has `reason: "non_loopback_host"` and no `webUiUrl`. Discovery
failures are non-fatal and use stable reasons such as `config_missing`,
`config_invalid`, `runtime_missing`, `runtime_invalid`, `host_invalid`, and
`port_invalid`.

The qq-gateway card shows a single `SnowLuma Web UI` row, including the
`host:port` and an `打开设置` link only when the host-side URL is available.
SnowLuma remains user-owned: this plugin does not start, stop, restart, or
supervise it.

See the repository root README for installation and operation.
