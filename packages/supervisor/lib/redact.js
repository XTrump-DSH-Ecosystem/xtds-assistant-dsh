const GENERIC_PATTERNS = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, "$1[REDACTED]"],
  [/((?:access[_-]?token|refresh[_-]?token|hook[_-]?token|token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, "$1[REDACTED]"]
];

const DEFAULT_MAX_PENDING_CHARS = 8 * 1024 * 1024;

function reportError(onError, error) {
  if (typeof onError !== "function") return;
  try {
    onError(error);
  } catch {}
}

function normalizedSecrets(secretValues) {
  return [...new Set(
    secretValues
      .filter((value) => typeof value === "string" && value.length >= 6)
      .sort((a, b) => b.length - a.length)
  )];
}

export function createRedactor(secretValues = []) {
  const secrets = normalizedSecrets(secretValues);
  return (value) => {
    let text = String(value ?? "");
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    for (const [pattern, replacement] of GENERIC_PATTERNS) text = text.replace(pattern, replacement);
    return text;
  };
}

export function createLineRedactor({
  redact,
  secretValues = [],
  linePrefix = "",
  maxPendingChars = DEFAULT_MAX_PENDING_CHARS,
  onLine,
  onError = null
} = {}) {
  if (typeof onLine !== "function") throw new TypeError("onLine must be a function");
  const redactLine = typeof redact === "function" ? redact : createRedactor(secretValues);
  const pendingLimit = Number.isInteger(maxPendingChars) && maxPendingChars > 0
    ? maxPendingChars
    : DEFAULT_MAX_PENDING_CHARS;
  let pending = "";
  let discarding = false;

  const emitOutput = (text) => {
    try {
      const prefixed = linePrefix.length > 0 ? `${linePrefix}${text}` : text;
      if (prefixed.length > 0) onLine(prefixed);
    } catch (error) {
      reportError(onError, error);
    }
  };

  const emitLine = (text) => {
    try {
      emitOutput(redactLine(text));
    } catch (error) {
      reportError(onError, error);
    }
  };

  const emitOverflowMarker = () => {
    emitOutput(`[REDACTED] log line exceeded ${pendingLimit} characters\n`);
  };

  const startDiscarding = () => {
    pending = "";
    discarding = true;
    emitOverflowMarker();
  };

  const processText = (text) => {
    let remaining = text;
    while (remaining.length > 0) {
      if (discarding) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) return;
        discarding = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      const newline = remaining.indexOf("\n");
      if (newline === -1) {
        if (pending.length + remaining.length > pendingLimit) {
          startDiscarding();
          return;
        }
        pending += remaining;
        return;
      }

      if (pending.length + newline > pendingLimit) {
        startDiscarding();
        discarding = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      pending += remaining.slice(0, newline + 1);
      emitLine(pending);
      pending = "";
      remaining = remaining.slice(newline + 1);
    }
  };

  return {
    push(chunk) {
      try {
        processText(String(chunk ?? ""));
        return true;
      } catch (error) {
        reportError(onError, error);
        return false;
      }
    },

    flush() {
      try {
        if (discarding) {
          discarding = false;
          pending = "";
          return true;
        }
        if (pending.length === 0) return true;
        const text = pending;
        pending = "";
        emitLine(text);
        return true;
      } catch (error) {
        reportError(onError, error);
        return false;
      }
    }
  };
}

export function secretValuesFromEnv(env) {
  const values = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (
      typeof value === "string"
      && value.length >= 6
      && /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY)$/i.test(key)
    ) {
      values.push(value);
    }
  }
  return values;
}
