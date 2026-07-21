import assert from "node:assert/strict";
import { calculateBackoffDelayMs } from "../lib/llm-gateway/backoff.ts";
import { classifyLlmError, getLlmUserMessage, isRetryableLlmErrorCode } from "../lib/llm-gateway/error-classifier.ts";
import { parseRetryAfterMs } from "../lib/llm-gateway/retry-after.ts";

const meta = { provider: "openai", modelId: "gpt-test" };

{
  const error = classifyLlmError({ status: 429, message: "tokens per minute exceeded", headers: { "retry-after": "12" } }, meta);
  assert.equal(error.code, "RATE_LIMIT_TOKENS");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 12_000);
}

{
  const error = classifyLlmError({ status: 401, message: "invalid api key" }, meta);
  assert.equal(error.code, "AUTH_ERROR");
  assert.equal(error.retryable, false);
  assert.equal(error.suggestedAction, "change_api_key");
}

{
  const error = classifyLlmError({ message: "insufficient_quota: billing hard limit reached" }, meta);
  assert.equal(error.code, "QUOTA_EXCEEDED");
  assert.equal(error.retryable, false);
}

{
  assert.equal(parseRetryAfterMs("2"), 2_000);
  const delay = calculateBackoffDelayMs({ attempt: 2, baseDelayMs: 5_000, jitterRatio: 0 });
  assert.equal(delay, 10_000);
}

// UPSTREAM_TTFT_TIMEOUT：中转站高峰排队 / 首 token 超时
{
  assert.equal(isRetryableLlmErrorCode("UPSTREAM_TTFT_TIMEOUT"), true);
  const msg = getLlmUserMessage("UPSTREAM_TTFT_TIMEOUT");
  assert.ok(msg.includes("排队"), `expected 排队 in userMessage, got: ${msg}`);
  // suggestedAction 直接派生该码
  const passthrough = classifyLlmError(
    {
      normalized: {
        code: "UPSTREAM_TTFT_TIMEOUT",
        message: "x",
        retryable: true,
        userMessage: msg,
        suggestedAction: "wait",
      },
    },
    meta,
  );
  assert.equal(passthrough.code, "UPSTREAM_TTFT_TIMEOUT");
  assert.equal(passthrough.retryable, true);
  assert.equal(passthrough.suggestedAction, "wait");
}

console.log("llm-gateway tests passed");
