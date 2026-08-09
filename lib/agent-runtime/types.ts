export interface AgentRuntimeEventBase {
  type: string;
  [key: string]: unknown;
}

export interface JournalCursor {
  epoch: string;
  globalSeq: number;
}

export type ResumeReason =
  | "ok"
  | "epoch_mismatch"
  | "invalid_cursor"
  | "cursor_ahead"
  | "cursor_evicted";

export interface ResumeDecision {
  canResume: boolean;
  snapshotRequired: boolean;
  reason: ResumeReason;
  epoch: string;
  earliestGlobalSeq: number;
  latestGlobalSeq: number;
}

export interface SequencedAgentEvent {
  /** Legacy run-scoped sequence used by the existing session SSE API. */
  seq: number;
  /** First legacy sequence represented by this event after coalescing. */
  seqStart: number;
  eventId: string;
  epoch: string;
  globalSeq: number;
  /** First global sequence represented by this event after coalescing. */
  globalSeqStart: number;
  sessionSeq: number;
  /** First session sequence represented by this event after coalescing. */
  sessionSeqStart: number;
  sessionId: string;
  runId: string;
  turnId?: string;
  topic: string;
  createdAt: number;
  /** Journal-shaped alias retained alongside the legacy `event` field. */
  payload: AgentRuntimeEventBase;
  event: AgentRuntimeEventBase;
}

export interface GlobalReplayResult extends ResumeDecision {
  events: SequencedAgentEvent[];
}

export type EventListener = (event: SequencedAgentEvent) => void;
export type GlobalEventListener = EventListener;
export type Unsubscribe = () => void;
