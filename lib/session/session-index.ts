/**
 * Session index — the UI query layer.
 *
 * JSONL remains the source of truth. This module materializes a lightweight
 * `session-index.json` that the sidebar can read in O(1) instead of scanning
 * every `.jsonl` file on disk under load.
 *
 * Design (see docs/session-performance-remediation-plan.md §4, §5.1, §6, §8):
 *  - stale-while-revalidate: a valid (even old) index is returned immediately;
 *    stale ones trigger a background rebuild that never blocks the request.
 *  - rebuild is single-flighted via `globalThis.__deerhuxSessionIndexRebuildPromise`.
 *  - writes are atomic (.tmp + rename).
 *  - a corrupt index is quarantined as `session-index.corrupt.<ts>.json`.
 *  - `DEERHUX_SESSION_INDEX=0` bypasses this layer entirely (handled at the
 *    API edge, not here).
 *
 * IMPORTANT: this module must NOT import from `../session-reader` to avoid a
 * circular dependency (session-reader imports this module to hook index
 * invalidation into the existing centralized cache invalidation).
 */

import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { rename, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../types";
import { traceSession } from "./session-trace";

// ---------------------------------------------------------------------------
// Types — mirrors the remediation plan §4.2.1
// ---------------------------------------------------------------------------

export interface SessionIndexFile {
  version: 1;
  generatedAt: string;
  records: SessionIndexRecord[];
  lastRebuildError?: string;
}

export interface SessionIndexRecord {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  lastMessagePreview?: string;
  isSubagent?: boolean;
  parentSessionId?: string;
  parentSessionPath?: string;
  sizeBytes: number;
  mtimeMs: number;
  indexedAt: string;
  dirty?: boolean;
  missing?: boolean;
}

// ---------------------------------------------------------------------------
// In-memory cache + single-flight rebuild lock
// ---------------------------------------------------------------------------

interface SessionIndexMemoryCache {
  index: SessionIndexFile | null;
  loadedAt: number;
  mtimeMs: number;
}

declare global {
  var __deerhuxSessionIndexCache: SessionIndexMemoryCache | undefined;
  var __deerhuxSessionIndexRebuildPromise: Promise<SessionIndexFile> | undefined;
  var __deerhuxSessionIndexRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  var __deerhuxSessionIndexLastRebuildAt: number | undefined;
}

// Changes already invalidate the index explicitly. Time-based staleness is a
// safety-net reconciliation, so it should be infrequent and invisible to UI.
const STALE_MS = 5 * 60_000;
const REBUILD_DEBOUNCE_MS = 1_500; // coalesce rapid invalidate bursts
const REBUILD_MIN_INTERVAL_MS = 1_000; // guard against rebuild thrash

function getMemoryCache(): SessionIndexMemoryCache {
  if (!globalThis.__deerhuxSessionIndexCache) {
    globalThis.__deerhuxSessionIndexCache = { index: null, loadedAt: 0, mtimeMs: 0 };
  }
  return globalThis.__deerhuxSessionIndexCache;
}

function getIndexFilePath(): string {
  return join(getAgentDir(), "session-index.json");
}

function isStale(index: SessionIndexFile | null): boolean {
  if (!index) return true;
  try {
    return Date.now() - new Date(index.generatedAt).getTime() > STALE_MS;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Subagent heuristic — mirrors session-reader.ts isLikelySubagentSession.
// Duplicated (not imported) to keep this module dependency-free of
// session-reader and avoid a cycle.
// ---------------------------------------------------------------------------
function isLikelySubagentSession(s: PiSessionInfo): boolean {
  const firstMessage = String(s.firstMessage ?? "").trim();
  const isWorkerPrompt =
    firstMessage.includes("## 用户总体问题") &&
    (firstMessage.startsWith("你是一个专业代码分析专家") ||
      firstMessage.startsWith("你是一个专业的编程专家"));
  const cwd = String(s.cwd ?? "");
  const isWorkerWorkspace = cwd.includes("/deerhux-runs/") || cwd.includes("/.deerhux/worktrees/");
  return isWorkerPrompt || isWorkerWorkspace;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the index file from disk and refresh the in-memory cache.
 * Returns null when the file does not exist or is corrupt.
 *
 * When corrupt, the file is quarantined and a rebuild is scheduled so the next
 * request can recover automatically.
 */
export async function readSessionIndex(): Promise<SessionIndexFile | null> {
  const path = getIndexFilePath();

  // Fast path: reuse memory cache if the file mtime is unchanged.
  let statMtime = 0;
  try {
    statMtime = statSync(path).mtimeMs;
  } catch {
    // File missing — no index yet.
    getMemoryCache().index = null;
    return null;
  }

  const mem = getMemoryCache();
  if (mem.index && mem.mtimeMs === statMtime) {
    return mem.index;
  }

  let raw: string;
  try {
    raw = await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return null;
  }

  let parsed: SessionIndexFile;
  try {
    parsed = JSON.parse(raw) as SessionIndexFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("invalid index structure");
    }
  } catch (err) {
    // Quarantine corrupt file and rebuild in background. §4.2.3
    quarantineCorruptIndex(path, err);
    scheduleSessionIndexRebuild("corrupt-index");
    getMemoryCache().index = null;
    return null;
  }

  getMemoryCache().index = parsed;
  getMemoryCache().mtimeMs = statMtime;
  getMemoryCache().loadedAt = Date.now();
  return parsed;
}

function quarantineCorruptIndex(path: string, err: unknown): void {
  try {
    const quarantined = `session-index.corrupt.${Date.now()}.json`;
    renameSync(path, join(getAgentDir(), quarantined));
    console.error(`[session-index] quarantined corrupt index → ${quarantined}:`, String(err));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Map index records → SessionInfo for the API layer
// ---------------------------------------------------------------------------

function recordToSessionInfo(r: SessionIndexRecord): SessionInfo {
  const info: SessionInfo = {
    path: r.path,
    id: r.id,
    cwd: r.cwd,
    created: r.created,
    modified: r.modified,
    messageCount: r.messageCount,
    firstMessage: r.firstMessage,
  };
  if (r.name) info.name = r.name;
  if (r.isSubagent) info.isSubagent = true;
  if (r.parentSessionId) info.parentSessionId = r.parentSessionId;
  return info;
}

// ---------------------------------------------------------------------------
// Public query — used by /api/sessions
// ---------------------------------------------------------------------------

export interface ListSessionsFromIndexResult {
  sessions: SessionInfo[];
  stale: boolean;
  rebuilding: boolean;
  /** True only when no usable index exists and the UI must wait for recovery. */
  recovering: boolean;
  warning?: string;
}

/**
 * Read the index and map it to `SessionInfo[]`.
 *
 * Behaviour:
 *  - index present → return its records immediately; if stale, schedule a
 *    background rebuild but DO NOT block.
 *  - index missing → return `{ sessions: [], rebuilding: true }` and schedule a
 *    background rebuild (first-run cold start).
 *  - index corrupt → handled inside readSessionIndex (quarantine + rebuild);
 *    we return the empty+rebuilding shape here.
 */
export async function listSessionsFromIndex(): Promise<ListSessionsFromIndexResult> {
  const index = await readSessionIndex();

  if (!index) {
    // No usable index yet — kick off a rebuild and tell the UI we're building.
    scheduleSessionIndexRebuild("missing-index");
    return { sessions: [], stale: false, rebuilding: true, recovering: true };
  }

  const stale = isStale(index);
  if (stale) {
    scheduleSessionIndexRebuild("stale-index");
  }

  const sessions = index.records.map(recordToSessionInfo);
  return {
    sessions,
    stale,
    rebuilding: Boolean(
      globalThis.__deerhuxSessionIndexRebuildPromise
      || globalThis.__deerhuxSessionIndexRebuildTimer
    ),
    // A stale last-good index remains fully usable while it refreshes.
    recovering: false,
    ...(index.lastRebuildError ? { warning: index.lastRebuildError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Schedule a (debounced, single-flighted) background rebuild. Never throws.
 */
export function scheduleSessionIndexRebuild(reason: string): void {
  // Single-flight across both queued and running rebuilds. Re-arming the timer
  // on every /api/sessions poll can postpone a cold-start rebuild forever.
  if (
    globalThis.__deerhuxSessionIndexRebuildPromise
    || globalThis.__deerhuxSessionIndexRebuildTimer
  ) return;

  // Throttle: avoid rebuild storms.
  const now = Date.now();
  const last = globalThis.__deerhuxSessionIndexLastRebuildAt ?? 0;
  if (now - last < REBUILD_MIN_INTERVAL_MS) {
    // Re-arm after the min interval so a pending burst still gets processed.
    armRebuildTimer(reason, REBUILD_MIN_INTERVAL_MS - (now - last));
    return;
  }

  armRebuildTimer(reason, REBUILD_DEBOUNCE_MS);
}

function armRebuildTimer(reason: string, delayMs: number): void {
  if (globalThis.__deerhuxSessionIndexRebuildTimer) return;
  globalThis.__deerhuxSessionIndexRebuildTimer = setTimeout(() => {
    globalThis.__deerhuxSessionIndexRebuildTimer = undefined;
    void runRebuild(reason).catch((err) => {
      console.error("[session-index] unexpected rebuild failure:", err);
    });
  }, Math.max(0, delayMs));
}

async function runRebuild(reason: string): Promise<SessionIndexFile> {
  // Single-flight lock: if one is already running, await it instead.
  const existing = globalThis.__deerhuxSessionIndexRebuildPromise;
  if (existing) return existing;

  const promise = rebuildSessionIndex().catch((err): SessionIndexFile => {
    // Record the error into the current index (if any) so callers can surface
    // a warning, but keep returning the last-good data.
    console.error(`[session-index] rebuild failed (reason=${reason}):`, err);
    const mem = getMemoryCache();
    if (mem.index) {
      mem.index = { ...mem.index, lastRebuildError: String(err) };
    }
    throw err;
  });

  globalThis.__deerhuxSessionIndexRebuildPromise = promise;
  try {
    return await promise;
  } finally {
    globalThis.__deerhuxSessionIndexRebuildPromise = undefined;
    globalThis.__deerhuxSessionIndexLastRebuildAt = Date.now();
  }
}

/**
 * Rebuild the index from the source of truth (JSONL via SessionManager).
 * Builds records, atomically writes `session-index.json`, and refreshes the
 * in-memory cache. Safe to call directly or via {@link runRebuild}.
 */
export async function rebuildSessionIndex(): Promise<SessionIndexFile> {
  const start = Date.now();
  const [piSessions, sourceFileCount] = await Promise.all([
    SessionManager.listAll() as Promise<PiSessionInfo[]>,
    countSessionSourceFiles(),
  ]);
  assertSessionScanIsCredible(piSessions.length, sourceFileCount);

  const records: SessionIndexRecord[] = piSessions.map((s) => {
    let sizeBytes = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(s.path);
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      /* file may have been removed between listAll and stat */
    }
    const rec: SessionIndexRecord = {
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      sizeBytes,
      mtimeMs,
      indexedAt: new Date().toISOString(),
      ...(s.name ? { name: s.name } : {}),
      ...(s.parentSessionPath ? { parentSessionPath: s.parentSessionPath } : {}),
      ...(isLikelySubagentSession(s) ? { isSubagent: true } : {}),
    };
    return rec;
  });

  const file: SessionIndexFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    records,
  };

  await writeIndexFile(file);

  // Refresh memory cache.
  const path = getIndexFilePath();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    /* ignore */
  }
  const mem = getMemoryCache();
  mem.index = file;
  mem.mtimeMs = mtimeMs;
  mem.loadedAt = Date.now();

  traceSession("rebuildIndex", {
    total: `${Date.now() - start}ms`,
    files: records.length,
    reason: "direct",
  });
  return file;
}

async function writeIndexFile(file: SessionIndexFile): Promise<void> {
  const path = getIndexFilePath();
  const dir = getAgentDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    /* dir likely exists */
  }
  const tmp = join(dir, "session-index.json.tmp");
  const payload = JSON.stringify(file, null, 2);
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, path); // atomic on POSIX
  } catch (err) {
    // Fallback: synchronous write (best effort) so a broken rename doesn't
    // leave the system without an index.
    console.error("[session-index] atomic write failed, falling back to sync:", err);
    try {
      writeFileSync(path, payload, "utf8");
    } catch (fallbackError) {
      throw new Error(
        `Failed to persist session index: ${String(fallbackError)}`,
        { cause: err },
      );
    }
  }
}

/**
 * SessionManager.listAll() deliberately converts broad filesystem/parse
 * failures into an empty or partial array. That is convenient for callers,
 * but unsafe for a materialized index: a transient read failure must never
 * overwrite the last-good index as if every session had been deleted.
 */
async function countSessionSourceFiles(): Promise<number> {
  const sessionsDir = join(getAgentDir(), "sessions");
  let projectDirs;
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw error;
  }

  let count = 0;
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(sessionsDir, entry.name), { withFileTypes: true });
    count += files.filter((file) => file.isFile() && file.name.endsWith(".jsonl")).length;
  }
  return count;
}

