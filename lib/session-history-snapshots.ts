import type { AgentMessage } from "@/lib/types";

/**
 * Client-only, bounded snapshots of session history.
 *
 * A chat session can move between workspace slots or be temporarily unmounted
 * when the layout changes. History belongs to the session id, not to a React
 * slot/component instance. This store is deliberately limited to renderable
 * history state only: SSE subscriptions, timers and abort controllers remain
 * owned by useAgentSession and are always recreated on mount.
 */
export interface SessionHistorySnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  /** Prevent a later recent-100 response from downgrading already loaded history. */
  fullHistoryLoaded: boolean;
  hasOlderMessages: boolean;
  updatedAt: number;
}

const MAX_SESSION_HISTORY_SNAPSHOTS = 12;

export class SessionHistorySnapshotStore {
  private readonly snapshots = new Map<string, SessionHistorySnapshot>();

  get(sessionId: string): SessionHistorySnapshot | null {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) return null;
    // Map insertion order is the LRU order. Promote on read.
    this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  set(sessionId: string, snapshot: Omit<SessionHistorySnapshot, "updatedAt">): void {
    if (!sessionId) return;
    const normalized: SessionHistorySnapshot = {
      messages: snapshot.messages,
      entryIds: snapshot.entryIds,
      fullHistoryLoaded: snapshot.fullHistoryLoaded,
      hasOlderMessages: snapshot.hasOlderMessages,
      updatedAt: Date.now(),
    };
    this.snapshots.delete(sessionId);
    this.snapshots.set(sessionId, normalized);
    while (this.snapshots.size > MAX_SESSION_HISTORY_SNAPSHOTS) {
      const oldestSessionId = this.snapshots.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      this.snapshots.delete(oldestSessionId);
    }
  }

  delete(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  clear(): void {
    this.snapshots.clear();
  }

  get size(): number {
    return this.snapshots.size;
  }
}

/** Module scope intentionally survives component remounts, but not page reloads. */
const sessionHistorySnapshots = new SessionHistorySnapshotStore();

export function getSessionHistorySnapshot(sessionId: string): SessionHistorySnapshot | null {
  return sessionHistorySnapshots.get(sessionId);
}

export function saveSessionHistorySnapshot(
  sessionId: string,
  snapshot: Omit<SessionHistorySnapshot, "updatedAt">,
): void {
  sessionHistorySnapshots.set(sessionId, snapshot);
}

export function deleteSessionHistorySnapshot(sessionId: string): void {
  sessionHistorySnapshots.delete(sessionId);
}

/** Exported for focused tests only; application code should use the functions above. */
export function createSessionHistorySnapshotStore(): SessionHistorySnapshotStore {
  return new SessionHistorySnapshotStore();
}
