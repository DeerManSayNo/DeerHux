/**
 * DeerHux 灵动岛 bridge.
 *
 * DeerHux hosts its own dynamic-island overlay (see `src-tauri/src/live_island.rs`).
 * This module is the Node-side producer: it turns agent engine events into island
 * rows and pushes them to the Tauri host through the `live_island_push_events`
 * command.
 *
 * Design constraints (DeerHux runs many sessions concurrently in one process):
 *
 *  - One shared state map keyed by session id. N wrappers may call into this
 *    module at any time; each call only touches its own session entry.
 *  - All timestamps are absolute epoch ms computed here, never in the host. The
 *    host merges idempotently, so a batched/delayed flush cannot skew elapsed
 *    time or resurrect stale rows.
 *  - Events are coalesced into micro-batches and flushed off the hot path, so
 *    streaming sessions never block on IPC and a burst of tool calls collapses
 *    into a single push.
 *  - Rows are dropped when their session is destroyed, so a long-lived process
 *    with churning sessions cannot leak island rows.
 *  - The pill's timer is a per-step timer, not a whole-run timer: every model
 *    round and every tool call restarts `detailStartedAt`, and the row freezes
 *    it when the step ends (`frozenDetailElapsed`). `startedAt` still carries
 *    the run start, which the host keeps for dismiss bookkeeping only.
 */

import { basename } from "node:path";
import { hostEventBus } from "./host-event-bus.ts";
import type { AgentEvent } from "./rpc-manager";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DONE_RETRACT_MS = 5_000;
const MAX_DETAIL_LENGTH = 56;
const FLUSH_INTERVAL_MS = 80;
const DEERHUX_APP_NAME = "DeerHux";

// ---------------------------------------------------------------------------
// Types (mirroring src-tauri/src/live_island.rs)
// ---------------------------------------------------------------------------

export type LiveIslandRowStatus =
  | "thinking" | "reading" | "editing" | "writing"
  | "running" | "searching" | "done" | "interrupted" | "error" | "waiting";

export type LiveIslandScale = "small" | "medium" | "large" | "xlarge";

interface LiveIslandMessage {
  id: string;
  type: "update" | "remove" | "done-retract";
  project?: string;
  status?: LiveIslandRowStatus;
  detail?: string;
  prompt?: string;
  startedAt?: number;
  lastActiveAt?: number;
  detailStartedAt?: number;
  frozenElapsed?: number | null;
  frozenDetailElapsed?: number | null;
  delayMs?: number;
  cwd?: string;
}

/** Mirrors the host's `LiveIslandRow` after merge. */
export interface LiveIslandRow {
  id: string;
  project: string;
  status: LiveIslandRowStatus;
  detail: string;
  prompt: string;
  startedAt: number;
  lastActiveAt: number;
  detailStartedAt: number;
  frozenElapsed?: number | null;
  frozenDetailElapsed?: number | null;
  cwd?: string | null;
}

export interface LiveIslandSnapshot {
  rows: LiveIslandRow[];
  scale: LiveIslandScale;
  layout: { hasNotch: boolean; notchWidth: number };
  enabled: boolean;
}

interface SessionState {
  id: string;
  cwd: string;
  project: string;
  prompt: string;
  /** Run start. Only used by the host for dismiss bookkeeping. */
  startedAt: number;
  lastActiveAt: number;
  /** Start of the step the pill is currently timing (model round or tool call). */
  detailStartedAt: number;
  islandStatus: LiveIslandRowStatus;
  islandDetail: string;
  finished: boolean;
  frozenElapsed: number | null;
  frozenDetailElapsed: number | null;
  activeToolCount: number;
  /** Tool call ids whose `tool_execution_end` has not arrived yet. */
  activeToolIds: Set<string>;
  /** Set from `message_start`, cleared once the model round stops producing. */
  modelStreaming: boolean;
  /** Set when the row changed since the last flush. */
  dirty: boolean;
  /** Set when the session must disappear from the island entirely. */
  dropped: boolean;
}

