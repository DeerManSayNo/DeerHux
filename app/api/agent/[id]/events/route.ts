import path from "path";
import { addAllowedRoot } from "@/lib/file-access";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";
import { getAgentEventStore } from "@/lib/agent-runtime/event-store";
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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let session;
  try {
    validateSessionId(id);
    session = await ensureRpcSession(id);
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

      // ★ R11：write-failure 安全编码——客户端断开时 controller.enqueue 抛异常，
      // 自动触发清理，不再仅依赖 req.signal 的 abort 事件。
      const safeEncode = (data: unknown) => {
        if (closed) return;
        try {
          const text = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(new TextEncoder().encode(text));
          lastActivity = Date.now(); // ★ R11：记录最后活跃时间，供 watchdog 检测
        } catch {
          closed = true;
          cleanup();
        }
      };

      // Send initial connected event
      safeEncode({ type: "connected", sessionId: id });

      const afterSeq = resolveAfterSeq(req);
      for (const stored of getAgentEventStore().getSince(id, afterSeq)) {
        safeEncode({
          ...stored.event,
          seq: stored.seq,
          runId: stored.runId,
          createdAt: stored.createdAt,
          ...(stored.turnId ? { turnId: stored.turnId } : {}),
        });
      }

      const unsubscribe = session.onEvent((event) => {
        if (event && typeof event === "object" && "type" in event && event.type === "agent_file_changed") {
          const filePath = (event as { filePath?: unknown }).filePath;
          if (typeof filePath === "string" && filePath.trim()) {
            addAllowedRoot(path.dirname(filePath));
          }
        }
        safeEncode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
          lastActivity = Date.now();
        } catch {
          closed = true;
          cleanup();
        }
      }, 30_000);

      // ★ R11：5 分钟兜底 watchdog —— 即使 abort 事件丢失，也能检测死连接
      let lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastActivity > 5 * 60_000) {
          cleanup();
        }
      }, 60_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(watchdog);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      // Double-insurance:
      // 1. req.signal abort (normal close, fetch abort)
      req.signal?.addEventListener("abort", cleanup);
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
