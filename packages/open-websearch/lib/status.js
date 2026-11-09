import { LauncherError } from "./errors.js";
import { sleep } from "./process.js";
import { EXPECTED_VERSION } from "./endpoint.js";

export const MAX_STATUS_BODY_BYTES = 64 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(reason, retryable = false) {
  return { ok: false, retryable, reason };
}

export function validateStatusPayload(payload, baseUrl) {
  if (!isPlainObject(payload)) return fail("invalid_payload");
  if (payload.status !== "ok" || !isPlainObject(payload.data)) return fail("invalid_envelope");
  const data = payload.data;
  if (data.daemon !== "running") return fail("daemon_not_running");
  if (data.runtime !== "ready") return fail("runtime_not_ready");
  if (data.activation !== "active") return fail("activation_not_active");
  if (data.version !== EXPECTED_VERSION) return fail("version_mismatch");
  if (data.baseUrl !== baseUrl) return fail("base_url_mismatch");
  if (!Array.isArray(data.capabilities)
    || !data.capabilities.includes("search")
    || !data.capabilities.includes("fetch-web")) {
    return fail("capabilities_mismatch");
  }
  const summary = data.configSummary;
  if (!isPlainObject(summary)) return fail("config_summary_missing");
  if (summary.useProxy !== false) return fail("proxy_enabled");
  if (summary.fetchWebAllowInsecureTls !== false) return fail("insecure_tls_enabled");
  return {
    ok: true,
    data: {
      daemon: data.daemon,
      runtime: data.runtime,
      activation: data.activation,
      version: data.version,
      baseUrl: data.baseUrl,
      capabilities: [...data.capabilities],
      configSummary: {
        useProxy: summary.useProxy,
        fetchWebAllowInsecureTls: summary.fetchWebAllowInsecureTls
      }
    }
  };
}

async function readBoundedBody(response, maxBytes) {
  if (response.body === null) return { text: "", tooLarge: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { text: "", tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

export async function probeStatus(baseUrl, timeoutMs) {
  let response;
  try {
    response = await fetch(`${baseUrl}/status`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
    });
  } catch (error) {
    return fail(error.name === "TimeoutError" ? "timeout" : "unreachable", true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return fail(`http_${response.status}`, true);
  }
  let body;
  try {
    body = await readBoundedBody(response, MAX_STATUS_BODY_BYTES);
  } catch {
    return fail("body_read_failed", true);
  }
  if (body.tooLarge) return fail("body_too_large");
  let payload;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return fail("invalid_json", true);
  }
  return validateStatusPayload(payload, baseUrl);
}

export async function waitForStatus(baseUrl, timeoutMs, { intervalMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  let lastReason = "unreachable";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await probeStatus(baseUrl, Math.min(2000, remaining));
    if (result.ok) return result.data;
    lastReason = result.reason;
    if (!result.retryable) {
      throw new LauncherError(
        `status_${result.reason}`,
        `open-websearch /status identity check failed: ${result.reason}`
      );
    }
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new LauncherError(
    `status_${lastReason}`,
    `open-websearch /status check timed out: ${lastReason}`
  );
}
