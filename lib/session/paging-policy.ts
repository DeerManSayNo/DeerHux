/** 长会话分页默认开启；仅显式设 0 时回滚为完整历史。 */
export function isSessionPagingEnabled(value = process.env.DEERHUX_SESSION_PAGING): boolean {
  return value !== "0";
}

/**
 * 计算最近消息页对应的索引。
 *
 * subagent 会话的首条 user message 是 worker 的完整任务设定。一次工具密集型任务
 * 很容易超过分页上限；若只截取尾部，这条设定会在打开 worker 会话时消失。
 * preserveFirst=true 时为首条消息保留一个名额，其余名额仍用于最新消息。
 */
export function getRecentMessageIndexes(
  total: number,
  limit: number,
  preserveFirst = false,
  preserveBeforeTail: number[] = [],
): number[] {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeLimit = Math.max(1, Math.floor(limit));
  if (safeTotal <= safeLimit) return Array.from({ length: safeTotal }, (_, index) => index);

  const originalTailStart = safeTotal - safeLimit;
  const prefixes = [...new Set([
    ...(preserveFirst ? [0] : []),
    ...preserveBeforeTail,
  ])]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < originalTailStart)
    .sort((a, b) => a - b)
    .slice(0, safeLimit);

  const tailCount = safeLimit - prefixes.length;
  if (tailCount === 0) return prefixes;
  const tailStart = safeTotal - tailCount;
  return [
    ...prefixes,
    ...Array.from({ length: tailCount }, (_, index) => tailStart + index),
  ];
}