function assertSessionScanIsCredible(parsedCount: number, sourceFileCount: number): void {
  if (sourceFileCount > 0 && parsedCount === 0) {
    throw new Error(
      `Session scan returned 0 records while ${sourceFileCount} JSONL files still exist; preserving last-good index`,
    );
  }

  const missingCount = sourceFileCount - parsedCount;
  const toleratedMissing = Math.max(3, Math.ceil(sourceFileCount * 0.05));
  if (missingCount > toleratedMissing) {
    throw new Error(
      `Session scan parsed ${parsedCount}/${sourceFileCount} files; preserving last-good index`,
    );
  }
}

// ---------------------------------------------------------------------------
// Invalidation + incremental maintenance
// ---------------------------------------------------------------------------

/**
 * Mark the index as stale and schedule a debounced background rebuild.
 * Called by session-reader's centralized invalidation so every existing caller
 * (fork, delete, rename, path-cache miss) automatically refreshes the index.
 */
export function invalidateSessionIndex(_reason: string): void {
  // Mark memory cache as stale so listSessionsFromIndex schedules a rebuild.
  const mem = getMemoryCache();
  if (mem.index) {
    mem.index = { ...mem.index, generatedAt: new Date(0).toISOString() };
  }
  scheduleSessionIndexRebuild("invalidate");
}

/**
 * Remove a single record (used on session delete) and persist atomically.
 * Best-effort: on any failure we fall back to a full rebuild via invalidation.
 */
export async function removeSessionIndexRecord(sessionId: string): Promise<void> {
  const index = await readSessionIndex();
  if (!index) {
    scheduleSessionIndexRebuild("remove-record-no-index");
    return;
  }
  const before = index.records.length;
  const next = { ...index, records: index.records.filter((r) => r.id !== sessionId) };
  if (next.records.length === before) {
    return; // nothing to do
  }
  next.generatedAt = new Date().toISOString();
  await writeIndexFile(next);
  const path = getIndexFilePath();
  try {
    getMemoryCache().mtimeMs = statSync(path).mtimeMs;
  } catch {
    /* ignore */
  }
  getMemoryCache().index = next;
}

// Re-exported so callers can pre-warm/force a rebuild without importing
// private helpers.
export function forceRebuildSessionIndex(reason = "force"): Promise<SessionIndexFile> {
  return runRebuild(reason);
}

// Convenience used by tests/dev: detect whether an index file currently exists.
export function sessionIndexExists(): boolean {
  return existsSync(getIndexFilePath());
}
