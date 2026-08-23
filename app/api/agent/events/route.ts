import { getAgentEventStore, type SequencedAgentEvent } from "@/lib/agent-runtime/event-store";
import { MessageUpdateCoalescer } from "@/lib/agent-runtime/event-coalescer";
import { hostEventBus } from "@/lib/host-event-bus";
import { listCollaborationRuns } from "@/lib/parallel-agent/collaboration-store";
import { toCollaborationMuxSnapshot } from "@/lib/parallel-agent/collaboration-mux";
import { listRpcHostRunningSessions, listRpcSessionTransientSnapshots } from "@/lib/rpc-manager";
import {
  openSseConnection,
  recordBaseline,
  recordFreshConnection,
  recordReplay,
  recordResumedConnection,
  recordSlowConsumerDrop,
  recordSnapshotRequired,
  recordSseFrame,
  type SseCloseReason,
  type SseFrameKind,
  type SsePhase,
} from "@/lib/agent-runtime/transport-diagnostics";
import { isSseConsumerOverBudget, sseByteStrategy } from "@/lib/agent-runtime/sse-backpressure";
import { recordRuntimeDiagnosticEvent } from "@/lib/agent-runtime/diagnostic-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ParsedCursor =
  | { kind: "fresh" }
  | { kind: "invalid" }
  | { kind: "valid"; cursor: { epoch: string; globalSeq: number } };

function parseCursor(req: Request): ParsedCursor {
  const url = new URL(req.url);
  const rawEpoch = url.searchParams.get("epoch");
  const rawAfter = url.searchParams.get("after");
  const lastEventId = req.headers.get("last-event-id");
  const attempted = rawEpoch !== null || rawAfter !== null || lastEventId !== null;
  if (!attempted) return { kind: "fresh" };
  const epoch = rawEpoch?.trim();
  const rawSeq = rawAfter ?? lastEventId;
  if (!epoch || rawSeq === null || rawSeq.trim() === "") return { kind: "invalid" };
  const globalSeq = Number(rawSeq);
  return Number.isSafeInteger(globalSeq) && globalSeq >= 0
    ? { kind: "valid", cursor: { epoch, globalSeq } }
    : { kind: "invalid" };
}

