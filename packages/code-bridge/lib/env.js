const SENSITIVE_ENV_NAME = /(qq|gateway|token|secret|password|passwd|api[_-]?key|authorization|auth|credential|cookie)/i;

export function isSensitiveEnvName(name) {
  return SENSITIVE_ENV_NAME.test(name);
}

export function sanitizeEnv(env) {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (isSensitiveEnvName(name)) continue;
    if (typeof value === "string") result[name] = value;
  }
  return result;
}
