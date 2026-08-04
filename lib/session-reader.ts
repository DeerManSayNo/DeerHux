import { SessionManager, buildSessionContext as piBuildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { statSync } from "fs";
import type { SessionEntry, SessionInfo, SessionContext, SessionHeader, AgentMessage, AssistantMessage, FileReference, SkillReference } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import type { CollaborationRunSnapshot } from "./parallel-agent/collaboration-types";
import { normalizeToolCalls } from "./normalize";
import { extractTurnMode, normalizeAgentMode, stripTurnModeContext, type AgentMode } from "./agent-modes";
import { getWorkerOrigins, pruneWorkerOrigins } from "./parallel-agent/subagent-registry";
import { invalidateSessionIndex, scheduleSessionIndexRebuild } from "./session/session-index";

const SESSION_LIST_TTL_MS = 30_000;
/** Min interval between background refreshes to avoid thundering herd under load. */
const BACKGROUND_REFRESH_COOLDOWN_MS = 8_000;

// ── R17：JSONL 解析大小 / 条目上限 ────────────────────────────────
/** 单个 session 文件的最大字节数（50 MB）。超过拒绝解析，防 OOM。 */
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;
/** 单个 session 文件的最大条目数（10,000）。超过拒绝解析。 */
const MAX_SESSION_ENTRIES = 10_000;
/** Debounce window: batch rapid invalidate() calls into a single background refresh. */
const INVALIDATE_DEBOUNCE_MS = 2_000;

export { getAgentDir };

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

declare global {
  var __deerhuxSessionListCache: {
    sessions: SessionInfo[];
    expiresAt: number;
    inflight?: Promise<SessionInfo[]>;
  } | undefined;
}

function isLikelySubagentSession(s: PiSessionInfo): boolean {
  const firstMessage = String(s.firstMessage ?? "").trim();
  const isWorkerPrompt = firstMessage.includes("## 用户总体问题") && (
    firstMessage.startsWith("你是一个专业代码分析专家") ||
    firstMessage.startsWith("你是一个专业的编程专家")
  );
  const cwd = String(s.cwd ?? "");
  const isWorkerWorkspace = cwd.includes("/deerhux-runs/") || cwd.includes("/.deerhux/worktrees/");
  return isWorkerPrompt || isWorkerWorkspace;
}

async function listAllSessionsUncached(): Promise<SessionInfo[]> {
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const workerOrigins = await getWorkerOrigins();
  // Housekeeping: drop registry entries whose sessions no longer exist on disk.
  void pruneWorkerOrigins(new Set(piSessions.map((s) => s.id)));

  const cache = getPathCache();
  return piSessions.map((s) => {
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    const origin = workerOrigins.get(s.id);
    const isSubagent = Boolean(origin) || isLikelySubagentSession(s);
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      isSubagent: isSubagent ? true : undefined,
      parentSessionId: origin?.parentSessionId ?? (s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined),
    };
  });
}

// ============================================================================
// Background refresh: non-blocking cache updates
// ============================================================================
let _lastBackgroundRefreshAt = 0;
let _backgroundRefreshPromise: Promise<void> | null = null;

function scheduleBackgroundRefresh(): void {
  const now = Date.now();
  if (now - _lastBackgroundRefreshAt < BACKGROUND_REFRESH_COOLDOWN_MS) return;
  if (_backgroundRefreshPromise) return; // already refreshing

  _lastBackgroundRefreshAt = now;
  _backgroundRefreshPromise = listAllSessionsUncached()
    .then((sessions) => {
      globalThis.__deerhuxSessionListCache = {
        sessions,
        expiresAt: Date.now() + SESSION_LIST_TTL_MS,
      };
    })
    .catch((err) => {
      console.error("[session-reader] Background refresh failed:", err);
    })
    .finally(() => {
      _backgroundRefreshPromise = null;
    });
}

/**
 * List all sessions with stale-while-revalidate pattern.
 *
 * Under normal conditions returns cached data immediately. When the cache is
 * stale a *non-blocking* background refresh is scheduled — the stale data is
 * returned right away so the UI never sees a spinner or timeout.
 *
 * Only on the very first call (cold cache) do we block and wait for the full
 * scan. After that every call returns in O(1) time.
 */
