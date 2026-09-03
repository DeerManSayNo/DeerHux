export interface MessageUsageSummary {
  input: number;
  output: number;
  /** Provider-reported internal reasoning tokens; already included in output. */
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

export function formatMessageUsage(usage: MessageUsageSummary): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} 输入`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} 输出`);
  // A reported zero is meaningful: reasoning was observable and none was used.
  // Undefined means a legacy message or a provider without this breakdown.
  if (usage.reasoning !== undefined) parts.push(`${usage.reasoning.toLocaleString()} 推理`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} 缓存读取`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
