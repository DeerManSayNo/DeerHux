export type RuntimeDiagnosticEventName =
  | "slow_consumer_dropped"
  | "enqueue_failed"
  | "snapshot_required"
  | "replay_completed"
  | "journal_eviction";

export interface RuntimeDiagnosticEvent {
  timestamp: number;
  level: "info" | "warn" | "error";
  component: "sse-server" | "event-store";
  event: RuntimeDiagnosticEventName;
  connectionId?: string;
  globalSeq?: number;
  reason?: string;
  durationMs?: number;
  eventCount?: number;
  byteCount?: number;
  error?: { name: string; message: string };
}

const MAX_EVENTS = 200;

declare global {
  var __deerhuxRuntimeDiagnosticEvents: RuntimeDiagnosticEvent[] | undefined;
}

function events(): RuntimeDiagnosticEvent[] {
  return globalThis.__deerhuxRuntimeDiagnosticEvents ??= [];
}

export function recordRuntimeDiagnosticEvent(event: RuntimeDiagnosticEvent): void {
  const buffer = events();
  buffer.push({ ...event, error: event.error ? { ...event.error } : undefined });
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
}

export function getRuntimeDiagnosticEvents(limit = 100): RuntimeDiagnosticEvent[] {
  const safeLimit = Math.max(0, Math.min(MAX_EVENTS, Math.floor(limit)));
  return events().slice(-safeLimit).map((event) => ({
    ...event,
    error: event.error ? { ...event.error } : undefined,
  }));
}

/** Test-only reset; production code must not call this. */
export function resetRuntimeDiagnosticEventsForTests(): void {
  globalThis.__deerhuxRuntimeDiagnosticEvents = [];
}
