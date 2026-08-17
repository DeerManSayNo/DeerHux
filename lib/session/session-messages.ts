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
import { isSessionPagingEnabled } from "./paging-policy";

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

  // The most recent N messages sit at the tail of the array. entryIds is
  // parallel to messages, so we slice the same window.
  const start = Math.max(0, total - effectiveLimit);
  const messages = all.slice(start);
  const entryIds = allEntryIds.slice(start);

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
      hasMoreBefore: start > 0,
    },
  };
}