export async function listAllSessions(): Promise<SessionInfo[]> {
  const now = Date.now();
  const cached = globalThis.__deerhuxSessionListCache;

  // Stale-while-revalidate: return cached data immediately, refresh in background
  if (cached && cached.sessions.length > 0) {
    if (cached.expiresAt <= now) {
      scheduleBackgroundRefresh();
    }
    return cached.sessions;
  }

  // No cache at all — must wait for the full scan
  if (cached?.inflight) return cached.inflight;

  const inflight = listAllSessionsUncached().then((sessions) => {
    globalThis.__deerhuxSessionListCache = {
      sessions,
      expiresAt: Date.now() + SESSION_LIST_TTL_MS,
    };
    return sessions;
  }).finally(() => {
    const current = globalThis.__deerhuxSessionListCache;
    if (current?.inflight === inflight) {
      delete current.inflight;
    }
  });

  globalThis.__deerhuxSessionListCache = {
    sessions: [],
    expiresAt: 0,
    inflight,
  };
  return inflight;
}

// ============================================================================
// Debounced cache invalidation
// ============================================================================
let _invalidationTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Invalidate the session list cache with debouncing.
 *
 * Instead of immediately clearing the cache (which forces the next read to do
 * a blocking full scan), we mark the cache as expired and schedule a debounced
 * background refresh. This means rapid successive invalidations (e.g. from
 * concurrent prompts, turn completions, and sidebar polling) are coalesced
 * into a single background scan.
 */
export function invalidateSessionListCache(): void {
  // Mark as expired so the next caller knows data may be stale
  const cached = globalThis.__deerhuxSessionListCache;
  if (cached) cached.expiresAt = 0;

  // Cascade into the session index query layer so the sidebar rebuilds its
  // index too. Best-effort: never let an index failure block the in-memory
  // cache invalidation.
  try {
    invalidateSessionIndex("session-list-invalidate");
  } catch (err) {
    console.error("[session-reader] index invalidation failed:", err);
  }

  // Debounce: wait for the burst of invalidations to settle, then refresh once
  if (_invalidationTimer) clearTimeout(_invalidationTimer);
  _invalidationTimer = setTimeout(() => {
    _invalidationTimer = null;
    scheduleBackgroundRefresh();
  }, INVALIDATE_DEBOUNCE_MS);
}

/**
 * Force an immediate cache clear + refresh. Use sparingly — only when the
 * session list has structurally changed (fork, delete, new session creation).
 */
