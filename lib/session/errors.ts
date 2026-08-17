export const SESSION_PERSISTENCE_ERROR_CODE = "SESSION_PERSIST_FAILED" as const;

/**
 * Session JSONL 是 DeerHux 会话事实来源；关键 entry 写入失败不能降级为 warning。
 * 调用方必须停止当前回合，防止模型基于无法恢复的内存 transcript 继续产生副作用。
 */
export class SessionPersistenceError extends Error {
  readonly code = SESSION_PERSISTENCE_ERROR_CODE;
  readonly operation: string;
  readonly sessionId: string;

  constructor(operation: string, sessionId: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Session persistence failed during ${operation} (session=${sessionId}): ${reason}`);
    this.name = "SessionPersistenceError";
    this.operation = operation;
    this.sessionId = sessionId;
    this.cause = cause;
  }
}

export function isSessionPersistenceError(error: unknown): error is SessionPersistenceError {
  return error instanceof SessionPersistenceError;
}
