import assert from "node:assert/strict";
import {
  buildUpstreamKey,
  isUpstreamCoolingDown,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  upstreamCooldownRemainingMs,
} from "../lib/llm-gateway/upstream-health.ts";

const ref = { provider: "openai", modelId: "gpt-test" };
const key = buildUpstreamKey(ref, "k1");

{
  // 1 次失败不冷却
  recordUpstreamFailure(ref, "k1", "UPSTREAM_TTFT_TIMEOUT", 1_000);
  assert.equal(isUpstreamCoolingDown(ref, "k1", 1_001), false);
  // 2 次连续失败（窗口内）→ 冷却
  recordUpstreamFailure(ref, "k1", "UPSTREAM_TTFT_TIMEOUT", 1_002);
  assert.equal(isUpstreamCoolingDown(ref, "k1", 1_003), true);
  // 冷却剩余时间合理（base 30s）
  const remain = upstreamCooldownRemainingMs(ref, "k1", 1_003);
  assert.ok(remain > 20_000 && remain <= 30_000, `unexpected remain ${remain}`);
  // 冷却到期后不再冷却
  assert.equal(isUpstreamCoolingDown(ref, "k1", 1_003 + 31_000), false);
}

{
  // 非 trigger 错误不计入连续失败
  recordUpstreamFailure(ref, "k2", "AUTH_ERROR", 1_000);
  assert.equal(isUpstreamCoolingDown({ provider: "openai", modelId: "gpt-test" }, "k2", 1_001), false);
}

{
  // 成功清零冷却
  recordUpstreamFailure({ provider: "anthropic", modelId: "claude" }, "k3", "SERVER_OVERLOADED", 1_000);
  recordUpstreamFailure({ provider: "anthropic", modelId: "claude" }, "k3", "SERVER_OVERLOADED", 1_001);
  assert.equal(isUpstreamCoolingDown({ provider: "anthropic", modelId: "claude" }, "k3", 1_002), true);
  recordUpstreamSuccess({ provider: "anthropic", modelId: "claude" }, "k3", 1_003);
  assert.equal(isUpstreamCoolingDown({ provider: "anthropic", modelId: "claude" }, "k3", 1_004), false);
}

void key; // key 仅用于可读性，避免 unused 警告
console.log("upstream-health tests passed");
