export function createLogger({ redact = (value) => String(value), stream = process.stdout } = {}) {
  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${redact(message)}\n`;
    stream.write(line);
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message)
  };
}
