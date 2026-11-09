import test from "node:test";
import assert from "node:assert/strict";
import { validateStatusPayload } from "../lib/status.js";

const BASE_URL = "http://127.0.0.1:49152";

function payload({ data = {}, summary = {} } = {}) {
  return {
    status: "ok",
    data: {
      daemon: "running",
      runtime: "ready",
      activation: "active",
      version: "2.2.0",
      capabilities: ["search", "fetch-web"],
      baseUrl: BASE_URL,
      configSummary: {
        useProxy: false,
        fetchWebAllowInsecureTls: false,
        playwrightUnavailableReason: "C:\\secret-playwright-path\\browser.exe",
        ...summary
      },
      ...data
    },
    error: null,
    hint: null
  };
}

test("validateStatusPayload accepts the frozen identity", () => {
  const result = validateStatusPayload(payload(), BASE_URL);
  assert.equal(result.ok, true);
  assert.equal(result.data.version, "2.2.0");
  assert.equal(result.data.baseUrl, BASE_URL);
  assert.equal("playwrightUnavailableReason" in result.data.configSummary, false);
});

test("validateStatusPayload rejects identity and policy mismatches", () => {
  const cases = [
    [null, "invalid_payload"],
    [{ status: "error", data: null }, "invalid_envelope"],
    [payload({ data: { daemon: "stopped" } }), "daemon_not_running"],
    [payload({ data: { runtime: "starting" } }), "runtime_not_ready"],
    [payload({ data: { activation: "inactive" } }), "activation_not_active"],
    [payload({ data: { version: "2.2.1" } }), "version_mismatch"],
    [payload({ data: { baseUrl: "http://127.0.0.1:1" } }), "base_url_mismatch"],
    [payload({ data: { capabilities: ["search"] } }), "capabilities_mismatch"],
    [payload({ data: { configSummary: null } }), "config_summary_missing"],
    [payload({ summary: { useProxy: true } }), "proxy_enabled"],
    [payload({ summary: { fetchWebAllowInsecureTls: true } }), "insecure_tls_enabled"]
  ];
  for (const [value, reason] of cases) {
    const result = validateStatusPayload(value, BASE_URL);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
});