export function forceRefreshSessionList(): void {
  if (_invalidationTimer) {
    clearTimeout(_invalidationTimer);
    _invalidationTimer = null;
  }
  globalThis.__deerhuxSessionListCache = undefined;
  // Fire-and-forget: pre-warm the cache so the next UI read is fast
  listAllSessions().catch(() => {});
  // Cascade: rebuild the index query layer as well.
  try {
    scheduleSessionIndexRebuild("force-refresh");
  } catch (err) {
    console.error("[session-reader] index rebuild schedule failed:", err);
  }
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __deerhuxSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__deerhuxSessionPathCache) globalThis.__deerhuxSessionPathCache = new Map();
  return globalThis.__deerhuxSessionPathCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export function cacheSessionPath(sessionId: string, filePath: string, aliases: readonly string[] = []): void {
  const cache = getPathCache();
  cache.set(sessionId, filePath);
  for (const alias of aliases) {
    if (alias && alias !== sessionId) cache.set(alias, filePath);
  }
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
  invalidateSessionListCache();
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

// ============================================================================
// Per-file read cache: avoid re-parsing the same .jsonl on every API hit.
// Session files are append-only, so (path, mtimeMs, size) uniquely identifies
// the parsed content. Without this cache, every concurrent background refresh
// (agent_end, compaction_end, polling, watchdog) re-reads the file and
// re-runs the CPU-intensive buildSessionContext — enough to pile up and blow
// past the client's fetch timeout on large sessions.
// ============================================================================
interface CachedSessionFile {
  mtimeMs: number;
  size: number;
  entries: SessionEntry[];
  leafId: string | null;
  context: SessionContext;
  header: SessionHeader | null;
  sessionName: string | undefined;
}

declare global {
  var __deerhuxSessionFileCache: Map<string, CachedSessionFile> | undefined;
}

const SESSION_FILE_CACHE_MAX = 64;

function getSessionFileCache(): Map<string, CachedSessionFile> {
  if (!globalThis.__deerhuxSessionFileCache) {
    globalThis.__deerhuxSessionFileCache = new Map();
  }
  return globalThis.__deerhuxSessionFileCache;
}

export function invalidateSessionFileCache(filePath?: string): void {
  const cache = getSessionFileCache();
  if (filePath) {
    cache.delete(filePath);
  } else {
    cache.clear();
  }
}

/**
 * Read and fully parse a session file with caching. Returns parsed entries,
 * resolved context (via buildSessionContext), leaf id, header and session
 * name. Reuses cached result when the file's mtime + size are unchanged so
 * concurrent background refreshes don't each pay the parse + build cost.
 */
export function readSessionFileCached(filePath: string): {
  entries: SessionEntry[];
  leafId: string | null;
  context: SessionContext;
  header: SessionHeader | null;
  sessionName: string | undefined;
} {
  const cache = getSessionFileCache();

  let mtimeMs = 0;
  let size = 0;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // stat failed — fall through to uncached read (will likely throw upstream)
  }

  // ★ R17：文件大小预检查（O(1) 的 statSync，在解析前拦截超大文件防 OOM）
  if (size > MAX_SESSION_FILE_SIZE) {
    throw new Error(
      `Session file too large (${(size / 1024 / 1024).toFixed(1)} MB). ` +
      `Maximum allowed: ${MAX_SESSION_FILE_SIZE / 1024 / 1024} MB.`,
    );
  }

  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Move to end (LRU-ish: most-recently-used last)
    cache.delete(filePath);
    cache.set(filePath, cached);
    return cached;
  }

  const sm = SessionManager.open(filePath);
  const entries = sm.getEntries() as unknown as SessionEntry[];

  // ★ R17：条目数上限检查（双向保护：文件大小 + 条目数）
  if (entries.length > MAX_SESSION_ENTRIES) {
    throw new Error(
      `Session has too many entries (${entries.length}). ` +
      `Maximum allowed: ${MAX_SESSION_ENTRIES}.`,
    );
  }

  const leafId = sm.getLeafId();
  const context = buildSessionContext(entries, leafId);
  const header = sm.getHeader();
  const sessionName = sm.getSessionName();

  const result: CachedSessionFile = { mtimeMs, size, entries, leafId, context, header, sessionName };
  cache.set(filePath, result);

  // LRU eviction: drop oldest entry if over capacity.
  if (cache.size > SESSION_FILE_CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey && oldestKey !== filePath) cache.delete(oldestKey);
  }
  return result;
}

/**
 * Strip large base64 image data from content blocks to keep API responses small.
 * Session files can contain multi-MB base64-encoded images embedded in
 * display_user_message entries. Sending these unchanged over HTTP causes
 * extreme latency and browser parsing overhead.
 *
 * We replace base64 image data with a short placeholder so the frontend can
 * still show image count/type without the payload cost. The frontend renders
 * a lightweight placeholder for images whose data has been stripped.
 */
