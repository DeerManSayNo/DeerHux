import type { AssistantMessage } from "./types";

const MAX_SAFE_RESERVE_TOKENS = 16_384;
const SAFE_RESERVE_RATIO = 0.2;
const MIN_SAFE_RESERVE_TOKENS = 256;

export interface ContextUsageValue {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
  recentCacheHitRate?: number | null;
  sessionCacheHitRate?: number | null;
}

export interface ContextCacheMetrics {
  usedTokens: number;
  contextWindow: number;
  safeRemainingTokens: number;
  recentCacheHitRate: number | null;
  sessionCacheHitRate: number | null;
}

function promptTokens(usage: AssistantMessage["usage"]): number {
  if (!usage) return 0;
  return Math.max(0, usage.input) + Math.max(0, usage.cacheRead) + Math.max(0, usage.cacheWrite);
}

function cacheHitRate(usage: AssistantMessage["usage"]): number | null {
  if (!usage) return null;
  const total = promptTokens(usage);
  return total > 0 ? Math.max(0, usage.cacheRead) / total : null;
}

export function calculateContextCacheMetrics(
  contextUsage: ContextUsageValue | null | undefined,
  messages: readonly { role: string; usage?: AssistantMessage["usage"]; stopReason?: string }[],
): ContextCacheMetrics | null {
  if (!contextUsage || contextUsage.tokens == null || contextUsage.contextWindow <= 0) return null;

  const validUsages = messages
    .filter((message) => message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error")
    .map((message) => message.usage)
    .filter((usage): usage is NonNullable<AssistantMessage["usage"]> => Boolean(usage) && promptTokens(usage) > 0);

  const recentUsage = validUsages.at(-1);
  const sessionPromptTokens = validUsages.reduce((total, usage) => total + promptTokens(usage), 0);
  const sessionCacheRead = validUsages.reduce((total, usage) => total + Math.max(0, usage.cacheRead), 0);
  const contextWindow = Math.max(1, Math.round(contextUsage.contextWindow));
  const usedTokens = Math.max(0, Math.round(contextUsage.tokens));
  const reserveTokens = Math.max(
    MIN_SAFE_RESERVE_TOKENS,
    Math.min(MAX_SAFE_RESERVE_TOKENS, Math.floor(contextWindow * SAFE_RESERVE_RATIO)),
  );

  return {
    usedTokens,
    contextWindow,
    safeRemainingTokens: Math.max(0, contextWindow - usedTokens - reserveTokens),
    recentCacheHitRate: contextUsage.recentCacheHitRate !== undefined
      ? contextUsage.recentCacheHitRate
      : cacheHitRate(recentUsage),
    sessionCacheHitRate: contextUsage.sessionCacheHitRate !== undefined
      ? contextUsage.sessionCacheHitRate
      : sessionPromptTokens > 0 ? sessionCacheRead / sessionPromptTokens : null,
  };
}
