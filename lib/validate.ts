/**
 * 输入验证工具（R16 — Session ID 格式校验）。
 *
 * 对从 URL params 获取的 session id 做严格的格式校验：
 * - 长度 1-128 字符
 * - 仅允许大小写字母、数字、连字符、下划线
 * - 禁止路径穿越字符（..、/、\）
 */

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class SessionIdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionIdValidationError";
  }
}

export function validateSessionId(id: string): string {
  const trimmed = id?.trim() ?? "";
  if (!trimmed) {
    throw new SessionIdValidationError("Session ID is required");
  }
  if (trimmed.length > 128) {
    throw new SessionIdValidationError(
      `Session ID too long: ${trimmed.length} characters (max 128)`,
    );
  }
  if (!SESSION_ID_RE.test(trimmed)) {
    throw new SessionIdValidationError(
      "Session ID contains invalid characters. Allowed: a-z, A-Z, 0-9, -, _",
    );
  }
  // 防御深度：禁止路径穿越（虽已由正则覆盖，但作为额外校验）
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new SessionIdValidationError(
      "Session ID contains invalid path characters",
    );
  }
  return trimmed;
}
