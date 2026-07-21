/**
 * RetryPolicy —— 重试策略接口与默认实现（M4）。
 *
 * 设计文档 §4.4 / §六.M4 的产出。封装原 pi-engine-adapter.ts 的 H2/H3/H4 hack 逻辑：
 *
 * - **H2**（`MIN_AUTO_RETRY_DELAY_MS = 5000`）：最小退避下限，避免 provider 限流风暴。
 *   pi 路径在 `settingsManager.getRetrySettings` 里 clamp；自研 loop 在 {@link DefaultRetryPolicy.isRetryable}
 *   返回的 `delayMs` 里 clamp（>= minDelayMs）。
 * - **H3**（`PREMATURE_STREAM_ERROR_RE` + `contentLength >= 20`）：假性流错误不重试。
 *   Provider 在完整 assistant 消息后仍可能 emit `connection lost` / `websocket closed`，
 *   重试这些场景只会多发一次无意义的 continue。pi 路径在 `_isRetryableError` 里拦截；
 *   自研 loop 在 {@link DefaultRetryPolicy.isRetryable} 里判定。
 * - **H4**（`AUTO_RETRY_SETTLE_MS = 1000`）：重试前静默窗口。让 SSE/tool/agent-end
 *   bookkeeping 有干净的收尾窗口，避免与异步清理路径竞争。pi 路径在 `_prepareRetry`
 *   里 sleep；自研 loop 在 {@link DefaultRetryPolicy.getSettleMs} 返回的 ms 里 sleep。
 *
 * DeerLoopEngine 在 `consumeStreamWithRetry` 里调 {@link RetryPolicy.isRetryable}
 * 判定是否重试、调 {@link RetryPolicy.getSettleMs} 获取重试前静默窗口。
 *
 * 常量与 helper（`getAssistantContentLength` / `sleepMs`）从 pi-engine-adapter.ts
 * 原样搬入，保持行为逐字一致（pi 路径继续用自己的副本，互不依赖）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { calculateBackoffDelayMs, type NormalizedLlmError } from "../llm-gateway";
import { isRetryableLlmErrorCode } from "../llm-gateway/error-classifier";

/**
 * UPSTREAM_TTFT_TIMEOUT 的独立重试上限。
 *
 * 中转站高峰排队时，原路（同模型/同中转站）重试大概率再次排队。这里把 TTFT 超时
 * 的原路重试限制为 1 次（给瞬时抖动一次机会），超过即放弃，由 prompt 主循环发
 * agent_end{errorCode}，让上层（前端 recover / 备用模型链路）接管切换，而不是
 * 在同一个拥堵的上游上反复消耗数十秒。
 */
const TTFT_MAX_RETRY_ATTEMPTS = 1;

// ===========================================================================
// 常量（原样从 pi-engine-adapter.ts:26-33 搬入）
// ===========================================================================

/** H2：最小退避下限（5s）。避免 provider 抖动时 0 退避连环重试。 */
export const MIN_AUTO_RETRY_DELAY_MS = 5000;

/** H4：重试前静默窗口（1s）。给 SSE/tool/agent-end bookkeeping 一个干净的 quiet window。 */
export const AUTO_RETRY_SETTLE_MS = 1000;

/**
 * H3：premature-stream 错误正则。
 *
 * Provider 在完整 assistant 消息后仍可能 emit 这些 transport-close 错误。
 * 重试它们会导致一次无意义的 continue（LLM 已经完整回答了）。
 */
export const PREMATURE_STREAM_ERROR_RE =
  /connection.?lost|websocket.?closed|websocket.?error|other side closed|ended without|stream ended before message_stop|http2 request did not get a response|terminated/i;

// ===========================================================================
// 类型与 helper
// ===========================================================================

/** AssistantMessage 的最小形状（计算内容长度用，兼容 pi-ai 的 AssistantMessage）。 */
type AssistantLike = {
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
};

/** 判断是否为普通对象（与 pi-engine-adapter.ts 同名 helper 一致）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 计算 assistant 消息的有效内容长度（H3 判定用）。
 *
 * 统计 text / thinking block 的 trim 后长度。与 pi-engine-adapter.ts
 * 的同名 helper 逐字一致（pi 路径继续用自己的副本）。
 */
export function getAssistantContentLength(message: AssistantLike): number {
  const content = message.content;
  if (typeof content === "string") return content.trim().length;
  if (!Array.isArray(content)) return 0;

  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") length += block.text.trim().length;
    else if (typeof block.thinking === "string") length += block.thinking.trim().length;
  }
  return length;
}

/** Promise 延时（与 pi-engine-adapter.ts 同名 helper 一致）。 */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// RetryPolicy 接口
// ===========================================================================

/**
 * 重试判定上下文。传给 {@link RetryPolicy.isRetryable}。
 */
export interface RetryContext {
  /** 当前重试序号（1 = 第一次重试，2 = 第二次，...）。初始尝试不调 isRetryable。 */
  attempt: number;
  /** 错误消息（stream errorMessage 或 thrown error.message）。 */
  errorMessage: string;
  /** 失败时最后收到的 partial AssistantMessage（可能 null，如连接都没建立）。 */
  partialMessage: AssistantMessage | null;
  /** 已经收到的有效内容长度（H3 判定用，由 {@link getAssistantContentLength} 计算）。 */
  contentLength: number;
  /** 标准化后的模型错误。传入时优先使用它判断不可重试错误与 Retry-After。 */
  normalizedError?: NormalizedLlmError;
}

