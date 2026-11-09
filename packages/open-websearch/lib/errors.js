export class LauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
  }
}

export class AlreadyRunningError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AlreadyRunningError";
    this.details = details;
  }
}
