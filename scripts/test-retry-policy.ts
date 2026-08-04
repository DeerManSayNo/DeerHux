import assert from "node:assert/strict";
import {
  DefaultRetryPolicy,
  PREMATURE_STREAM_ERROR_RE,
  isCompletedStreamStopReason,
} from "../lib/engine/retry-policy.ts";
import type { NormalizedLlmError } from "../lib/llm-gateway";

const err = (code: NormalizedLlmError["code"], message: string): NormalizedLlmError => ({
  code,
  message,
  retryable: code !== "AUTH_ERROR",
  userMessage: "x",
});

// ── isCompletedStreamStopReason ──────────────────────────────────────────
{
  assert.equal(isCompletedStreamStopReason(undefined), false, "undefined = 流未完成");
  assert.equal(isCompletedStreamStopReason("error"), false, "error = 流未完成");
  assert.equal(isCompletedStreamStopReason("aborted"), false, "aborted = 流未完成");
  assert.equal(isCompletedStreamStopReason("stop"), true, "stop = 已完成");
  assert.equal(isCompletedStreamStopReason("end_turn"), true, "end_turn = 已完成");
  assert.equal(isCompletedStreamStopReason("toolUse"), true, "toolUse = 已完成");
  assert.equal(isCompletedStreamStopReason("length"), true, "length = 已完成");
}

// ── PREMATURE_STREAM_ERROR_RE 覆盖 ──────────────────────────────────────
{
  for (const msg of [
    "connection lost",
    "websocket closed",
    "websocket error",
    "other side closed",
    "stream ended before message_stop",
    "http2 request did not get a response",
    "terminated",
  ]) {
    assert.ok(PREMATURE_STREAM_ERROR_RE.test(msg), `应匹配 premature 流错误: ${msg}`);
  }
  assert.ok(!PREMATURE_STREAM_ERROR_RE.test("模型响应流意外关闭"), "中文诊断不应匹配 premature 正则");
}

const policy = new DefaultRetryPolicy();
const streamInterrupted = err("STREAM_INTERRUPTED", "connection lost");
const authError = err("AUTH_ERROR", "invalid key");

// ── ★ 回归核心：中途断开（已输出大量内容但未收到 done）必须重试 ────────
// 旧实现用 contentLength>=20 会把这种最需要重试的场景误判为"假性流错误"而跳过。
{
  const midStream = policy.isRetryable({
    attempt: 1,
    errorMessage: "websocket closed",
    partialMessage: null,
    contentLength: 500, // 已输出 500 字
    stopReason: undefined, // 但没收到 done —— 流被中途打断
    normalizedError: streamInterrupted,
  });
  assert.equal(midStream.retry, true, "中途断开必须重试（即使已输出 500 字）");
  assert.ok(midStream.delayMs >= 5000, "退避不低于 H2 下限 5s");
}

// ── 静默 EOF（中转站不发送 done/error 直接关连接）必须重试 ────────────────
{
  const silentEof = policy.isRetryable({
    attempt: 1,
    errorMessage: "模型响应流意外关闭：未收到 done 或 error 终止事件",
    partialMessage: null,
    contentLength: 800,
    stopReason: "error", // consumeStream 把协议级 EOF 升级为 error
    normalizedError: streamInterrupted,
  });
  assert.equal(silentEof.retry, true, "静默 EOF 必须重试");
}

// ── 真正的假性流错误：模型已完整回答（收到 done）后的 transport 断开 ────
{
  const completedThenLost = policy.isRetryable({
    attempt: 1,
    errorMessage: "connection lost",
    partialMessage: null,
    contentLength: 1200,
    stopReason: "stop", // 收到 done，模型已完整回答
    normalizedError: streamInterrupted,
  });
  assert.equal(completedThenLost.retry, false, "完整回答后的 connection lost 是假性，不重试");
}

// 工具调用完整输出后的 connection lost 同样是假性
{
  const toolUseThenLost = policy.isRetryable({
    attempt: 1,
    errorMessage: "websocket closed",
    partialMessage: null,
    contentLength: 50,
    stopReason: "toolUse",
    normalizedError: streamInterrupted,
  });
  assert.equal(toolUseThenLost.retry, false, "toolUse 完成后的断开是假性，不重试");
}

// ── 不可重试错误（AUTH_ERROR）不重试 ─────────────────────────────────────
{
  const noRetry = policy.isRetryable({
    attempt: 1,
    errorMessage: "invalid api key",
    partialMessage: null,
    contentLength: 0,
    stopReason: undefined,
    normalizedError: authError,
  });
  assert.equal(noRetry.retry, false, "AUTH_ERROR 不可重试");
}

// ── 超过 maxAttempts（默认 3）不重试 ─────────────────────────────────────
{
  const exhausted = policy.isRetryable({
    attempt: 4,
    errorMessage: "connection lost",
    partialMessage: null,
    contentLength: 0,
    stopReason: undefined,
    normalizedError: streamInterrupted,
  });
  assert.equal(exhausted.retry, false, "超过 maxAttempts 不重试");
}

// ── 退避指数递增（H2，含 ±20% 抖动）──────────────────────────────────
{
  const mk = (attempt: number) => policy.isRetryable({ attempt, errorMessage: "timeout", partialMessage: null, contentLength: 0, stopReason: undefined, normalizedError: streamInterrupted }).delayMs;
  const a1 = mk(1), a2 = mk(2), a3 = mk(3);
  assert.ok(a1 >= 4000 && a1 <= 6000, `attempt1 退避 ~5s(±20%), got ${a1}`);
  assert.ok(a2 >= 8000 && a2 <= 12000, `attempt2 退避 ~10s(±20%), got ${a2}`);
  assert.ok(a3 >= 16000 && a3 <= 24000, `attempt3 退避 ~20s(±20%), got ${a3}`);
  assert.ok(a1 < a2 && a2 < a3, "退避应随 attempt 单调递增");
}

// ── getSettleMs（H4）─────────────────────────────────────────────────────
{
  assert.equal(policy.getSettleMs(), 1000, "H4 settle 默认 1s");
}

// ── TTFT 独立上限：超过 1 次不重试 ───────────────────────────────────────
{
  const ttftRetryable = err("UPSTREAM_TTFT_TIMEOUT", "x");
  const first = policy.isRetryable({ attempt: 1, errorMessage: "ttft", partialMessage: null, contentLength: 0, stopReason: undefined, normalizedError: ttftRetryable });
  assert.equal(first.retry, true, "TTFT 第 1 次可重试");
  const second = policy.isRetryable({ attempt: 2, errorMessage: "ttft", partialMessage: null, contentLength: 0, stopReason: undefined, normalizedError: ttftRetryable });
  assert.equal(second.retry, false, "TTFT 超过 1 次不重试，交由上层切备用模型");
}

console.log("retry-policy tests passed");