/**
 * 重试判定结果。{@link RetryPolicy.isRetryable} 的返回值。
 */
export interface RetryDecision {
  /** 是否重试。false 时 delayMs 被忽略。 */
  retry: boolean;
  /** 重试前等待 ms（H2：>= 5000）。 */
  delayMs: number;
}

/**
 * 重试策略接口（M4 核心）。
 *
 * DeerLoopEngine 在 `consumeStreamWithRetry` 里：
 * 1. 捕获 stream 错误后调 {@link isRetryable} 判定是否重试 + 退避 ms。
 * 2. 若重试，先 sleep {@link getSettleMs}（H4 静默窗口）+ delayMs（H2 退避）。
 * 3. sleep 期间可被 abort 打断（立即停止重试）。
 *
 * DefaultRetryPolicy 封装 H2/H3/H4 全部逻辑，与 pi 路径行为逐字一致。
 */
export interface RetryPolicy {
  /** 最大重试次数（0 = 禁用重试；不含初始尝试，即总尝试 = 1 + maxAttempts）。 */
  readonly maxAttempts: number;
  /** 判定是否重试（H3：premature-stream + contentLength >= 20 → 不重试）。 */
  isRetryable(ctx: RetryContext): RetryDecision;
  /** 重试前的 settle 等待 ms（H4：默认 1000ms）。 */
  getSettleMs(): number;
}

// ===========================================================================
// DefaultRetryPolicy
// ===========================================================================

/** {@link DefaultRetryPolicy} 构造选项。 */
export interface DefaultRetryPolicyOptions {
  /** 最大重试次数（默认 3）。不含初始尝试。 */
  maxAttempts?: number;
  /** 最小退避 ms（H2，默认 {@link MIN_AUTO_RETRY_DELAY_MS} = 5000）。 */
  minDelayMs?: number;
  /** 重试前静默窗口 ms（H4，默认 {@link AUTO_RETRY_SETTLE_MS} = 1000）。 */
  settleMs?: number;
}

/**
 * 默认重试策略：封装 H2/H3/H4 全部判定逻辑。
 *
 * 行为与 pi-engine-adapter.ts 的 `installRetryHardening` hack 逐字一致：
 *
 * - **H2**（退避下限）：`delayMs = max(minDelayMs, minDelayMs * 2^(attempt-1))`。
 *   attempt=1 → 5000ms，attempt=2 → 10000ms，attempt=3 → 20000ms。
 * - **H3**（假性流错误）：`PREMATURE_STREAM_ERROR_RE.test(errorMessage) && contentLength >= 20` → `{retry:false}`。
 * - **H4**（静默窗口）：`getSettleMs()` 返回 settleMs（默认 1000ms）。
 *
 * 构造选项允许覆盖默认值，便于测试（用极小 delay/settle 加速）与灰度（运行时换策略）。
 */
export class DefaultRetryPolicy implements RetryPolicy {
  private readonly _maxAttempts: number;
  private readonly _minDelayMs: number;
  private readonly _settleMs: number;

  constructor(opts?: DefaultRetryPolicyOptions) {
    this._maxAttempts = opts?.maxAttempts ?? 3;
    this._minDelayMs = opts?.minDelayMs ?? MIN_AUTO_RETRY_DELAY_MS;
    this._settleMs = opts?.settleMs ?? AUTO_RETRY_SETTLE_MS;
  }

  get maxAttempts(): number {
    return this._maxAttempts;
  }

  /**
   * 判定是否重试（封装 H3）+ 计算退避（封装 H2）。
   *
   * 判定顺序：
   * 1. 超过 maxAttempts → 不重试（防御性，调用方也会检查）。
   * 2. H3：premature-stream 错误且已有 >= 20 字有效内容 → 不重试。
   * 3. 否则 → 重试，delayMs = max(minDelayMs, 指数退避)。
   */
  isRetryable(ctx: RetryContext): RetryDecision {
    // 1. 超过 maxAttempts → 不重试
    if (ctx.attempt > this._maxAttempts) {
      return { retry: false, delayMs: 0 };
    }
    // 2. H3：premature-stream + 已有有效内容 >= 20 字 → 不重试
    if (
      PREMATURE_STREAM_ERROR_RE.test(ctx.errorMessage) &&
      ctx.contentLength >= 20
    ) {
      return { retry: false, delayMs: 0 };
    }
    // 3. 标准错误分类：quota/auth/context 等不可恢复错误不进入自动重试。
    if (ctx.normalizedError && !isRetryableLlmErrorCode(ctx.normalizedError.code)) {
      return { retry: false, delayMs: 0 };
    }
    // 3b. TTFT 超时：独立、更低的重试上限。中转站排队时原路重试意义有限，
    //     超过 TTFT_MAX_RETRY_ATTEMPTS 即放弃，交由上层切备用模型。
    if (
      ctx.normalizedError?.code === "UPSTREAM_TTFT_TIMEOUT" &&
      ctx.attempt > TTFT_MAX_RETRY_ATTEMPTS
    ) {
      return { retry: false, delayMs: 0 };
    }
    // 4. 可重试：计算退避（H2：>= minDelayMs，指数递增）并尊重 Retry-After。
    const delayMs = calculateBackoffDelayMs({
      attempt: ctx.attempt,
      baseDelayMs: this._minDelayMs,
      retryAfterMs: ctx.normalizedError?.retryAfterMs,
    });
    return { retry: true, delayMs };
  }

  /** H4：重试前静默窗口。 */
  getSettleMs(): number {
    return this._settleMs;
  }
}
