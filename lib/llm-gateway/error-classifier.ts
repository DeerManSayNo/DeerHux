import { extractRetryAfterMs } from "./retry-after.ts";
import type { LlmErrorCode, LlmRequestMeta, LlmSuggestedAction, NormalizedLlmError } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    return firstString(
      error.message,
      error.errorMessage,
      getNested(error, ["error", "message"]),
      getNested(error, ["response", "data", "error", "message"]),
    ) ?? JSON.stringify(error);
  }
  return String(error);
}

function getStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return firstNumber(
    error.status,
    error.statusCode,
    error.code,
    getNested(error, ["response", "status"]),
    getNested(error, ["response", "statusCode"]),
    getNested(error, ["error", "status"]),
  );
}

function getRawType(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return firstString(
    error.type,
    error.code,
    error.name,
    getNested(error, ["error", "type"]),
    getNested(error, ["error", "code"]),
    getNested(error, ["response", "data", "error", "type"]),
    getNested(error, ["response", "data", "error", "code"]),
  );
}

function pickCode(status: number | undefined, rawType: string | undefined, message: string): LlmErrorCode {
  const text = `${rawType ?? ""}\n${message}`.toLowerCase();

  if (/insufficient[_\s-]?quota|quota.?exceeded|billing.?hard.?limit|credit.?balance|余额不足|额度不足/.test(text)) {
    return "QUOTA_EXCEEDED";
  }
  if (status === 401 || /invalid.?api.?key|unauthorized|authentication|auth.?error|api key.*invalid/.test(text)) {
    return "AUTH_ERROR";
  }
  if (status === 403 || /permission.?denied|forbidden|not.?allowed|model.*not.*available|access.*denied/.test(text)) {
    return "PERMISSION_DENIED";
  }
  if (/context.?length|maximum context|token.*limit|prompt.*too.?long|context window|input.*too.?large/.test(text)) {
    return "CONTEXT_LENGTH_EXCEEDED";
  }
  if (/content.?filter|safety|policy.?violation|blocked by policy/.test(text)) {
    return "CONTENT_FILTERED";
  }
  if (status === 429 || /rate.?limit|too many requests|requests.?per.?minute|\brpm\b/.test(text)) {
    if (/token.?s.?per.?minute|\btpm\b|tokens.?per.?min|token rate/.test(text)) {
      return "RATE_LIMIT_TOKENS";
    }
    return "RATE_LIMIT_REQUESTS";
  }
  if (/overloaded|capacity|server busy|temporar(?:y|ily).*unavailable|try again later/.test(text)) {
    return "SERVER_OVERLOADED";
  }
  if (status && status >= 500 && status <= 599) {
    return status === 503 ? "SERVER_OVERLOADED" : "SERVER_ERROR";
  }
  if (/timeout|timed out|deadline exceeded|etimedout/.test(text)) {
    return "TIMEOUT";
  }
  if (/connection.?lost|websocket.?closed|websocket.?error|other side closed|http2|terminated|socket hang up|econnreset|network/.test(text)) {
    return "STREAM_INTERRUPTED";
  }
  if (status === 400 || /invalid.?request|bad request|malformed/.test(text)) {
    return "INVALID_REQUEST";
  }
  return "UNKNOWN";
}

export function isRetryableLlmErrorCode(code: LlmErrorCode): boolean {
  return (
    code === "RATE_LIMIT_REQUESTS" ||
    code === "RATE_LIMIT_TOKENS" ||
    code === "SERVER_OVERLOADED" ||
    code === "SERVER_ERROR" ||
    code === "TIMEOUT" ||
    code === "NETWORK_ERROR" ||
    code === "STREAM_INTERRUPTED" ||
    code === "LOCAL_QUEUE_TIMEOUT" ||
    code === "UPSTREAM_TTFT_TIMEOUT"
  );
}

