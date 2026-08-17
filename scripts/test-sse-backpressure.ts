import assert from "node:assert/strict";
import {
  SSE_HIGH_WATER_MARK_BYTES,
  SSE_MAX_QUEUED_BYTES,
  isSseConsumerOverBudget,
  sseByteStrategy,
} from "../lib/agent-runtime/sse-backpressure.ts";

assert.equal(SSE_HIGH_WATER_MARK_BYTES, 1024 * 1024);
assert.equal(SSE_MAX_QUEUED_BYTES, 8 * 1024 * 1024);
assert.equal(isSseConsumerOverBudget(null), false);
assert.equal(isSseConsumerOverBudget(-SSE_MAX_QUEUED_BYTES + 1), false);
assert.equal(isSseConsumerOverBudget(-SSE_MAX_QUEUED_BYTES), true);
const strategy = sseByteStrategy() as ByteLengthQueuingStrategy;
assert.equal(strategy.highWaterMark, SSE_HIGH_WATER_MARK_BYTES);
assert.equal(strategy.size(new Uint8Array(123)), 123);
console.log("SSE backpressure tests passed");
