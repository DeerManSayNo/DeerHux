"use client";

export type MultiplexAgentEvent = {
  type: "agent_event";
  epoch: string;
  globalSeq: number;
  globalSeqStart: number;
  sessionSeq: number;
  sessionSeqStart: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  createdAt: number;
  event: { type: string; [key: string]: unknown };
};

type ControlEvent =
  | { type: "connected"; epoch: string; globalSeq: number; resumed: boolean }
  | { type: "snapshot_required"; reason: string; epoch: string; latestGlobalSeq: number };

type SessionListener = (event: MultiplexAgentEvent["event"] & { turnId?: string }) => void;
type SnapshotListener = (reason: string) => void | Promise<void>;

const CURSOR_KEY = "deerhux.agent-events.cursor.v1";
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_RECOVERY_BUFFER = 1_000;

function readCursor(): { epoch: string; globalSeq: number } | null {
  try {
    const raw = window.sessionStorage.getItem(CURSOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { epoch?: unknown; globalSeq?: unknown };
    return typeof parsed.epoch === "string" && Number.isSafeInteger(parsed.globalSeq) && Number(parsed.globalSeq) >= 0
      ? { epoch: parsed.epoch, globalSeq: Number(parsed.globalSeq) }
      : null;
  } catch {
    return null;
  }
}

function persistCursor(epoch: string, globalSeq: number): void {
  try { window.sessionStorage.setItem(CURSOR_KEY, JSON.stringify({ epoch, globalSeq })); } catch { /* unavailable */ }
}

/** One browser-tab connection multiplexing all open DeerHux sessions. */
class AgentEventClient {
  private source: EventSource | null = null;
  private readonly listeners = new Map<string, Set<SessionListener>>();
  private readonly snapshotListeners = new Map<string, Set<SnapshotListener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private cursor: { epoch: string; globalSeq: number } | null = null;
  private barrierReady = false;
  private connectedWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private recovery: Promise<void> | null = null;
  private recoveryEvents: MultiplexAgentEvent[] = [];
  private unmatchedEvents: MultiplexAgentEvent[] = [];
  private keepAlive = 0;

  subscribe(sessionId: string, listener: SessionListener, onSnapshotRequired?: SnapshotListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) this.listeners.set(sessionId, listeners = new Set());
    listeners.add(listener);
    if (onSnapshotRequired) {
      let snapshotListeners = this.snapshotListeners.get(sessionId);
      if (!snapshotListeners) this.snapshotListeners.set(sessionId, snapshotListeners = new Set());
      snapshotListeners.add(onSnapshotRequired);
    }
    this.ensureConnected();
    if (this.unmatchedEvents.length > 0) {
      const remaining: MultiplexAgentEvent[] = [];
      for (const event of this.unmatchedEvents) {
        if (event.sessionId === sessionId) this.dispatchToListeners(event);
        else remaining.push(event);
      }
      this.unmatchedEvents = remaining;
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionId);
      if (onSnapshotRequired) {
        const snapshotListeners = this.snapshotListeners.get(sessionId);
        snapshotListeners?.delete(onSnapshotRequired);
        if (snapshotListeners?.size === 0) this.snapshotListeners.delete(sessionId);
      }
      this.disconnectIfUnused();
    };
  }

  /** Establish a cursor barrier before creating a session whose id is not known yet. */
  async prepare(): Promise<() => void> {
    this.keepAlive += 1;
    try {
      await this.waitUntilConnected();
    } catch (error) {
      this.keepAlive = Math.max(0, this.keepAlive - 1);
      this.disconnectIfUnused();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.keepAlive = Math.max(0, this.keepAlive - 1);
      this.disconnectIfUnused();
    };
  }

  ensureConnected(): void {
    if ((this.listeners.size === 0 && this.keepAlive === 0) || this.source) return;
    if (!this.cursor) this.cursor = readCursor();
    const query = this.cursor
      ? `?epoch=${encodeURIComponent(this.cursor.epoch)}&after=${this.cursor.globalSeq}`
      : "";
    const source = new EventSource(`/api/agent/events${query}`);
    this.source = source;

    source.onopen = () => { this.reconnectAttempt = 0; };
    source.onmessage = (message) => {
      let data: MultiplexAgentEvent | ControlEvent;
      try { data = JSON.parse(message.data) as MultiplexAgentEvent | ControlEvent; } catch { return; }

      if (data.type === "connected") {
        // On a fresh connection this is a barrier at the server tail. On resume
        // it is the client's prior cursor; replay events advance it one by one.
        this.commitCursor(data.epoch, data.globalSeq);
        this.barrierReady = true;
        for (const waiter of this.connectedWaiters) waiter.resolve();
        this.connectedWaiters.clear();
        return;
      }
      if (data.type === "snapshot_required") {
        void this.recoverFromSnapshot(data, source);
        return;
      }
      if (data.type !== "agent_event") return;
      if (this.recovery) {
        if (this.recoveryEvents.length >= MAX_RECOVERY_BUFFER) {
          this.recoveryEvents = [];
          source.close();
          if (this.source === source) this.source = null;
          this.barrierReady = false;
          this.scheduleReconnect();
          return;
        }
        this.recoveryEvents.push(data);
        return;
      }
      this.deliver(data);
    };
    source.onerror = () => this.handleDisconnect(source);
  }

  private waitUntilConnected(): Promise<void> {
    this.ensureConnected();
    if (this.barrierReady && this.source) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.connectedWaiters.add(waiter);
      setTimeout(() => {
        if (!this.connectedWaiters.delete(waiter)) return;
        reject(new Error("Agent event connection timed out"));
      }, 15_000);
    });
  }

  private async recoverFromSnapshot(data: Extract<ControlEvent, { type: "snapshot_required" }>, source: EventSource): Promise<void> {
    if (this.recovery) return;
    const listeners = [...this.snapshotListeners.values()].flatMap((set) => [...set]);
    this.recovery = Promise.all(listeners.map((listener) => Promise.resolve(listener(data.reason)))).then(() => undefined);
    try {
      await this.recovery;
      this.commitCursor(data.epoch, data.latestGlobalSeq);
      this.barrierReady = true;
      for (const waiter of this.connectedWaiters) waiter.resolve();
      this.connectedWaiters.clear();
      const buffered = this.recoveryEvents;
      this.recoveryEvents = [];
      for (const event of buffered) {
        if (event.epoch === data.epoch && event.globalSeq > data.latestGlobalSeq) this.deliver(event);
      }
    } catch {
      // Keep the old cursor. Reconnect will request snapshot_required again.
      this.recoveryEvents = [];
      source.close();
      if (this.source === source) this.source = null;
      this.scheduleReconnect();
    } finally {
      this.recovery = null;
    }
  }

  private deliver(data: MultiplexAgentEvent): void {
    if (this.cursor?.epoch === data.epoch && data.globalSeq <= this.cursor.globalSeq) return;
    if (this.cursor && this.cursor.epoch !== data.epoch) return;
    this.commitCursor(data.epoch, data.globalSeq);
    const listeners = this.listeners.get(data.sessionId);
    if (!listeners) {
      // A new session can emit before /api/agent/new returns its real id. Keep a
      // small bounded handoff buffer so registering that id can consume it.
      if (this.keepAlive > 0) {
        if (this.unmatchedEvents.length >= MAX_RECOVERY_BUFFER) {
          // The handoff window should normally contain only a few startup
          // events. If it overflows, request snapshots before dropping the
          // oldest transient item rather than silently losing state.
          for (const listeners of this.snapshotListeners.values()) {
            for (const listener of listeners) void Promise.resolve(listener("handoff_overflow"));
          }
          this.unmatchedEvents.shift();
        }
        this.unmatchedEvents.push(data);
      }
      return;
    }
    this.dispatchToListeners(data);
  }

  private dispatchToListeners(data: MultiplexAgentEvent): void {
    const listeners = this.listeners.get(data.sessionId);
    if (!listeners) return;
    const event = data.turnId ? { ...data.event, turnId: data.turnId } : data.event;
    for (const listener of [...listeners]) listener(event);
  }

  private commitCursor(epoch: string, globalSeq: number): void {
    if (this.cursor?.epoch === epoch && globalSeq < this.cursor.globalSeq) return;
    this.cursor = { epoch, globalSeq };
    persistCursor(epoch, globalSeq);
  }

  private handleDisconnect(source: EventSource): void {
    if (this.source !== source) { source.close(); return; }
    source.close();
    this.source = null;
    this.barrierReady = false;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 && this.keepAlive === 0) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const base = Math.min(500 * 2 ** (this.reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private disconnectIfUnused(): void {
    if (this.listeners.size > 0 || this.keepAlive > 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.source?.close();
    this.source = null;
    this.barrierReady = false;
    this.unmatchedEvents = [];
    this.reconnectAttempt = 0;
  }
}

declare global {
  var __deerhuxAgentEventClient: AgentEventClient | undefined;
}

// Survive Next HMR without leaving an old module-level EventSource alive.
const client = globalThis.__deerhuxAgentEventClient ??= new AgentEventClient();

export function subscribeAgentEvents(
  sessionId: string,
  listener: SessionListener,
  onSnapshotRequired?: SnapshotListener,
): () => void {
  return client.subscribe(sessionId, listener, onSnapshotRequired);
}

export function ensureAgentEventsConnected(): void {
  client.ensureConnected();
}

export function prepareAgentEvents(): Promise<() => void> {
  return client.prepare();
}