function stripImageData(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "image") return block;

    const source = b.source as Record<string, unknown> | undefined;
    // URL/file path references are lean — no need to strip them.
    // Only base64-encoded images have large payloads.
    if (source && (source.type === "url" || source.type === "file")) {
      return block;
    }

    // Keep the structure but replace base64 payload with a tiny sentinel.
    // source.data can be 5-10 MB of base64 text; we keep the first ~20 chars
    // so the frontend knows an image was attached without the data bloat.
    if (source && typeof source.data === "string" && source.data.length > 200) {
      return {
        ...b,
        source: { ...source, data: source.data.slice(0, 20) + "…[stripped]" },
        _stripped: true,
      };
    }
    // Legacy flat field
    if (typeof b.data === "string" && b.data.length > 200) {
      return {
        ...b,
        data: b.data.slice(0, 20) + "…[stripped]",
        _stripped: true,
      };
    }
    return block;
  });
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model, roleId: null, agentMode: "agent", collaborationRuns: [] };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model, roleId: null, agentMode: "agent", collaborationRuns: [] };
  }

  const normalizeReferences = (value: unknown): FileReference[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): FileReference[] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || !record.path.trim()) return [];
      const path = record.path.trim();
      const fallbackName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return [{
        path,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : fallbackName,
      }];
    });
  };

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  let roleId: string | null = null;
  let agentMode: AgentMode = "agent";
  // 协作 run 快照：同一个 runId 可能因状态更新被 upsert 多次，这里按出现顺序
  // 覆盖，最终保留每个 runId 在 path 上的最后一条（即最新快照）。
  const collabRunsByRunId = new Map<string, CollaborationRunSnapshot>();
  const turnContextByMessageId = new Map<string, { agentMode?: AgentMode; references?: FileReference[]; skill?: SkillReference }>();
  let pendingTurnContext: { agentMode?: AgentMode; references?: FileReference[]; skill?: SkillReference } | null = null;
  for (const e of path) {
    if (e.type === "custom" && (e as { customType?: string }).customType === "role_profile") {
      const data = (e as { data?: { roleId?: unknown } }).data;
      roleId = typeof data?.roleId === "string" && data.roleId.trim() ? data.roleId.trim() : null;
    }
    if (e.type === "custom" && (e as { customType?: string }).customType === "agent_mode") {
      const data = (e as { data?: { mode?: unknown } }).data;
      agentMode = normalizeAgentMode(data?.mode);
    }
    if (e.type === "custom" && (e as { customType?: string }).customType === "agent_collaboration_run") {
      const data = (e as { data?: CollaborationRunSnapshot }).data;
      if (data && typeof data.runId === "string") {
        collabRunsByRunId.set(data.runId, data);
      }
    }
    if (e.type === "custom" && (e as { customType?: string }).customType === "turn_context") {
      const data = (e as { data?: { mode?: unknown; references?: unknown; skill?: { name?: unknown } } }).data;
      const references = normalizeReferences(data?.references);
      const skillName = typeof data?.skill?.name === "string" && data.skill.name.trim() ? data.skill.name.trim() : null;
      pendingTurnContext = {
        agentMode: normalizeAgentMode(data?.mode),
        ...(references.length ? { references } : {}),
        ...(skillName ? { skill: { name: skillName } } : {}),
      };
    }
    if (e.type === "message" && (e as { message?: { role?: unknown } }).message?.role === "user") {
      if (pendingTurnContext) {
        turnContextByMessageId.set(e.id, pendingTurnContext);
        pendingTurnContext = null;
      }
    }
  }

  // Find the last compaction on path (mirrors DeerHux's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const entryIds: string[] = [];
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    entryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (e.type === "message") entryIds.push(e.id);
    }
  }

  // DeerHux injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const stripInternalUserContext = (content: string): string => {
    return stripTurnModeContext(content)
      .replace(/\n*<image_context source="mcp-vision-fallback">[\s\S]*?<\/image_context>\n*/g, "\n")
      .replace(/\n*注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。\s*/g, "")
      .trim();
  };

  const getDisplayUserMessage = (entryId: string | undefined): { content: unknown; references?: FileReference[]; agentMode?: AgentMode; skill?: SkillReference; clientMessageId?: string } | null => {
    if (!entryId) return null;
    const entry = byId.get(entryId);
    if (!entry?.parentId) return null;
    const parent = byId.get(entry.parentId);
    if (parent?.type !== "custom" || (parent as { customType?: string }).customType !== "display_user_message") return null;
    const data = (parent as { data?: { content?: unknown; references?: unknown; agentMode?: unknown; skill?: { name?: unknown }; clientMessageId?: unknown } }).data;
    if (!data || !("content" in data)) return null;
    const references = normalizeReferences(data.references);
    const skillName = typeof data.skill?.name === "string" && data.skill.name.trim() ? data.skill.name.trim() : null;
    const clientMessageId = typeof data.clientMessageId === "string" && data.clientMessageId.trim() ? data.clientMessageId.trim() : undefined;
    // Strip large base64 image payloads from display content to keep
    // session-load responses lean and avoid multi-second HTTP transfers.
    const displayContent = stripImageData(data.content);
    return {
      content: displayContent,
      ...(references.length ? { references } : {}),
      ...(data.agentMode ? { agentMode: normalizeAgentMode(data.agentMode) } : {}),
      ...(skillName ? { skill: { name: skillName } } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    };
  };

  const messages = (piCtx.messages as AssistantMessage[]).map((msg, index) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    const normalizedBase = normalizeToolCalls(msg);
    // 模型 message 内部的 timestamp 在部分 provider 中表示“请求创建时间”，
    // 最终 assistant 即使实际运行十几秒，也可能只比 user 晚 1–2ms。
    // JSONL entry 外层 timestamp 才是该消息真正落盘完成的时间，统一覆盖给 UI，
    // 供整轮耗时、思考耗时和工具耗时在刷新后准确复算。
    const entryTimestampRaw = entryIds[index] ? byId.get(entryIds[index])?.timestamp : undefined;
    const entryTimestamp = typeof entryTimestampRaw === "string" ? Date.parse(entryTimestampRaw) : NaN;
    const normalized = Number.isNaN(entryTimestamp)
      ? normalizedBase
      : { ...normalizedBase, timestamp: entryTimestamp } as AgentMessage;
    if (normalized.role === "user") {
      const rawContent = typeof normalized.content === "string" ? normalized.content : "";
      const messageMode = extractTurnMode(rawContent) ?? undefined;
      const turnContext = entryIds[index] ? turnContextByMessageId.get(entryIds[index]) : undefined;
      const displayMessage = getDisplayUserMessage(entryIds[index]);
      if (displayMessage) return {
        ...normalized,
        content: displayMessage.content as typeof normalized.content,
        ...(displayMessage.references ?? turnContext?.references ? { references: displayMessage.references ?? turnContext?.references } : {}),
        ...(displayMessage.skill ?? turnContext?.skill ? { skill: displayMessage.skill ?? turnContext?.skill } : {}),
        agentMode: displayMessage.agentMode ?? turnContext?.agentMode ?? messageMode,
        ...(displayMessage.clientMessageId ? { clientMessageId: displayMessage.clientMessageId } : {}),
      };
      if (typeof normalized.content === "string" && (normalized.content.includes('<deerhux_turn_mode') || normalized.content.includes('<image_context source="mcp-vision-fallback">'))) {
        return {
          ...normalized,
          content: stripInternalUserContext(normalized.content),
          ...(turnContext?.references ? { references: turnContext.references } : {}),
          ...(turnContext?.skill ? { skill: turnContext.skill } : {}),
          ...(turnContext?.agentMode || messageMode ? { agentMode: turnContext?.agentMode ?? messageMode } : {}),
        };
      }
      // Strip image base64 data from raw user messages too (not just display_user_message).
      // Session message entries can also embed large base64 images directly in content arrays.
      const strippedContent = stripImageData(normalized.content);
      if (turnContext || messageMode) return {
        ...normalized,
        content: strippedContent as typeof normalized.content,
        ...(turnContext?.references ? { references: turnContext.references } : {}),
        ...(turnContext?.skill ? { skill: turnContext.skill } : {}),
        ...(turnContext?.agentMode || messageMode ? { agentMode: turnContext?.agentMode ?? messageMode } : {}),
      };
      // Always strip image data from user messages to keep API responses lean.
      if (strippedContent !== normalized.content) return { ...normalized, content: strippedContent as typeof normalized.content };
    }
    return normalized;
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    roleId,
    agentMode,
    collaborationRuns: [...collabRunsByRunId.values()],
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}

