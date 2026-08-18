import { getAgentEventStore, type SequencedAgentEvent } from "@/lib/agent-runtime/event-store";
import { MessageUpdateCoalescer } from "@/lib/agent-runtime/event-coalescer";
import { hostEventBus } from "@/lib/host-event-bus";
import { listCollaborationRuns } from "@/lib/parallel-agent/collaboration-store";
import { toCollaborationMuxSnapshot } from "@/lib/parallel-agent/collaboration-mux";
import { listRpcHostRunningSessions, listRpcSessionTransientSnapshots } from "@/lib/rpc-manager";
import { openSseConnection, recordSlowConsumerDrop } from "@/lib/agent-runtime/transport-diagnostics";
import { isSseConsumerOverBudget, sseByteStrategy } from "@/lib/agent-runtime/sse-backpressure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseCursor(req: Request): { epoch: string; globalSeq: number } | null {
  const url = new URL(req.url);
  const epoch = url.searchParams.get("epoch")?.trim();
  const rawSeq = url.searchParams.get("after") ?? req.headers.get("last-event-id");
  if (!epoch || !rawSeq) return null;
  const globalSeq = Number(rawSeq);
  return Number.isSafeInteger(globalSeq) && globalSeq >= 0 ? { epoch, globalSeq } : null;
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
      const cursor = parseCursor(req);
      let closed = false;
      let unsubscribe: () => void = () => {};
      let unsubscribeHost: () => void = () => {};
      const closeMetric = openSseConnection();
      const resources: {
        heartbeat?: ReturnType<typeof setInterval>;
        coalescer?: MessageUpdateCoalescer<SequencedAgentEvent>;
      } = {};

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (resources.heartbeat) clearInterval(resources.heartbeat);
        resources.coalescer?.cancel();
        unsubscribe();
        unsubscribeHost();
        closeMetric();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed */ }
      };

      const send = (value: unknown, eventId?: number) => {
        if (closed) return;
        // ReadableStream queues are otherwise unbounded for a frozen/slow tab.
        // Close lagging consumers after roughly 8 MB queued bytes; the journal cursor
        // lets them replay without applying backpressure to the Agent loop.
        if (isSseConsumerOverBudget(controller.desiredSize)) {
          recordSlowConsumerDrop();
          cleanup();
          return;
        }
        try {
          const id = eventId === undefined ? "" : `id: ${eventId}\n`;
          controller.enqueue(encoder.encode(`${id}data: ${JSON.stringify(value)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const sendStored = (stored: SequencedAgentEvent) => {
        send({
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
        }, stored.globalSeq);
      };

      const coalescer = new MessageUpdateCoalescer(sendStored);
      resources.coalescer = coalescer;
      // Subscribe before reading the replay snapshot. append() and getGlobalSince()
      // are synchronous, so no event can fall between these two operations.
      unsubscribe = store.subscribeAll((event) => coalescer.push(event));
      unsubscribeHost = hostEventBus.subscribe((frame) => send(frame));

      if (cursor) {
        const replay = store.getGlobalSince(cursor);
        if (replay.snapshotRequired) {
          send({
            type: "snapshot_required",
            reason: replay.reason,
            epoch: replay.epoch,
            latestGlobalSeq: replay.latestGlobalSeq,
          });
        } else {
          // connected reports the already-consumed cursor, not the server tail.
          // The client advances only after each replay event is delivered.
          send({ type: "connected", epoch: replay.epoch, globalSeq: cursor.globalSeq, resumed: true });
          for (const event of replay.events) {
            coalescer.push(event);
            if (closed) return;
          }
        }
      } else {
        // A new UI loads message snapshots independently. Start at the current
        // journal tail instead of replaying unrelated historic sessions.
        send({ type: "connected", epoch: store.epoch, globalSeq: store.getLastGlobalSeq(), resumed: false });
      }

      // Control-plane baselines are sent after the epoch barrier on every
      // connection, including cursor resumes. Clients clear mirrors on a new
      // epoch/snapshot_required and rebuild exclusively from these frames.
      const baselineAt = Date.now();
      send({ type: "host_running_snapshot", sessions: listRpcHostRunningSessions(baselineAt), authoritative: true });
      for (const snapshot of listRpcSessionTransientSnapshots(baselineAt)) send(snapshot);
      const runsByParent = new Map<string, ReturnType<typeof toCollaborationMuxSnapshot>[]>();
      for (const run of listCollaborationRuns()) {
        if (!run.parentSessionId) continue;
        const group = runsByParent.get(run.parentSessionId) ?? [];
        group.push(toCollaborationMuxSnapshot(run));
        runsByParent.set(run.parentSessionId, group);
      }
      for (const [parentSessionId, runs] of runsByParent) {
        send({ type: "subagent_runs_snapshot", parentSessionId, runs, updatedAt: baselineAt });
      }

      resources.heartbeat = setInterval(() => {
        if (closed) return;
        if (isSseConsumerOverBudget(controller.desiredSize)) {
          recordSlowConsumerDrop();
          cleanup();
          return;
        }
        try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); }
      }, 30_000);

      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", cleanup, { once: true });
    },
  }, sseByteStrategy());

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
