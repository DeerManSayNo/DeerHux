/**
 * Session message pagination — first-paint acceleration layer.
 *
 * Large sessions used to ship the entire message history on every open,
 * blowing up HTTP payload / JSON parse / React render cost. This layer keeps
 * the existing `buildSessionContext` semantics (correct fork/compaction path)
 * but returns only the most recent N messages so the first paint is cheap.
 * Users can still load the full history on demand.
 *
 * @see docs/session-performance-remediation-plan.md §5.4, TODO 3
 */

import { readSessionFileCached } from "../session-reader";
import { normalizeAgentMode, type AgentMode } from "../agent-modes";
import type { AgentMessage } from "../types";
import { getRecentMessageIndexes, isSessionPagingEnabled } from "./paging-policy";

/**
 * Response shape for GET /api/sessions/:id/messages.
 */
export interface SessionMessagesResult {
  sessionId: string;
  messages: AgentMessage[];
  entryIds: string[];
  totalCount: number;
  /** Runtime meta from buildSessionContext, needed for first-paint header. */
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  roleId?: string | null;
  agentMode?: AgentMode;
  page: {
    /** Requested limit. */
    limit: number;
    /** How many messages were returned in this page. */
    returned: number;
    /** Whether there are older messages not included in this page. */
    hasMoreBefore: boolean;
    /** subagent 长会话是否额外保留了首条任务设定。 */
    preservedFirst?: boolean;
    /** 最近连续窗口之前额外保留的消息数（例如当前回合的 user 起点）。 */
    preservedPrefixCount?: number;
  };
}

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

export { isSessionPagingEnabled } from "./paging-policy";

/**
 * Read the (cached) session file and return only the most recent `limit`
 * messages. Reuses readSessionFileCached so concurrent reads share the parse
 * + build cost; the only added work is the slice.
 *
 * Rollback behaviour: when `DEERHUX_SESSION_PAGING=0` the caller passes a very
 * large limit so ALL messages are returned (effectively disabling the layer).
 */
export function readRecentMessages(
  sessionId: string,
  filePath: string,
  limit: number = DEFAULT_PAGE_LIMIT,
): SessionMessagesResult {
  // When paging is disabled, return the full history in one page. This keeps
  // the frontend code path identical while honouring the rollback flag.
  const pagingOn = isSessionPagingEnabled();
  const { context } = readSessionFileCached(filePath);
  const all = context.messages;
  const effectiveLimit = pagingOn
    ? Math.max(1, Math.min(limit, MAX_PAGE_LIMIT))
    : Math.max(1, all.length);
  const allEntryIds = context.entryIds;
  const total = all.length;

  // Worker 的首条 user message 保存了完整 subagent 设定。工具密集型任务超过
  // 分页上限后仍须保留它，否则点击 worker 卡片只能看到后半段执行记录。
  // registry 可能被旧版本/手工清理，因此同时兼容稳定的 worker prompt 标记。
  const first = all[0];
  const firstText = first?.role === "user" && typeof first.content === "string" ? first.content : "";
  const preserveFirst = firstText.includes("## 用户总体问题") && firstText.includes("## 你负责的子任务");

  // 最近 N 条可能落在一个工具密集回合的中部。若该回合的 user 起点在窗口外，
  // 前端发送时保留的 pending user 无法与快照对账，最终会被错误追加到会话底部。
  // 为当前尾部回合的 user 消息保留一个名额，使首屏既有正确的回合边界，也能
  // 通过 clientMessageId 消除 pending 气泡。
  const rawTailStart = Math.max(0, total - effectiveLimit);
  let tailTurnStart = -1;
  for (let index = rawTailStart; index >= 0; index--) {
    if (all[index]?.role === "user") {
      tailTurnStart = index;
      break;
    }
  }
  const preserveTailTurnStart = tailTurnStart >= 0 && tailTurnStart < rawTailStart;
  const preservedPrefixCount = new Set([
    ...(preserveFirst && total > effectiveLimit ? [0] : []),
    ...(preserveTailTurnStart ? [tailTurnStart] : []),
  ]).size;
  const indexes = getRecentMessageIndexes(
    total,
    effectiveLimit,
    preserveFirst,
    preserveTailTurnStart ? [tailTurnStart] : [],
  );
  const messages = indexes.map((index) => all[index]);
  const entryIds = indexes.map((index) => allEntryIds[index]);

  return {
    sessionId,
    messages,
    entryIds,
    totalCount: total,
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    roleId: context.roleId ?? null,
    agentMode: context.agentMode ? normalizeAgentMode(context.agentMode) : undefined,
    page: {
      limit: effectiveLimit,
      returned: messages.length,
      hasMoreBefore: total > messages.length,
      ...(preserveFirst && total > effectiveLimit ? { preservedFirst: true } : {}),
      ...(preservedPrefixCount > 0 ? { preservedPrefixCount } : {}),
    },
  };
}
