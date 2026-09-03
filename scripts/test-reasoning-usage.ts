import assert from "node:assert/strict";
import { processResponsesStream } from "../node_modules/@earendil-works/pi-ai/dist/providers/openai-responses-shared.js";
import { formatMessageUsage } from "../lib/message-usage.ts";

async function* completedResponse(reasoningTokens: number) {
  yield {
    type: "response.completed",
    response: {
      id: "resp_reasoning_usage_test",
      status: "completed",
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 45,
        output_tokens_details: { reasoning_tokens: reasoningTokens },
        total_tokens: 165,
      },
    },
  };
}

async function collectUsage(reasoningTokens: number) {
  const output = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  const stream = { push() {} };
  const model = {
    id: "test-model",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  await processResponsesStream(
    completedResponse(reasoningTokens) as never,
    output as never,
    stream as never,
    model as never,
  );
  return output.usage as typeof output.usage & { reasoning?: number };
}

const usedReasoning = await collectUsage(32);
assert.equal(usedReasoning.input, 100);
assert.equal(usedReasoning.output, 45);
assert.equal(usedReasoning.reasoning, 32);
assert.equal(usedReasoning.cacheRead, 20);
assert.equal(usedReasoning.totalTokens, 165);
assert.match(formatMessageUsage(usedReasoning), /32 推理/);

const zeroReasoning = await collectUsage(0);
assert.equal(zeroReasoning.reasoning, 0);
assert.match(formatMessageUsage(zeroReasoning), /0 推理/);

assert.doesNotMatch(
  formatMessageUsage({ ...zeroReasoning, reasoning: undefined }),
  /推理/,
);

console.log("reasoning usage tests passed");
