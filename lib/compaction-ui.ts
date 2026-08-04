/** 与历史 DeerLoopEngine.compactBeforePromptIfNeeded 阈值对齐。 */
export const COMPACTION_THRESHOLD = 0.7;

export const COMPACTION_MODEL_STORAGE_KEY = "deerhux.compactionModel";

export type CompactionModelRef = { provider: string; modelId: string };

export type CompactionProgressPhase =
  | "preparing"
  | "summarizing"
  | "archiving"
  | "applying"
  | "done";

export type CompactionProgress = {
  phase: CompactionProgressPhase;
  message: string;
  batchIndex?: number;
  batchTotal?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  model?: CompactionModelRef;
  updatedAt: number;
};

export function readStoredCompactionModel(): CompactionModelRef | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COMPACTION_MODEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CompactionModelRef>;
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      return { provider: parsed.provider, modelId: parsed.modelId };
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

export function writeStoredCompactionModel(model: CompactionModelRef): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMPACTION_MODEL_STORAGE_KEY, JSON.stringify(model));
  } catch {
    // ignore quota / private mode
  }
}

export function needsCompaction(usage: {
  percent?: number | null;
  tokens?: number | null;
  contextWindow?: number;
} | null | undefined): boolean {
  if (!usage) return false;
  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return usage.percent >= COMPACTION_THRESHOLD;
  }
  if (
    typeof usage.tokens === "number"
    && typeof usage.contextWindow === "number"
    && usage.contextWindow > 0
  ) {
    return usage.tokens / usage.contextWindow >= COMPACTION_THRESHOLD;
  }
  return false;
}

export function formatContextUsage(usage: {
  percent?: number | null;
  tokens?: number | null;
  contextWindow?: number;
} | null | undefined): string {
  if (!usage) return "未知";
  const pct = typeof usage.percent === "number"
    ? usage.percent
    : (usage.tokens && usage.contextWindow)
      ? usage.tokens / usage.contextWindow
      : null;
  const pctText = pct != null ? `${Math.round(pct * 100)}%` : "—";
  if (typeof usage.tokens === "number" && typeof usage.contextWindow === "number") {
    return `${pctText}（约 ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens）`;
  }
  return pctText;
}
