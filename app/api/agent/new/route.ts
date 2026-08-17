import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { addAllowedRoot } from "@/lib/file-access";
import { getCreatedSessionId, startRpcSession, SessionCapacityError } from "@/lib/rpc-manager";
import { ensureRpcSession } from "@/lib/agent-runtime/session-service";
import { forceRefreshSessionList, listAllSessions, readSessionFileCached } from "@/lib/session-reader";
import { normalizeAgentMode, type AgentMode } from "@/lib/agent-modes";
import { isSessionPersistenceError } from "@/lib/session/errors";

// POST /api/agent/new  body: { cwd: string; message?: string; ... }
// Spawns a brand-new DeerHux session and sends the first prompt as a single round trip.
// Returns { sessionId, data } where sessionId is DeerHux's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; creationRequestId?: unknown; [key: string]: unknown };
    const { cwd, creationRequestId: rawCreationRequestId, ...command } = body;
    const creationRequestId = typeof rawCreationRequestId === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(rawCreationRequestId)
      ? rawCreationRequestId
      : undefined;
    const commandSignal = command.type === "prompt"
      ? AbortSignal.any([req.signal, AbortSignal.timeout(40_000)])
      : req.signal;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Stable creationRequestId makes concurrent/retried new-session requests share
    // startRpcSession's lock and alias. The prompt's clientMessageId then provides
    // the durable per-session idempotency check after creation completes.
    const { provider, modelId, toolNames, thinkingLevel, roleId, agentMode, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; roleId?: string; agentMode?: AgentMode; [key: string]: unknown };

    const tempKey = creationRequestId ? `__new__${creationRequestId}` : `__new__${Date.now()}`;
    const mode = agentMode === undefined ? undefined : normalizeAgentMode(agentMode);
    let previouslyCreatedId = creationRequestId ? getCreatedSessionId(tempKey) : undefined;
    // Survive a Next.js/process restart: the durable display_user_message entry
    // is the source of truth when the in-memory creation map is gone.
    if (!previouslyCreatedId && creationRequestId) {
      const sessions = await listAllSessions();
      for (const candidate of sessions) {
        if (candidate.cwd !== cwd) continue;
        const { context } = readSessionFileCached(candidate.path);
        if (context.messages.some((message) => message.role === "user" && message.clientMessageId === creationRequestId)) {
          previouslyCreatedId = candidate.id;
          break;
        }
      }
    }
    const { session, realSessionId } = previouslyCreatedId
      ? { session: await ensureRpcSession(previouslyCreatedId), realSessionId: previouslyCreatedId }
      : await startRpcSession(
          tempKey,
          "",
          cwd,
          toolNames,
          undefined,
          mode,
          provider && modelId ? { provider, modelId } : undefined,
        );
    commandSignal.throwIfAborted();

    const clientMessageId = typeof promptCommand.clientMessageId === "string" ? promptCommand.clientMessageId.trim() : "";
    const previousAcceptance = clientMessageId ? session.findAcceptedPrompt(clientMessageId) : null;
    if (previousAcceptance) {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: { accepted: true, duplicate: true, clientMessageId, turnId: previousAcceptance.turnId },
      });
    }

    addAllowedRoot(cwd);

    // 新会话的 mode/model 已作为 composition 输入原子应用；恢复已创建会话时才补发，
    // 避免创建后 set_mode 覆盖用户显式选择的工具集。
    if (previouslyCreatedId && mode) {
      await session.send({ type: "set_mode", mode });
    }
    if (previouslyCreatedId && provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    // Persist/apply the role selection for the new session before sending the first prompt.
    if (roleId) {
      await session.send({ type: "set_role", roleId });
    }

    const result = await session.send(promptCommand, commandSignal);
    forceRefreshSessionList();

    return NextResponse.json({ success: true, sessionId: realSessionId, data: result });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json({ error: "会话启动超时，本次发送已安全取消" }, { status: 504 });
    }
    if (isSessionPersistenceError(error)) {
      return NextResponse.json({ error: error.message, errorCode: error.code }, { status: 507 });
    }
    if (error instanceof SessionCapacityError) {
      return NextResponse.json({ error: error.message }, { status: 503, headers: { "Retry-After": "5" } });
    }
    if (error instanceof Error) {
      if (error.message.startsWith("Model not found:")) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error.message.startsWith("AGENT_BUSY:")) {
        return NextResponse.json({ error: error.message.slice("AGENT_BUSY:".length).trim() }, { status: 409 });
      }
      console.error("[POST /api/agent/new]", error);
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
