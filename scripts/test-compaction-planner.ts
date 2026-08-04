import assert from "node:assert/strict";
import {
  computeCompactionBatchTokenLimit,
  partitionCompactionItems,
} from "../lib/engine/compaction-planner.ts";

// 200k 上下文不应再被 DeerHux 人为压成 12k；44k 的真实样本应单次完成。
{
  const limit = computeCompactionBatchTokenLimit(200_000, 16_384);
  assert.ok(limit > 100_000, `200k 模型单批容量过小: ${limit}`);
  const batches = partitionCompactionItems([11_447, 11_816, 11_827, 9_569], limit, (n) => n);
  assert.equal(batches.length, 1, "44k 摘要输入在 200k 模型上应为单次请求");
}

// 小窗口模型仍需自动降级为多批，不能为追求单次请求而突破上下文窗口。
{
  const limit = computeCompactionBatchTokenLimit(32_000, 6_400);
  assert.equal(limit, 15_200);
  const batches = partitionCompactionItems([8_000, 8_000, 8_000], limit, (n) => n);
  assert.deepEqual(batches, [[8_000], [8_000], [8_000]]);
}

// 单条超大消息无法再切分时必须独占一批；调用方已经负责消息内容截断。
{
  const batches = partitionCompactionItems([20_000, 1_000], 10_000, (n) => n);
  assert.deepEqual(batches, [[20_000], [1_000]]);
}

console.log("compaction planner tests passed");
