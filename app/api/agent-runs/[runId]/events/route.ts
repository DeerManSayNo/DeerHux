import { getCollaborationRun, subscribeCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import {
  removedCollaborationMuxSnapshot,
  toCollaborationMuxSnapshot,
  type CollaborationMuxSnapshot,
} from "@/lib/parallel-agent/collaboration-mux";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE only sends the collaboration UI-state whitelist, never full run details. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!getCollaborationRun(runId)) return new Response("Run not found", { status: 404 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: () => void = () => {};
      const resources: { heartbeat?: ReturnType<typeof setInterval> } = {};

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (resources.heartbeat) clearInterval(resources.heartbeat);
        unsubscribe();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (snapshot: CollaborationMuxSnapshot) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`)); } catch { cleanup(); }
      };
      const pushCurrentSnapshot = () => {
        const state = getCollaborationRun(runId);
        if (!state) {
          send(removedCollaborationMuxSnapshot(runId));
          cleanup();
          return;
        }
        send(toCollaborationMuxSnapshot(state));
      };

      unsubscribe = subscribeCollaborationRun(runId, pushCurrentSnapshot, () => {
        send(removedCollaborationMuxSnapshot(runId));
        cleanup();
      });
      resources.heartbeat = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(":\n\n")); } catch { cleanup(); }
        }
      }, 30_000);

      pushCurrentSnapshot();
      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
