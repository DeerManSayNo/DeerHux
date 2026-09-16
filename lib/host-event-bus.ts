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

export type LiveIslandTransportEvent = {
  id: string;
  type: "update" | "remove" | "done-retract";
  project?: string;
  status?: string;
  detail?: string;
  prompt?: string;
  startedAt?: number;
  lastActiveAt?: number;
  detailStartedAt?: number;
  frozenElapsed?: number | null;
  frozenDetailElapsed?: number | null;
  delayMs?: number;
  cwd?: string;
};

export type LiveIslandEventsFrame = {
  type: "live_island_events";
  events: LiveIslandTransportEvent[];
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
  | SessionTransientSnapshot
  | LiveIslandEventsFrame;

type Listener = (frame: HostControlFrame) => void;

class HostEventBus {
  private readonly listeners = new Set<Listener>();
  private liveIslandFrame: LiveIslandEventsFrame | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(frame: HostControlFrame): void {
    if (frame.type === "live_island_events") this.liveIslandFrame = frame;
    for (const listener of [...this.listeners]) {
      try { listener(frame); } catch { /* one SSE consumer must not block others */ }
    }
  }

  getLiveIslandFrame(): LiveIslandEventsFrame | null {
    return this.liveIslandFrame;
  }
}

declare global {
  var __deerhuxHostEventBus: HostEventBus | undefined;
}

export const hostEventBus = globalThis.__deerhuxHostEventBus ??= new HostEventBus();