const MODEL_THINKING_DETAIL = `Thinking · ${DEERHUX_APP_NAME}`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(input: string, max: number): string {
  const compact = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function nowMs(): number {
  return Date.now();
}

const META_DIRS = new Set([
  ".claude", ".cursor", ".codex", ".hermes", ".openclaw",
  ".deerhux", ".config", ".local", "src", "lib", "app",
]);

function projectNameFromCwd(cwd: string): string {
  if (!cwd) return DEERHUX_APP_NAME;
  const trimmed = cwd.replace(/\/+$/, "");
  const name = basename(trimmed);
  if (name && !META_DIRS.has(name)) return name;
  const parts = trimmed.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && !META_DIRS.has(parts[i])) return parts[i];
  }
  return name || DEERHUX_APP_NAME;
}

// ---------------------------------------------------------------------------
// Tool → island status
// ---------------------------------------------------------------------------

function toolToStatus(
  toolName: string,
  input: Record<string, unknown> = {},
): { status: LiveIslandRowStatus; detail: string } {
  const name = String(toolName ?? "").toLowerCase();
  const mcpShort = name.startsWith("mcp__")
    ? name.split("__").filter(Boolean).slice(1).join(" · ")
    : name;
  const fileArg = String(input.file_path ?? input.path ?? "");
  const fileLabel = fileArg ? basename(fileArg) : "file";

  if (name === "read" || name.endsWith("_read")) {
    return { status: "reading", detail: truncate(`Read · ${fileLabel}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "edit" || name.endsWith("_edit")) {
    return { status: "editing", detail: truncate(`Edit · ${fileLabel}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "write" || name.endsWith("_write")) {
    return { status: "writing", detail: truncate(`Write · ${fileLabel}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "bash" || name.endsWith("_bash") || name === "execute_command") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
    return { status: "running", detail: truncate(`Bash · ${cmd || "shell"}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "grep" || name.includes("search_content") || name.includes("code_search")) {
    return { status: "searching", detail: truncate(`Grep · ${String(input.pattern ?? input.query ?? "text")}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "find" || name === "ls" || name === "list_files" || name === "glob" || name.includes("search_file")) {
    return { status: "searching", detail: truncate(`Search · ${fileLabel === "file" ? "files" : fileLabel}`, MAX_DETAIL_LENGTH) };
  }
  if (name === "task" || name === "agent" || name.includes("subagent")) {
    return { status: "running", detail: truncate(`Task · ${String(input.description ?? "sub-agent")}`, MAX_DETAIL_LENGTH) };
  }
  return { status: "running", detail: truncate(`${mcpShort} · tool`, MAX_DETAIL_LENGTH) };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Transport seam. The default implementation talks to the Tauri host; tests
 * inject a recorder that captures batches without a desktop runtime.
 */
export type LiveIslandTransport = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

async function defaultTransport(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (cmd !== "live_island_push_events") return null;
  const events = (args?.events ?? []) as LiveIslandMessage[];
  hostEventBus.emit({ type: "live_island_events", events, updatedAt: Date.now() });
  return null;
}

export class LiveIslandBridge {
  private sessions = new Map<string, SessionState>();
  private outbox: LiveIslandMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private available = true;
  private logPrefix = "[deerhux-live-island]";

  /** Serializes pushes so out-of-order IPC completion cannot interleave batches. */
  private pushChain: Promise<void> = Promise.resolve();

  /** Overrides Tauri IPC in tests. */
  private transport: LiveIslandTransport | null;

  constructor(transport: LiveIslandTransport | null = null) {
    this.transport = transport;
  }

  private log(msg: string): void {
    console.error(`${this.logPrefix} ${msg}`);
  }

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    if (!this.available) return null;
    try {
      const call = this.transport ?? defaultTransport;
      return (await call(cmd, args)) as T;
    } catch (error) {
      // Browser dev, or the host rejected the call: disable further attempts
      // rather than spamming on every event.
      this.available = false;
      this.log(`invoke ${cmd} failed, bridge disabled: ${String(error)}`);
      return null;
    }
  }

  // ---- Lifecycle ----

  /** Idempotent. Safe to call from any session wrapper. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  /** Register a session. Called by AgentSessionWrapper.start(). */
  trackSession(sessionId: string, cwd: string): void {
    if (this.sessions.has(sessionId)) return;
    const now = nowMs();
    const project = projectNameFromCwd(cwd);
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      project,
      prompt: "",
      startedAt: now,
      lastActiveAt: now,
      detailStartedAt: now,
      islandStatus: "thinking",
      islandDetail: "Ready",
      finished: false,
      frozenElapsed: null,
      frozenDetailElapsed: null,
      activeToolCount: 0,
      activeToolIds: new Set(),
      modelStreaming: false,
      dirty: false,
      dropped: true,
    });
  }

  /** Record the user's prompt text — call BEFORE inner.prompt(). */
  recordPrompt(sessionId: string, promptText: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.prompt = truncate(promptText, 48);
  }

  /** Release a session's row. Called when the wrapper is destroyed. */
  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.enqueue({ id: sessionId, type: "remove" });
  }

  /** Handle an agent event for a session. */
  handleEvent(sessionId: string, cwd: string, event: AgentEvent): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // Auto-track (resumed sessions may emit before start() runs).
      this.trackSession(sessionId, cwd);
      session = this.sessions.get(sessionId);
      if (!session) return;
    }
    if (cwd) session.cwd = cwd;

    switch (event.type) {
      case "agent_start":
        this.handleAgentStart(session);
        break;
      case "agent_end":
        this.handleAgentEnd(session);
        break;
      case "message_start":
        if (!session.modelStreaming) this.beginStep(session, "thinking", MODEL_THINKING_DETAIL);
        break;
      case "message_end":
        // The model round ended: freeze its timer (which for a tool-calling round
        // covers the model's own thinking time) until the next step starts.
        session.modelStreaming = false;
        this.freezeStep(session);
        break;
      case "tool_execution_start":
        this.handleToolStart(session, event);
        break;
      case "tool_execution_end":
        this.handleToolEnd(session, event);
        break;
    }
  }

  // ---- Batch transport ----

  private enqueue(message: LiveIslandMessage): void {
    this.outbox.push(message);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Never hold the event loop open just to ship island rows.
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];

    // Coalesce only *replaceable* messages: consecutive renders of the same
    // row collapse to the newest one. Control messages (`remove`,
    // `done-retract`) are never dropped — a `done-retract` carries the retract
    // delay the host needs, and a `remove` must survive a preceding update.
    const events: LiveIslandMessage[] = [];
    const pendingRender = new Map<string, number>();

    for (const message of batch) {
      if (message.type === "update") {
        const at = pendingRender.get(message.id);
        if (at !== undefined) {
          events[at] = message;
          continue;
        }
        pendingRender.set(message.id, events.length);
        events.push(message);
        continue;
      }
      // A control message closes any pending render for that row.
      pendingRender.delete(message.id);
      events.push(message);
    }

    // Every frame is also a reconnect baseline: include the latest row for
    // sessions that did not change in this batch. The browser can reconnect at
    // any time and still reconstruct all concurrent rows from one frame.
    const updatedIds = new Set(
      events.filter((event) => event.type === "update").map((event) => event.id),
    );
    for (const session of this.sessions.values()) {
      if (!session.dropped && !updatedIds.has(session.id)) {
        events.push(this.buildUpdate(session));
      }
    }

    if (!events.length) return;
    this.pushChain = this.pushChain
      .then(async () => {
        await this.invoke("live_island_push_events", { events });
      })
      .catch((error) => {
        this.log(`flush failed: ${String(error)}`);
      });
    await this.pushChain;
  }

  /** Force any pending rows out immediately. Used on shutdown. */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ---- Event handlers ----

  private buildUpdate(session: SessionState): LiveIslandMessage {
    return {
      id: session.id,
      type: "update",
      project: session.project,
      status: session.islandStatus,
      detail: session.islandDetail,
      prompt: session.prompt || session.islandDetail,
      startedAt: session.startedAt,
      lastActiveAt: session.lastActiveAt,
      detailStartedAt: session.detailStartedAt,
      frozenElapsed: session.finished ? session.frozenElapsed : null,
      // The step timer keeps ticking while running and is replaced wholesale by
      // `done`'s frozen value at the end of the turn.
      frozenDetailElapsed: session.frozenDetailElapsed,
      cwd: session.cwd,
    };
  }

  /**
   * Start timing a new step (model round or tool call): the pill restarts from
   * 0s. Reasoning to the *same* detail text (for example the second parallel
   * tool of an identical call) keeps the running clock instead of resetting it.
   */
  private beginStep(
    session: SessionState,
    status: LiveIslandRowStatus,
    detail: string,
  ): void {
    const now = nowMs();
    session.lastActiveAt = now;
    session.finished = false;
    session.dropped = false;
    if (session.islandDetail !== detail || session.frozenDetailElapsed !== null) {
      session.detailStartedAt = now;
      session.frozenDetailElapsed = null;
    }
    session.islandStatus = status;
    session.islandDetail = detail;
    this.enqueue(this.buildUpdate(session));
  }

  /** Stop the step clock and keep the final reading until the next step starts. */
  private freezeStep(session: SessionState): void {
    if (session.frozenDetailElapsed !== null) return;
    const now = nowMs();
    session.lastActiveAt = now;
    session.frozenDetailElapsed = Math.max(0, now - session.detailStartedAt);
    this.enqueue(this.buildUpdate(session));
  }

  private handleAgentStart(session: SessionState): void {
    // Remove the row first so the host clears any pending done-retract deadline
    // left by the previous run of this same session.
    this.enqueue({ id: session.id, type: "remove" });

    session.finished = false;
    session.activeToolCount = 0;
    session.activeToolIds.clear();
    session.modelStreaming = false;
    session.frozenElapsed = null;
    session.frozenDetailElapsed = null;
    session.startedAt = nowMs();
    session.lastActiveAt = session.startedAt;
    session.detailStartedAt = session.startedAt;
    session.islandStatus = "thinking";
    session.islandDetail = MODEL_THINKING_DETAIL;
    session.dropped = false;

    this.enqueue(this.buildUpdate(session));
  }

  private handleAgentEnd(session: SessionState): void {
    if (session.finished) return;
    session.finished = true;
    const now = nowMs();
    session.lastActiveAt = now;
    session.activeToolIds.clear();
    session.modelStreaming = false;
    session.frozenElapsed = now - session.startedAt;
    // Keep the last step's reading so the completed pill shows that step's time.
    session.frozenDetailElapsed = Math.max(0, now - session.detailStartedAt);
    session.islandStatus = "done";
    session.islandDetail = "Done · 完成";

    this.enqueue(this.buildUpdate(session));
    this.enqueue({ id: session.id, type: "done-retract", delayMs: DONE_RETRACT_MS });
    // The explicit update above remains visible until the host's retract
    // deadline. Exclude it from later reconnect baselines so an expired row
    // cannot be recreated without a matching done-retract event.
    session.dropped = true;
  }

  private handleToolStart(session: SessionState, event: AgentEvent): void {
    session.activeToolCount++;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (toolCallId) session.activeToolIds.add(toolCallId);

    const toolName = String(event.toolName ?? event.name ?? "");
    const toolInput = (event.input ?? event.args ?? {}) as Record<string, unknown>;
    const { status, detail } = toolToStatus(toolName, toolInput);

    this.beginStep(session, status, detail);
  }

  private handleToolEnd(session: SessionState, event: AgentEvent): void {
    session.activeToolCount = Math.max(0, session.activeToolCount - 1);
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (toolCallId) session.activeToolIds.delete(toolCallId);
    const now = nowMs();
    session.lastActiveAt = now;

    const hadError = Boolean(event.error ?? event.isError);
    session.islandDetail = truncate(
      `${session.islandDetail} ${hadError ? "✗" : "✓"}`,
      MAX_DETAIL_LENGTH,
    );
    // Parallel tools of the same call: only the last one closes the step.
    if (session.activeToolIds.size === 0) {
      session.frozenDetailElapsed = Math.max(0, now - session.detailStartedAt);
    }

    this.enqueue(this.buildUpdate(session));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

declare global {
  var __deerhuxLiveIslandBridge: LiveIslandBridge | undefined;
}

/**
 * Process-wide singleton. Uses a global so Next.js HMR and route modules share
 * one bridge — otherwise concurrent sessions could end up split across two
 * instances with divergent row state.
 */
export function getLiveIslandBridge(): LiveIslandBridge {
  const bridge = globalThis.__deerhuxLiveIslandBridge ??= new LiveIslandBridge();
  void bridge.init();
  return bridge;
}
