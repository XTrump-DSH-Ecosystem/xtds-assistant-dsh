import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function loadClientHelpers() {
  const source = readFileSync(join(import.meta.dirname, "../lib/client.js"), "utf8");
  const instrumented = source.replace(
    "exports.apply = apply;",
    "exports.apply = apply; exports.__test = { overallClass, healthTone, healthDetailNote, snowlumaRowForProcess, HEALTH_LABELS };"
  );
  assert.notEqual(instrumented, source);

  let loaded = null;
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: {},
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn
  };
  const context = {
    window: {
      __ModuleLoader__: {
        load(record) {
          loaded = record;
        }
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {}
      }
    },
    document: {
      querySelector: () => ({}),
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { append: () => {} }
    },
    console
  };
  vm.runInNewContext(instrumented, context, { filename: "client.js" });
  const exported = loaded.factory((id) => {
    assert.ok(id === "react" || id === "react-dom");
    return id === "react" ? reactStub : { createPortal: (node) => node };
  });
  return exported.__test;
}

function nodeText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return node.children.map(nodeText).join(" ");
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("degraded health is never shown as an all-green overall state", () => {
  const helpers = loadClientHelpers();
  assert.equal(helpers.HEALTH_LABELS.degraded, "等待 SnowLuma");
  assert.equal(helpers.overallClass({
    processes: [
      { state: "running", health: "healthy" },
      { state: "running", health: "degraded" }
    ]
  }, ""), "busy");
  assert.equal(helpers.overallClass({
    processes: [{ state: "running", health: "healthy" }]
  }, ""), "ok");
  assert.equal(helpers.overallClass({
    processes: [{ state: "failed", health: "degraded" }]
  }, ""), "bad");
  assert.equal(helpers.healthTone({ health: "degraded" }, false, false), "warn");
  assert.equal(helpers.healthTone({ health: "unhealthy" }, false, false), "bad");
});

test("qq-gateway offline state has a clear footnote", () => {
  const helpers = loadClientHelpers();
  assert.equal(
    helpers.healthDetailNote({
      id: "qq-gateway",
      health: "degraded",
      online: false,
      healthDetail: "onebot_offline"
    }),
    "QQ 链路离线：SnowLuma 未运行或未连接"
  );
  assert.equal(helpers.healthDetailNote({
    id: "qq-gateway",
    health: "degraded",
    online: null,
    healthDetail: "online_missing"
  }), "健康检查缺少布尔 online 字段。");
  assert.equal(helpers.healthDetailNote({
    id: "qq-gateway",
    health: "degraded",
    online: null,
    healthDetail: "health_invalid"
  }), "健康检查响应无效或超过 64 KiB。");
  assert.equal(helpers.healthDetailNote({
    id: "ds-memory",
    health: "healthy",
    online: false,
    healthDetail: null
  }), null);
});

test("qq-gateway shows the SnowLuma port and a safe loopback settings link", () => {
  const helpers = loadClientHelpers();
  const row = helpers.snowlumaRowForProcess({ id: "qq-gateway" }, {
    available: true,
    webUiHost: "127.0.0.1",
    webUiPort: 5099,
    webUiUrl: "http://127.0.0.1:5099/",
    tls: false,
    checkedAt: "2026-11-08T00:00:00.000Z"
  });
  assert.equal(row.type, "div");
  assert.match(nodeText(row), /SnowLuma Web UI/);
  assert.match(nodeText(row), /127\.0\.0\.1:5099/);
  const link = findNode(row, (node) => node.type === "a");
  assert.ok(link);
  assert.equal(link.props.href, "http://127.0.0.1:5099/");
  assert.equal(link.props.target, "_blank");
  assert.equal(link.props.rel, "noreferrer");
  assert.match(nodeText(link), /打开设置/);
});

test("non-loopback SnowLuma hosts are shown without a link", () => {
  const helpers = loadClientHelpers();
  const row = helpers.snowlumaRowForProcess({ id: "qq-gateway" }, {
    available: true,
    webUiHost: "snowluma.example",
    webUiPort: 5099,
    tls: false,
    checkedAt: "2026-11-08T00:00:00.000Z",
    reason: "non_loopback_host"
  });
  assert.match(nodeText(row), /snowluma\.example:5099/);
  assert.match(nodeText(row), /无法直接打开/);
  assert.equal(findNode(row, (node) => node.type === "a"), null);
});

test("SnowLuma unavailable row is explicit and only applies to qq-gateway", () => {
  const helpers = loadClientHelpers();
  const row = helpers.snowlumaRowForProcess({ id: "qq-gateway" }, {
    available: false,
    checkedAt: "2026-11-08T00:00:00.000Z",
    reason: "runtime_missing"
  });
  assert.match(nodeText(row), /SnowLuma Web UI/);
  assert.match(nodeText(row), /未发现 SnowLuma 端口/);
  assert.equal(findNode(row, (node) => node.type === "a"), null);
  assert.equal(helpers.snowlumaRowForProcess({ id: "ds-memory" }, {
    available: true,
    webUiHost: "127.0.0.1",
    webUiPort: 5099,
    webUiUrl: "http://127.0.0.1:5099/"
  }), null);
});

test("IPv6 SnowLuma addresses are bracketed in the card row", () => {
  const helpers = loadClientHelpers();
  const row = helpers.snowlumaRowForProcess({ id: "qq-gateway" }, {
    available: true,
    webUiHost: "::1",
    webUiPort: 5099,
    webUiUrl: "http://[::1]:5099/",
    tls: false
  });
  assert.match(nodeText(row), /\[::1\]:5099/);
  assert.equal(findNode(row, (node) => node.type === "a").props.href, "http://[::1]:5099/");
});
