import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { ensureRpcSession, SessionNotFoundError } from "@/lib/agent-runtime/session-service";
import { validateSessionId, SessionIdValidationError } from "@/lib/validate";

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
    if (error instanceof Error && error.message.startsWith("AGENT_BUSY:")) {
      return NextResponse.json({ error: error.message.slice("AGENT_BUSY:".length).trim() }, { status: 409 });
    }
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json({ error: "历史会话启动超时，本次发送已安全取消" }, { status: 504 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    validateSessionId(id);
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    const status = session.getStatus();
    return NextResponse.json({ running: true, state, status });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
