import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionCreationStore, SessionCreationError, findPromptReceipt } from "@/lib/session/creation-store";
import { addAllowedRoot } from "@/lib/file-access";
import { startRpcSession, SessionCapacityError } from "@/lib/rpc-manager";
import { forceRefreshSessionList, listAllSessions, readSessionFileCached, getAgentDir } from "@/lib/session-reader";
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

    const { provider, modelId, toolNames, thinkingLevel, roleId, agentMode, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; roleId?: string; agentMode?: AgentMode; [key: string]: unknown };
    const clientMessageId = typeof promptCommand.clientMessageId === "string" ? promptCommand.clientMessageId.trim() : "";
    if (rawCreationRequestId !== undefined && !creationRequestId) {
      return NextResponse.json({ error: "Invalid creationRequestId" }, { status: 400 });
    }
    if (creationRequestId && command.type === "prompt" && clientMessageId !== creationRequestId) {
      return NextResponse.json({ error: "creationRequestId must match clientMessageId" }, { status: 400 });
    }
    const requestId = creationRequestId ?? `v2_${randomUUID()}`;
    const store = new SessionCreationStore(join(getAgentDir(), "session-creations"));
    return await store.withRequest(cwd, requestId, commandSignal, async () => {
      const record = await store.prepare(cwd, requestId, () => {
        const manager = SessionManager.create(cwd);
        return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, header: manager.getHeader()! };
      }, async () => {
        for (const candidate of await listAllSessions()) {
          if (resolve(candidate.cwd) !== resolve(cwd)) continue;
          if (await findPromptReceipt(candidate.path, requestId, commandSignal)) {
            return { sessionId: candidate.id, sessionFile: candidate.path };
          }
        }
        return undefined;
      });
      // Read the durable acceptance receipt before restoring a runtime, including
      // retries of sessions that have subsequently grown beyond the UI read limit.
      const receipt = clientMessageId ? await findPromptReceipt(record.sessionFile, clientMessageId, commandSignal) : null;
      if (receipt) {
        return NextResponse.json({ success: true, sessionId: record.sessionId,
          data: { accepted: true, duplicate: true, clientMessageId, turnId: receipt.turnId } });
      }
      let context;
      try { context = readSessionFileCached(record.sessionFile).context; }
      catch { throw new SessionCreationError("此前创建的会话无法读取（文件过大或内容异常），已停止重试以避免重复执行"); }
      const mode = agentMode === undefined ? context.agentMode : normalizeAgentMode(agentMode);
      const { session, realSessionId } = await startRpcSession(
        record.sessionId, record.sessionFile, cwd, toolNames, context.roleId,
        mode, provider && modelId ? { provider, modelId } : undefined,
      );
      commandSignal.throwIfAborted();

      const previousAcceptance = clientMessageId ? session.findAcceptedPrompt(clientMessageId) : null;
      if (previousAcceptance) {
        return NextResponse.json({
          success: true,
          sessionId: realSessionId,
          data: { accepted: true, duplicate: true, clientMessageId, turnId: previousAcceptance.turnId },
        });
      }

      addAllowedRoot(cwd);

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
    });
  } catch (error) {
    if (error instanceof SessionCreationError) {
      return NextResponse.json({ error: error.message, errorCode: "SESSION_CREATION_FAILED" }, { status: error.status });
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
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
