import { SSE_HIGH_WATER_MARK_BYTES, SSE_MAX_QUEUED_BYTES } from "./sse-backpressure.ts";

export type SnapshotRequiredReason =
  | "epoch_mismatch"
  | "invalid_cursor"
  | "cursor_ahead"
  | "cursor_evicted"
  | "unknown";

export type SsePhase = "replay" | "live" | "baseline" | "heartbeat";
export type SseFrameKind = "agent_event" | "control" | "heartbeat";
export type SseCloseReason = "cleanup" | "abort" | "write_error" | "slow_consumer";

type ReasonCounters = Record<SnapshotRequiredReason, number>;
type PhaseCounters = Record<SsePhase, number>;

export interface TransportDiagnostics {
  diagnosticsVersion: 1;
  activeSseConnections: number;
  openedSseConnections: number;
  closedSseConnections: number;
  slowConsumerDrops: number;
  activeSseConnectionsPeak: number;
  connectionAbortsTotal: number;
  connectionWriteErrorsTotal: number;
  connectionDurationMsTotal: number;
  connectionDurationMsMax: number;
  freshConnectionsTotal: number;
  resumedConnectionsTotal: number;
  snapshotRequiredTotal: number;
  snapshotRequiredByReason: ReasonCounters;
  replayRequestsTotal: number;
  replayEventsTotal: number;
  replayBytesTotal: number;
  replayEmptyTotal: number;
  replayEventsMax: number;
  replayBytesMax: number;
  replayDurationMsTotal: number;
  replayDurationMsMax: number;
  replayLagEventsMax: number;
  framesSentTotal: number;
  bytesSentTotal: number;
  agentEventFramesSentTotal: number;
  controlFramesSentTotal: number;
  heartbeatFramesSentTotal: number;
  minimumDesiredSizeObserved: number | null;
  slowConsumerDropsByPhase: PhaseCounters;
  baselineBuildsTotal: number;
  baselineBuildDurationMsTotal: number;
  baselineBuildDurationMsMax: number;
  baselineFramesSentTotal: number;
  baselineBytesSentTotal: number;
  baselineSessionsLast: number;
  baselineTransientSnapshotsLast: number;
  baselineSubagentParentsLast: number;
  baselineSubagentRunsLast: number;
  sseHighWaterMarkBytes: number;
  sseMaxQueuedBytes: number;
}

function reasonCounters(): ReasonCounters {
  return { epoch_mismatch: 0, invalid_cursor: 0, cursor_ahead: 0, cursor_evicted: 0, unknown: 0 };
}

function phaseCounters(): PhaseCounters {
  return { replay: 0, live: 0, baseline: 0, heartbeat: 0 };
}

function initialState(): TransportDiagnostics {
  return {
    diagnosticsVersion: 1,
    activeSseConnections: 0,
    openedSseConnections: 0,
    closedSseConnections: 0,
    slowConsumerDrops: 0,
    activeSseConnectionsPeak: 0,
    connectionAbortsTotal: 0,
    connectionWriteErrorsTotal: 0,
    connectionDurationMsTotal: 0,
    connectionDurationMsMax: 0,
    freshConnectionsTotal: 0,
    resumedConnectionsTotal: 0,
    snapshotRequiredTotal: 0,
    snapshotRequiredByReason: reasonCounters(),
    replayRequestsTotal: 0,
    replayEventsTotal: 0,
    replayBytesTotal: 0,
    replayEmptyTotal: 0,
    replayEventsMax: 0,
    replayBytesMax: 0,
    replayDurationMsTotal: 0,
    replayDurationMsMax: 0,
    replayLagEventsMax: 0,
    framesSentTotal: 0,
    bytesSentTotal: 0,
    agentEventFramesSentTotal: 0,
    controlFramesSentTotal: 0,
    heartbeatFramesSentTotal: 0,
    minimumDesiredSizeObserved: null,
    slowConsumerDropsByPhase: phaseCounters(),
    baselineBuildsTotal: 0,
    baselineBuildDurationMsTotal: 0,
    baselineBuildDurationMsMax: 0,
    baselineFramesSentTotal: 0,
    baselineBytesSentTotal: 0,
    baselineSessionsLast: 0,
    baselineTransientSnapshotsLast: 0,
    baselineSubagentParentsLast: 0,
    baselineSubagentRunsLast: 0,
    sseHighWaterMarkBytes: SSE_HIGH_WATER_MARK_BYTES,
    sseMaxQueuedBytes: SSE_MAX_QUEUED_BYTES,
  };
}

declare global {
  var __deerhuxTransportDiagnostics: TransportDiagnostics | undefined;
}

