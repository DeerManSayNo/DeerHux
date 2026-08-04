const MIN_BATCH_TOKENS = 512;

/**
 * 计算单次摘要请求可承载的历史 token。
 *
 * 同一个请求里必须同时容纳：
 * - 当前历史批次
 * - 上一次压缩摘要（滚动压缩时）
 * - 本次摘要输出
 * - 摘要 system prompt / 序列化标签
 *
 * reserveTokens * 2 分别为旧摘要与新摘要各留一份最坏预算。过去这里额外
 * 硬封顶 12k，导致 128k/200k 模型也被拆成多次串行请求；容量现在只由摘要
 * 模型的真实上下文窗口决定。
 */
export function computeCompactionBatchTokenLimit(
  contextWindow: number,
  reserveTokens: number,
): number {
  const safeContextWindow = Math.max(2_048, Math.floor(contextWindow));
  const safeReserveTokens = Math.max(256, Math.floor(reserveTokens));
  const promptReserve = Math.max(1_024, Math.floor(safeContextWindow * 0.125));
  return Math.max(
    MIN_BATCH_TOKENS,
    safeContextWindow - safeReserveTokens * 2 - promptReserve,
  );
}

export function partitionCompactionItems<T>(
  items: readonly T[],
  tokenLimit: number,
  estimateTokens: (item: T) => number,
): T[][] {
  const safeLimit = Math.max(MIN_BATCH_TOKENS, Math.floor(tokenLimit));
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchTokens = 0;

  for (const item of items) {
    const itemTokens = Math.max(0, estimateTokens(item));
    if (batch.length > 0 && batchTokens + itemTokens > safeLimit) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(item);
    batchTokens += itemTokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
