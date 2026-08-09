import path from "path";
import { addAllowedRoot } from "@/lib/file-access";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";
import { getAgentEventStore, type SequencedAgentEvent } from "@/lib/agent-runtime/event-store";
import { MessageUpdateCoalescer } from "@/lib/agent-runtime/event-coalescer";
import { validateSessionId, SessionIdValidationError } from "@/lib/validate";

export const dynamic = "force-dynamic";

function resolveAfterSeq(req: Request): number | undefined {
  const url = new URL(req.url);
  const raw = url.searchParams.get("after") ?? req.headers.get("last-event-id");
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    validateSessionId(id);
    await ensureRpcSession(id);
  } catch (error) {
    if (error instanceof SessionIdValidationError) {
      return new Response(error.message, { status: 400 });
    }
    if (error instanceof SessionNotFoundError) {
      return new Response("Session not found", { status: 404 });
    }
    console.error("[agent/events] start failed:", error);
    return new Response("Failed to start agent", { status: 500 });
  }

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let lastActivity = Date.now();
      let unsubscribe: () => void = () => {};
      const timers: {
        heartbeat?: ReturnType<typeof setInterval>;
        watchdog?: ReturnType<typeof setInterval>;
      } = {};
      const encoder = new TextEncoder();
      const coalescerRef: { current?: MessageUpdateCoalescer<SequencedAgentEvent> } = {};

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        if (timers.watchdog) clearInterval(timers.watchdog);
        coalescerRef.current?.cancel();
        unsubscribe();
        req.signal?.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed */ }
      };

      const safeEncode = (data: unknown, seq?: number) => {
        if (closed) return;
        if (controller.desiredSize !== null && controller.desiredSize <= -256) {
          cleanup();
          return;
        }
        try {
          const eventId = seq === undefined ? "" : `id: ${seq}\n`;
          controller.enqueue(encoder.encode(`${eventId}data: ${JSON.stringify(data)}\n\n`));
          lastActivity = Date.now();
        } catch {
          cleanup();
        }
      };

      const sendStored = (stored: SequencedAgentEvent) => {
        const event: Record<string, unknown> & { type: string } = {
          ...stored.event,
          seq: stored.seq,
          runId: stored.runId,
          createdAt: stored.createdAt,
          ...(stored.turnId ? { turnId: stored.turnId } : {}),
        };
        if (event.type === "agent_file_changed") {
          const filePath = event.filePath;
          if (typeof filePath === "string" && filePath.trim()) {
            addAllowedRoot(path.dirname(filePath));
          }
        }
        safeEncode(event, stored.seq);
      };

      // 非 update 事件会先 flush 最新累计快照，保证 message_end/工具事件不越序。
      const coalescer = new MessageUpdateCoalescer(sendStored);
      coalescerRef.current = coalescer;
      const store = getAgentEventStore();

      // 先订阅再同步取回放快照，关闭旧实现中 replay → subscribe 之间的丢事件窗口。
      // JS 同一调用栈不可被 append() 插入，因此不会产生重复或乱序。
      unsubscribe = store.subscribe(id, (stored) => coalescer.push(stored));
      safeEncode({ type: "connected", sessionId: id });
      if (closed) return;
      const afterSeq = resolveAfterSeq(req);
      for (const stored of store.getSince(id, afterSeq)) {
        coalescer.push(stored);
        if (closed) return;
      }

      timers.heartbeat = setInterval(() => {
        if (closed) return;
        if (controller.desiredSize !== null && controller.desiredSize <= -256) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(":\n\n"));
          lastActivity = Date.now();
        } catch {
          cleanup();
        }
      }, 30_000);

      timers.watchdog = setInterval(() => {
        if (!closed && Date.now() - lastActivity > 5 * 60_000) cleanup();
      }, 60_000);

      if (req.signal?.aborted) cleanup();
      else req.signal?.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
