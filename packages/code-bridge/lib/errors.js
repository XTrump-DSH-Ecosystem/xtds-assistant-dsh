export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class AlreadyRunningError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlreadyRunningError";
  }
}

export class RepoValidationError extends Error {
  constructor(message = "invalid_repo") {
    super(message);
    this.name = "RepoValidationError";
  }
}

export class WorktreeError extends Error {
  constructor(message = "worktree_error") {
    super(message);
    this.name = "WorktreeError";
  }
}