function suggestedActionFor(code: LlmErrorCode): LlmSuggestedAction | undefined {
  switch (code) {
    case "RATE_LIMIT_REQUESTS":
    case "RATE_LIMIT_TOKENS":
    case "SERVER_OVERLOADED":
    case "SERVER_ERROR":
    case "TIMEOUT":
    case "NETWORK_ERROR":
    case "STREAM_INTERRUPTED":
    case "LOCAL_QUEUE_TIMEOUT":
    case "UPSTREAM_TTFT_TIMEOUT":
      return "wait";
    case "QUOTA_EXCEEDED":
      return "change_api_key";
    case "AUTH_ERROR":
      return "change_api_key";
    case "PERMISSION_DENIED":
      return "switch_model";
    case "CONTEXT_LENGTH_EXCEEDED":
      return "reduce_context";
    case "LOCAL_QUEUE_FULL":
      return "retry_later";
    default:
      return undefined;
  }
}

export function getLlmUserMessage(code: LlmErrorCode, retryAfterMs?: number): string {
  const waitSeconds = retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
  switch (code) {
    case "RATE_LIMIT_REQUESTS":
      return waitSeconds
        ? `服务商请求频率限流，建议等待约 ${waitSeconds} 秒后重试。`
        : "服务商请求频率限流，请稍后重试。";
    case "RATE_LIMIT_TOKENS":
      return waitSeconds
        ? `模型 token 吞吐达到上限，建议等待约 ${waitSeconds} 秒后重试。`
        : "模型 token 吞吐达到上限，建议压缩上下文或稍后重试。";
    case "QUOTA_EXCEEDED":
      return "当前 API Key 额度不足或账单达到上限，请更换 Key、充值，或切换其他模型。";
    case "AUTH_ERROR":
      return "当前 API Key 无效或认证失败，请检查模型配置中的 Key。";
    case "PERMISSION_DENIED":
      return "当前账号或 API Key 没有访问该模型的权限，请切换模型或检查权限。";
    case "CONTEXT_LENGTH_EXCEEDED":
      return "当前上下文超过模型窗口，请压缩会话或减少输入内容后重试。";
    case "SERVER_OVERLOADED":
      return "当前模型服务繁忙，请稍后重试。";
    case "SERVER_ERROR":
      return "模型服务暂时异常，请稍后重试。";
    case "TIMEOUT":
      return "模型请求超时，请稍后重试。";
    case "NETWORK_ERROR":
    case "STREAM_INTERRUPTED":
      return "模型连接中断，请稍后重试或切换模型。";
    case "LOCAL_QUEUE_TIMEOUT":
      return "本地限流队列等待超时，请稍后重试。";
    case "LOCAL_QUEUE_FULL":
      return "本地限流队列已满，请稍后重试。";
    case "UPSTREAM_TTFT_TIMEOUT":
      return "模型服务长时间未返回首个响应，可能正在排队，正在等待后自动重试。";
    case "CONTENT_FILTERED":
      return "模型服务因安全策略拒绝了本次请求，请调整输入内容后重试。";
    case "INVALID_REQUEST":
      return "模型请求参数无效，请调整输入或模型配置后重试。";
    default:
      return "模型调用失败，请稍后重试或切换模型。";
  }
}

export function classifyLlmError(error: unknown, meta?: Partial<LlmRequestMeta>): NormalizedLlmError {
  if (error && typeof error === "object" && "normalized" in error) {
    const normalized = (error as { normalized?: unknown }).normalized;
    if (isRecord(normalized) && typeof normalized.code === "string") {
      return normalized as unknown as NormalizedLlmError;
    }
  }

  const message = getErrorMessage(error);
  const status = getStatus(error);
  const rawType = getRawType(error);
  const retryAfterMs = extractRetryAfterMs(error) ?? undefined;
  const code = pickCode(status, rawType, message);
  const retryable = isRetryableLlmErrorCode(code);
  return {
    code,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(meta?.provider ? { provider: meta.provider } : {}),
    ...(meta?.modelId ? { modelId: meta.modelId } : {}),
    retryable,
    ...(rawType ? { rawType } : {}),
    userMessage: getLlmUserMessage(code, retryAfterMs),
    suggestedAction: suggestedActionFor(code),
  };
}
