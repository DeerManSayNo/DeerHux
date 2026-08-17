import { NextResponse } from "next/server";
import { getRpcSession, SessionCapacityError } from "@/lib/rpc-manager";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";
import { validateSessionId, SessionIdValidationError } from "@/lib/validate";
import { readSessionFileCached, resolveSessionPath } from "@/lib/session-reader";
import { isSessionPersistenceError } from "@/lib/session/errors";
import { getAgentRunStore } from "@/lib/agent-runtime/run-store";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    validateSessionId(id);
    const body = await req.json() as { type: string; [key: string]: unknown };
    const commandSignal = body.type === "prompt"
      ? AbortSignal.any([req.signal, AbortSignal.timeout(40_000)])
      : body.type === "compact"
        ? AbortSignal.any([req.signal, AbortSignal.timeout(5 * 60_000)])
        : req.signal;

    // Abort is a control-plane command: it must be low-latency and must not
    // cold-start a session just to stop it. If the runtime is already gone,
    // treat it as successfully stopped.
    if (body.type === "abort") {
      const existing = getRpcSession(id);
      if (!existing || !existing.isAlive()) {
        return NextResponse.json({ success: true, data: { alreadyStopped: true } });
      }
      const result = await existing.send(body, commandSignal);
      return NextResponse.json({ success: true, data: result });
    }

    const session = await ensureRpcSession(id);
    // 客户端在历史会话冷启动期间离开/超时后，不得继续偷偷启动 prompt。
    // 请求 signal 同时传入 wrapper，用于取消已经进入异步预处理的准入任务。
    commandSignal.throwIfAborted();
    const result = await session.send(body, commandSignal);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof SessionIdValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SessionNotFoundError) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (error instanceof SessionCapacityError) {
      return NextResponse.json({ error: error.message }, { status: 503, headers: { "Retry-After": "5" } });
    }
    if (isSessionPersistenceError(error)) {
      return NextResponse.json({ error: error.message, errorCode: error.code }, { status: 507 });
    }
    if (error instanceof Error && error.message.startsWith("AGENT_BUSY:")) {
      return NextResponse.json({ error: error.message.slice("AGENT_BUSY:".length).trim() }, { status: 409 });
    }
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json({ error: "历史会话启动超时，本次发送已安全取消" }, { status: 504 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state or verify prompt admission
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    validateSessionId(id);
    const session = getRpcSession(id);
    const clientMessageId = new URL(req.url).searchParams.get("clientMessageId")?.trim();
    if (clientMessageId) {
      const accepted: { turnId?: string } | null = session?.isAlive()
        ? session.findAcceptedPrompt(clientMessageId)
        : await resolveSessionPath(id).then((filePath): { turnId?: string } | null => {
            if (!filePath) return null;
            const { context } = readSessionFileCached(filePath);
            return context.messages.some((message) => message.role === "user" && message.clientMessageId === clientMessageId)
              ? {}
              : null;
          });
      return NextResponse.json({ running: session?.getStatus().isRunning ?? false, accepted: Boolean(accepted), turnId: accepted?.turnId });
    }
    if (!session || !session.isAlive()) {
      // Wrapper 已被回收/进程重启：用持久化 Run 事实回答「上次回合到底怎么结束的」，
      // 非终态 Run 会在 ensureRpcSession/reconcile 时收敛为 interrupted。
      return NextResponse.json({
        running: false,
        lastRun: getAgentRunStore().getLatestForSession(id) ?? null,
      });
    }

    const state = await session.send({ type: "get_state" });
    const status = session.getStatus();
    return NextResponse.json({ running: true, state, status });
  } catch (_error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
