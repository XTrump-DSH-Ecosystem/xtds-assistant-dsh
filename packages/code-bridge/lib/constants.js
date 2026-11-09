export const NAME = "code-bridge";
export const VERSION = "0.1.0";
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 9787;
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_QUEUED = 5;
export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_SUMMARY_CHARS = 4000;
export const MAX_CHANGED_FILES = 200;
export const MAX_SESSION_FILE_BYTES = 1024 * 1024;
export const MAX_SESSION_TITLE_CHARS = 200;
export const MAX_SESSION_WORKSPACE_CHARS = 500;
export const DEFAULT_SESSION_LIMIT = 10;
export const MAX_SESSION_LIMIT = 20;

export const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DSH_ARGS = Object.freeze([
  "--profile",
  "headless",
  "--json",
  "--permission-mode",
  "workspace-write",
  "--approval-policy",
  "never"
]);
