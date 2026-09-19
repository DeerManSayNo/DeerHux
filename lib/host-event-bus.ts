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

export type AiBackgroundProcess = {
  processId: string;
  sessionId: string;
  toolCallId: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  output: string;
};

export type AiBackgroundProcessesSnapshot = {
  type: "ai_background_processes_snapshot";
  processes: AiBackgroundProcess[];
  updatedAt: number;
};

export type HostControlFrame =
  | HostRunningSnapshot
  | SubagentRunsSnapshot
  | SubagentRunUpdate
  | SessionTransientSnapshot
  | AiBackgroundProcessesSnapshot
  | LiveIslandEventsFrame;

type Listener = (frame: HostControlFrame) => void;

class HostEventBus {
  private readonly listeners = new Set<Listener>();
  private liveIslandFrame: LiveIslandEventsFrame | null = null;
  private aiBackgroundProcessesFrame: AiBackgroundProcessesSnapshot | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(frame: HostControlFrame): void {
    if (frame.type === "live_island_events") this.liveIslandFrame = frame;
    if (frame.type === "ai_background_processes_snapshot") this.aiBackgroundProcessesFrame = frame;
    for (const listener of [...this.listeners]) {
      try { listener(frame); } catch { /* one SSE consumer must not block others */ }
    }
  }

  getLiveIslandFrame(): LiveIslandEventsFrame | null {
    return this.liveIslandFrame;
  }

  getAiBackgroundProcessesFrame(): AiBackgroundProcessesSnapshot | null {
    return this.aiBackgroundProcessesFrame;
  }
}

declare global {
  var __deerhuxHostEventBus: HostEventBus | undefined;
  var __deerhuxHostEventBusVersion: number | undefined;
}

const HOST_EVENT_BUS_VERSION = 2;
if (globalThis.__deerhuxHostEventBusVersion !== HOST_EVENT_BUS_VERSION) {
  globalThis.__deerhuxHostEventBus = new HostEventBus();
  globalThis.__deerhuxHostEventBusVersion = HOST_EVENT_BUS_VERSION;
}
export const hostEventBus = globalThis.__deerhuxHostEventBus ??= new HostEventBus();
