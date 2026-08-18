import type { CollaborationMuxSnapshot } from "./parallel-agent/collaboration-mux";

export interface HostRunningSession {
  sessionId: string;
  running: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  lastEventType: string;
  eventCount: number;
  eventRate: number;
  eventIdleMs: number | null;
  contentIdleMs: number | null;
  updatedAt: number;
}

export type HostRunningSnapshot = {
  type: "host_running_snapshot";
  sessions: HostRunningSession[];
  /** Connection baseline: absence authoritatively clears old transient/subagent mirrors. */
  authoritative?: true;
};

export type SubagentRunsSnapshot = {
  type: "subagent_runs_snapshot";
  parentSessionId: string;
  runs: CollaborationMuxSnapshot[];
  updatedAt: number;
};

export type SubagentRunUpdate = {
  type: "subagent_run_update";
  parentSessionId: string;
  run: CollaborationMuxSnapshot;
  updatedAt: number;
};

export type SessionTransientSnapshot = {
  type: "session_transient_snapshot";
  sessionId: string;
  /** Logical turn state. It intentionally differs from isStreaming. */
  running: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  thinkingLevel?: string;
  updatedAt: number;
};

export type HostControlFrame =
  | HostRunningSnapshot
  | SubagentRunsSnapshot
  | SubagentRunUpdate
  | SessionTransientSnapshot;

type Listener = (frame: HostControlFrame) => void;

class HostEventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(frame: HostControlFrame): void {
    for (const listener of [...this.listeners]) {
      try { listener(frame); } catch { /* one SSE consumer must not block others */ }
    }
  }
}

declare global {
  var __deerhuxHostEventBus: HostEventBus | undefined;
}

export const hostEventBus = globalThis.__deerhuxHostEventBus ??= new HostEventBus();
