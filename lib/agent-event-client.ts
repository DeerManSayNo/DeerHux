"use client";

import { businessRecoveryDelayMs, eligibleRecoveryEvents } from "@/lib/agent-runtime/recovery-buffer";

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
  private readonly pendingHandoffRecoveries = new Map<string, MultiplexAgentEvent>();
  private readonly listenerRecoveryAttempts = new Map<string, number>();
  private snapshotRecoveryAttempt = 0;
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
      let failedHandoff: MultiplexAgentEvent | null = null;
      for (const event of this.unmatchedEvents) {
        if (event.sessionId !== sessionId) {
          remaining.push(event);
          continue;
        }
        if (!this.dispatchToListeners(event)) failedHandoff = event;
      }
      this.unmatchedEvents = remaining;
      if (failedHandoff) void this.recoverListenerFailure(failedHandoff, true);
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
        this.retryPendingHandoffRecoveries();
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
    source.close();
    if (this.source === source) this.source = null;
    this.barrierReady = false;
    if (this.snapshotRecoveryAttempt > 0) {
      const delay = businessRecoveryDelayMs(this.snapshotRecoveryAttempt, MAX_RECONNECT_DELAY_MS);
      const delayGate = new Promise<void>((resolve) => setTimeout(resolve, delay));
      this.recovery = delayGate;
      await delayGate;
      if (this.recovery === delayGate) this.recovery = null;
    }
    const missingRecovery = [...this.listeners.keys()].filter((sessionId) => !this.snapshotListeners.has(sessionId));
    const listeners = [...this.snapshotListeners.values()].flatMap((set) => [...set]);
    const recovery = missingRecovery.length > 0
      ? Promise.reject(new Error(`No snapshot recovery listener for: ${missingRecovery.join(", ")}`))
      : Promise.all(listeners.map((listener) => Promise.resolve(listener(data.reason)))).then(() => undefined);
    this.recovery = recovery;
    try {
      await recovery;
      this.snapshotRecoveryAttempt = 0;
      this.commitCursor(data.epoch, data.latestGlobalSeq);
      this.barrierReady = true;
      for (const waiter of this.connectedWaiters) waiter.resolve();
      this.connectedWaiters.clear();
      const buffered = eligibleRecoveryEvents(this.recoveryEvents, data.epoch, data.latestGlobalSeq);
      this.recoveryEvents = [];
      // Snapshot 已成功，先释放旧 Recovery Gate；排空时若 Listener 再失败，
      // 必须允许启动新的 Session Snapshot Recovery。
      if (this.recovery === recovery) this.recovery = null;
      for (let index = 0; index < buffered.length; index += 1) {
        this.deliver(buffered[index]);
        // 新 Recovery 接管当前失败事件；剩余事件必须交给它继续缓存，不能丢弃。
        if (this.recovery !== null) {
          this.recoveryEvents.push(...buffered.slice(index + 1));
          break;
        }
      }
    } catch {
      this.snapshotRecoveryAttempt += 1;
      // Keep the old cursor. Reconnect will request snapshot_required again.
      this.recoveryEvents = [];
      source.close();
      if (this.source === source) this.source = null;
      this.scheduleReconnect();
    } finally {
      if (this.recovery === recovery) this.recovery = null;
      this.scheduleReconnect();
    }
  }

  private deliver(data: MultiplexAgentEvent): void {
    if (this.cursor?.epoch === data.epoch && data.globalSeq <= this.cursor.globalSeq) return;
    if (this.cursor && this.cursor.epoch !== data.epoch) return;
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
      this.commitCursor(data.epoch, data.globalSeq);
      return;
    }
    const delivered = this.dispatchToListeners(data);
    if (delivered) {
      this.listenerRecoveryAttempts.delete(data.sessionId);
      this.commitCursor(data.epoch, data.globalSeq);
      return;
    }
    void this.recoverListenerFailure(data);
  }

  private dispatchToListeners(data: MultiplexAgentEvent): boolean {
    const listeners = this.listeners.get(data.sessionId);
    if (!listeners) return true;
    const event = data.turnId ? { ...data.event, turnId: data.turnId } : data.event;
    let success = true;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        success = false;
        // 一个 UI 消费者异常不能阻断其他消费者；失败 Session 随后通过 Snapshot 收敛。
        console.error("[agent-events] listener failed:", error);
      }
    }
    return success;
  }

  private async recoverListenerFailure(data: MultiplexAgentEvent, committedHandoff = false): Promise<void> {
    if (this.recovery) return;
    const source = this.source;
    source?.close();
    if (this.source === source) this.source = null;
    this.barrierReady = false;
    const recoveryAttempt = this.listenerRecoveryAttempts.get(data.sessionId) ?? 0;
    if (recoveryAttempt > 0) {
      const delay = businessRecoveryDelayMs(recoveryAttempt, MAX_RECONNECT_DELAY_MS);
      const delayGate = new Promise<void>((resolve) => setTimeout(resolve, delay));
      this.recovery = delayGate;
      await delayGate;
      if (this.recovery === delayGate) this.recovery = null;
      if (!this.listeners.has(data.sessionId)) {
        this.scheduleReconnect();
        return;
      }
    }
    const listeners = [...(this.snapshotListeners.get(data.sessionId) ?? [])];
    let succeeded = false;
    this.recovery = (async () => {
      const attempts = committedHandoff ? 5 : 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          if (!listeners.length) throw new Error(`No snapshot recovery listener for ${data.sessionId}`);
          await Promise.all(listeners.map((listener) => Promise.resolve(listener("listener_failed"))));
          succeeded = true;
          return;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8_000)));
          }
        }
      }
      throw lastError;
    })();
    try {
      await this.recovery;
      this.listenerRecoveryAttempts.delete(data.sessionId);
      this.pendingHandoffRecoveries.delete(data.sessionId);
      this.commitCursor(data.epoch, data.globalSeq);
    } catch (error) {
      this.listenerRecoveryAttempts.set(data.sessionId, recoveryAttempt + 1);
      if (committedHandoff) this.pendingHandoffRecoveries.set(data.sessionId, data);
      console.error("[agent-events] snapshot recovery after listener failure failed:", error);
    } finally {
      this.recovery = null;
      if (succeeded) {
        const buffered = eligibleRecoveryEvents(this.recoveryEvents, data.epoch, data.globalSeq);
        this.recoveryEvents = [];
        for (let index = 0; index < buffered.length; index += 1) {
          this.deliver(buffered[index]);
          if (this.recovery) {
            this.recoveryEvents.push(...buffered.slice(index + 1));
            break;
          }
        }
      } else {
        this.recoveryEvents = [];
      }
      this.scheduleReconnect();
    }
  }

  private retryPendingHandoffRecoveries(): void {
    if (this.recovery || this.pendingHandoffRecoveries.size === 0) return;
    const pending = [...this.pendingHandoffRecoveries.values()]
      .sort((a, b) => a.globalSeq - b.globalSeq)[0];
    if (pending) void this.recoverListenerFailure(pending, true);
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
    this.pendingHandoffRecoveries.clear();
    this.recoveryEvents = [];
    this.listenerRecoveryAttempts.clear();
    this.snapshotRecoveryAttempt = 0;
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