function state(): TransportDiagnostics {
  const current = globalThis.__deerhuxTransportDiagnostics;
  if (!current) {
    globalThis.__deerhuxTransportDiagnostics = initialState();
  } else if (current.diagnosticsVersion !== 1) {
    // Upgrade the object in place so close callbacks held by existing SSE
    // connections keep updating the same process-lifetime counters after HMR.
    const defaults = initialState();
    for (const [key, value] of Object.entries(defaults)) {
      if ((current as unknown as Record<string, unknown>)[key] === undefined) {
        (current as unknown as Record<string, unknown>)[key] = value;
      }
    }
    current.diagnosticsVersion = 1;
  }
  return globalThis.__deerhuxTransportDiagnostics!;
}

export function openSseConnection(now = Date.now): (reason?: SseCloseReason) => void {
  const metrics = state();
  const openedAt = now();
  metrics.activeSseConnections += 1;
  metrics.openedSseConnections += 1;
  metrics.activeSseConnectionsPeak = Math.max(metrics.activeSseConnectionsPeak, metrics.activeSseConnections);
  let closed = false;
  return (reason = "cleanup") => {
    if (closed) return;
    closed = true;
    const duration = Math.max(0, now() - openedAt);
    metrics.activeSseConnections = Math.max(0, metrics.activeSseConnections - 1);
    metrics.closedSseConnections += 1;
    metrics.connectionDurationMsTotal += duration;
    metrics.connectionDurationMsMax = Math.max(metrics.connectionDurationMsMax, duration);
    if (reason === "abort") metrics.connectionAbortsTotal += 1;
    if (reason === "write_error") metrics.connectionWriteErrorsTotal += 1;
  };
}

export function recordFreshConnection(): void {
  state().freshConnectionsTotal += 1;
}

export function recordResumedConnection(): void {
  state().resumedConnectionsTotal += 1;
}

export function recordSnapshotRequired(reason: string): void {
  const metrics = state();
  const normalized: SnapshotRequiredReason = reason in metrics.snapshotRequiredByReason
    ? reason as SnapshotRequiredReason
    : "unknown";
  metrics.snapshotRequiredTotal += 1;
  metrics.snapshotRequiredByReason[normalized] += 1;
}

export function recordReplay(input: {
  events: number;
  bytes: number;
  durationMs: number;
  lagEvents: number;
}): void {
  const metrics = state();
  metrics.replayRequestsTotal += 1;
  metrics.replayEventsTotal += input.events;
  metrics.replayBytesTotal += input.bytes;
  metrics.replayDurationMsTotal += input.durationMs;
  if (input.events === 0) metrics.replayEmptyTotal += 1;
  metrics.replayEventsMax = Math.max(metrics.replayEventsMax, input.events);
  metrics.replayBytesMax = Math.max(metrics.replayBytesMax, input.bytes);
  metrics.replayDurationMsMax = Math.max(metrics.replayDurationMsMax, input.durationMs);
  metrics.replayLagEventsMax = Math.max(metrics.replayLagEventsMax, input.lagEvents);
}

export function recordSseFrame(bytes: number, kind: SseFrameKind, desiredSize: number | null): void {
  const metrics = state();
  metrics.framesSentTotal += 1;
  metrics.bytesSentTotal += Math.max(0, bytes);
  if (kind === "agent_event") metrics.agentEventFramesSentTotal += 1;
  else if (kind === "heartbeat") metrics.heartbeatFramesSentTotal += 1;
  else metrics.controlFramesSentTotal += 1;
  if (desiredSize !== null) {
    metrics.minimumDesiredSizeObserved = metrics.minimumDesiredSizeObserved === null
      ? desiredSize
      : Math.min(metrics.minimumDesiredSizeObserved, desiredSize);
  }
}

export function recordBaseline(input: {
  durationMs: number;
  frames: number;
  bytes: number;
  sessions: number;
  transientSnapshots: number;
  subagentParents: number;
  subagentRuns: number;
}): void {
  const metrics = state();
  metrics.baselineBuildsTotal += 1;
  metrics.baselineBuildDurationMsTotal += input.durationMs;
  metrics.baselineBuildDurationMsMax = Math.max(metrics.baselineBuildDurationMsMax, input.durationMs);
  metrics.baselineFramesSentTotal += input.frames;
  metrics.baselineBytesSentTotal += input.bytes;
  metrics.baselineSessionsLast = input.sessions;
  metrics.baselineTransientSnapshotsLast = input.transientSnapshots;
  metrics.baselineSubagentParentsLast = input.subagentParents;
  metrics.baselineSubagentRunsLast = input.subagentRuns;
}

export function recordSlowConsumerDrop(phase: SsePhase = "live"): void {
  const metrics = state();
  metrics.slowConsumerDrops += 1;
  metrics.slowConsumerDropsByPhase[phase] += 1;
}

export function getTransportDiagnostics(): TransportDiagnostics {
  const metrics = state();
  return {
    ...metrics,
    snapshotRequiredByReason: { ...metrics.snapshotRequiredByReason },
    slowConsumerDropsByPhase: { ...metrics.slowConsumerDropsByPhase },
  };
}

/** Test-only reset; production code must not call this. */
export function resetTransportDiagnosticsForTests(): void {
  globalThis.__deerhuxTransportDiagnostics = initialState();
}