/**
 * GET /api/agent/events — one application-level SSE stream multiplexing every
 * loaded session. It never cold-starts a session; history remains snapshot based.
 */
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const store = getAgentEventStore();
      const encoder = new TextEncoder();
      const parsedCursor = parseCursor(req);
      const cursor = parsedCursor.kind === "valid" ? parsedCursor.cursor : null;
      const connectionId = `sse_${crypto.randomUUID().slice(0, 12)}`;
      let closed = false;
      let phase: SsePhase = "live";
      let unsubscribe: () => void = () => {};
      let unsubscribeHost: () => void = () => {};
      const closeMetric = openSseConnection();
      const resources: {
        heartbeat?: ReturnType<typeof setInterval>;
        coalescer?: MessageUpdateCoalescer<SequencedAgentEvent>;
      } = {};

      const cleanup = (reason: SseCloseReason = "cleanup") => {
        if (closed) return;
        closed = true;
        if (resources.heartbeat) clearInterval(resources.heartbeat);
        resources.coalescer?.cancel();
        unsubscribe();
        unsubscribeHost();
        closeMetric(reason);
        req.signal.removeEventListener("abort", handleAbort);
        try { controller.close(); } catch { /* already closed */ }
      };
      const handleAbort = () => cleanup("abort");

      const send = (
        value: unknown,
        options: { eventId?: number; kind?: SseFrameKind; phase?: SsePhase } = {},
      ): number => {
        if (closed) return 0;
        const sendPhase = options.phase ?? phase;
        // ReadableStream queues are otherwise unbounded for a frozen/slow tab.
        // Close lagging consumers after roughly 8 MB queued bytes; the journal cursor
        // lets them replay without applying backpressure to the Agent loop.
        if (isSseConsumerOverBudget(controller.desiredSize)) {
          recordSlowConsumerDrop(sendPhase);
          recordRuntimeDiagnosticEvent({
            timestamp: Date.now(),
            level: "warn",
            component: "sse-server",
            event: "slow_consumer_dropped",
            connectionId,
            reason: sendPhase,
          });
          cleanup("slow_consumer");
          return 0;
        }
        try {
          const id = options.eventId === undefined ? "" : `id: ${options.eventId}\n`;
          const encoded = encoder.encode(`${id}data: ${JSON.stringify(value)}\n\n`);
          controller.enqueue(encoded);
          recordSseFrame(encoded.byteLength, options.kind ?? "control", controller.desiredSize);
          return encoded.byteLength;
        } catch (error) {
          recordRuntimeDiagnosticEvent({
            timestamp: Date.now(),
            level: "error",
            component: "sse-server",
            event: "enqueue_failed",
            connectionId,
            reason: sendPhase,
            error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
          });
          cleanup("write_error");
          return 0;
        }
      };

      let replayEventsSent = 0;
      let replayBytesSent = 0;
      const sendStored = (stored: SequencedAgentEvent) => {
        const bytes = send({
          type: "agent_event",
          epoch: stored.epoch,
          globalSeq: stored.globalSeq,
          globalSeqStart: stored.globalSeqStart,
          sessionSeq: stored.sessionSeq,
          sessionSeqStart: stored.sessionSeqStart,
          sessionId: stored.sessionId,
          runId: stored.runId,
          turnId: stored.turnId,
          createdAt: stored.createdAt,
          event: stored.event,
        }, { eventId: stored.globalSeq, kind: "agent_event" });
        if (phase === "replay" && bytes > 0) {
          replayEventsSent += 1;
          replayBytesSent += bytes;
        }
      };

      const coalescer = new MessageUpdateCoalescer(sendStored);
      resources.coalescer = coalescer;
      // Subscribe before reading the replay snapshot. append() and getGlobalSince()
      // are synchronous, so no event can fall between these two operations.
      unsubscribe = store.subscribeAll((event) => coalescer.push(event));
      unsubscribeHost = hostEventBus.subscribe((frame) => send(frame, { kind: "control", phase: "live" }));

      if (parsedCursor.kind === "invalid") {
        recordSnapshotRequired("invalid_cursor");
        recordRuntimeDiagnosticEvent({
          timestamp: Date.now(),
          level: "warn",
          component: "sse-server",
          event: "snapshot_required",
          connectionId,
          reason: "invalid_cursor",
          globalSeq: store.getLastGlobalSeq(),
        });
        send({
          type: "snapshot_required",
          connectionId,
          reason: "invalid_cursor",
          epoch: store.epoch,
          latestGlobalSeq: store.getLastGlobalSeq(),
        });
      } else if (cursor) {
        const replayStartedAt = Date.now();
        const replay = store.getGlobalSince(cursor);
        if (replay.snapshotRequired) {
          recordSnapshotRequired(replay.reason);
          recordRuntimeDiagnosticEvent({
            timestamp: Date.now(),
            level: "warn",
            component: "sse-server",
            event: "snapshot_required",
            connectionId,
            reason: replay.reason,
            globalSeq: replay.latestGlobalSeq,
          });
          send({
            type: "snapshot_required",
            connectionId,
            reason: replay.reason,
            epoch: replay.epoch,
            latestGlobalSeq: replay.latestGlobalSeq,
          });
        } else {
          recordResumedConnection();
          // connected reports the already-consumed cursor, not the server tail.
          // The client advances only after each replay event is delivered.
          send({ type: "connected", connectionId, epoch: replay.epoch, globalSeq: cursor.globalSeq, resumed: true });
          phase = "replay";
          try {
            for (const event of replay.events) {
              coalescer.push(event);
              if (closed) break;
            }
            // Include delayed message_update snapshots in replay accounting before
            // switching the connection to live mode.
            if (!closed) coalescer.flush();
          } finally {
            const replayDurationMs = Date.now() - replayStartedAt;
            recordReplay({
              events: replayEventsSent,
              bytes: replayBytesSent,
              durationMs: replayDurationMs,
              lagEvents: Math.max(0, replay.latestGlobalSeq - cursor.globalSeq),
            });
            if (replayEventsSent > 0) {
              recordRuntimeDiagnosticEvent({
                timestamp: Date.now(),
                level: "info",
                component: "sse-server",
                event: "replay_completed",
                connectionId,
                globalSeq: replay.latestGlobalSeq,
                durationMs: replayDurationMs,
                eventCount: replayEventsSent,
                byteCount: replayBytesSent,
              });
            }
            phase = "live";
          }
          if (closed) return;
        }
      } else {
        recordFreshConnection();
        // A new UI loads message snapshots independently. Start at the current
        // journal tail instead of replaying unrelated historic sessions.
        send({
          type: "connected",
          connectionId,
          epoch: store.epoch,
          globalSeq: store.getLastGlobalSeq(),
          resumed: false,
        });
      }

      // Control-plane baselines are sent after the epoch barrier on every
      // connection, including cursor resumes. Clients clear mirrors on a new
      // epoch/snapshot_required and rebuild exclusively from these frames.
      phase = "baseline";
      const baselineStartedAt = Date.now();
      const baselineAt = Date.now();
      const runningSessions = listRpcHostRunningSessions(baselineAt);
      const transientSnapshots = listRpcSessionTransientSnapshots(baselineAt);
      let baselineFrames = 0;
      let baselineBytes = 0;
      const sendBaseline = (value: unknown) => {
        const bytes = send(value, { kind: "control", phase: "baseline" });
        if (bytes > 0) {
          baselineFrames += 1;
          baselineBytes += bytes;
        }
      };
      sendBaseline({ type: "host_running_snapshot", sessions: runningSessions, authoritative: true });
      for (const snapshot of transientSnapshots) sendBaseline(snapshot);
      const runsByParent = new Map<string, ReturnType<typeof toCollaborationMuxSnapshot>[] >();
      for (const run of listCollaborationRuns()) {
        if (!run.parentSessionId) continue;
        const group = runsByParent.get(run.parentSessionId) ?? [];
        group.push(toCollaborationMuxSnapshot(run));
        runsByParent.set(run.parentSessionId, group);
      }
      let subagentRuns = 0;
      for (const [parentSessionId, runs] of runsByParent) {
        subagentRuns += runs.length;
        sendBaseline({ type: "subagent_runs_snapshot", parentSessionId, runs, updatedAt: baselineAt });
      }
      recordBaseline({
        durationMs: Date.now() - baselineStartedAt,
        frames: baselineFrames,
        bytes: baselineBytes,
        sessions: runningSessions.length,
        transientSnapshots: transientSnapshots.length,
        subagentParents: runsByParent.size,
        subagentRuns,
      });
      phase = "live";

      resources.heartbeat = setInterval(() => {
        if (closed) return;
        if (isSseConsumerOverBudget(controller.desiredSize)) {
          recordSlowConsumerDrop("heartbeat");
          recordRuntimeDiagnosticEvent({
            timestamp: Date.now(),
            level: "warn",
            component: "sse-server",
            event: "slow_consumer_dropped",
            connectionId,
            reason: "heartbeat",
          });
          cleanup("slow_consumer");
          return;
        }
        try {
          const encoded = encoder.encode(":\n\n");
          controller.enqueue(encoded);
          recordSseFrame(encoded.byteLength, "heartbeat", controller.desiredSize);
        } catch (error) {
          recordRuntimeDiagnosticEvent({
            timestamp: Date.now(),
            level: "error",
            component: "sse-server",
            event: "enqueue_failed",
            connectionId,
            reason: "heartbeat",
            error: error instanceof Error ? { name: error.name, message: error.message } : undefined,
          });
          cleanup("write_error");
        }
      }, 30_000);

      if (req.signal.aborted) cleanup("abort");
      else req.signal.addEventListener("abort", handleAbort, { once: true });
    },
  }, sseByteStrategy());

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
