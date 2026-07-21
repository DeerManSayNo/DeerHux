export type LlmRequestKind =
  | "main"
  | "subagent"
  | "planner"
  | "aggregator"
  | "compaction"
  | "healthcheck";

export type LlmRequestPriority = "high" | "medium" | "low";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface LlmRequestMeta extends ModelRef {
  apiKeyHash?: string;
  sessionId?: string;
  requestKind: LlmRequestKind;
  priority: LlmRequestPriority;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  maxOutputTokens?: number;
  stream: boolean;
}

export type LlmErrorCode =
  | "RATE_LIMIT_REQUESTS"
  | "RATE_LIMIT_TOKENS"
  | "QUOTA_EXCEEDED"
  | "AUTH_ERROR"
  | "PERMISSION_DENIED"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "SERVER_OVERLOADED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "STREAM_INTERRUPTED"
  | "INVALID_REQUEST"
  | "CONTENT_FILTERED"
  | "LOCAL_QUEUE_TIMEOUT"
  | "LOCAL_QUEUE_FULL"
  | "UPSTREAM_TTFT_TIMEOUT"
  | "UNKNOWN";

export type LlmSuggestedAction =
  | "wait"
  | "switch_model"
  | "change_api_key"
  | "reduce_context"
  | "retry_later";

export interface NormalizedLlmError {
  code: LlmErrorCode;
  message: string;
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  modelId?: string;
  retryable: boolean;
  rawType?: string;
  userMessage: string;
  suggestedAction?: LlmSuggestedAction;
}

export interface LlmThrottleEvent {
  type: "llm_throttle_wait";
  provider: string;
  modelId: string;
  reason: LlmErrorCode;
  delayMs: number;
  attempt: number;
  maxAttempts: number;
  userMessage: string;
}

export interface LlmCircuitOpenEvent {
  type: "llm_circuit_open";
  provider: string;
  modelId: string;
  reason: LlmErrorCode;
  openMs: number;
}

export interface ModelFallbackStartEvent {
  type: "model_fallback_start";
  from: ModelRef;
  to: ModelRef;
  reason: LlmErrorCode;
}

export interface LlmPermit {
  bucketKey: string;
  queuedMs: number;
  release: () => void;
}

export class LlmGatewayError extends Error {
  readonly normalized: NormalizedLlmError;

  constructor(normalized: NormalizedLlmError) {
    super(normalized.message);
    this.name = "LlmGatewayError";
    this.normalized = normalized;
  }
}
