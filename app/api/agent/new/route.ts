import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { addAllowedRoot } from "@/lib/file-access";
import { startRpcSession } from "@/lib/rpc-manager";
import { forceRefreshSessionList } from "@/lib/session-reader";
import { normalizeAgentMode, type AgentMode } from "@/lib/agent-modes";

// POST /api/agent/new  body: { cwd: string; message?: string; ... }
// Spawns a brand-new DeerHux session and sends the first prompt as a single round trip.
// Returns { sessionId, data } where sessionId is DeerHux's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    const commandSignal = command.type === "prompt"
      ? AbortSignal.any([req.signal, AbortSignal.timeout(40_000)])
      : req.signal;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, roleId, agentMode, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: string; roleId?: string; agentMode?: AgentMode; [key: string]: unknown };

    const tempKey = `__new__${Date.now()}`;
    const mode = agentMode === undefined ? undefined : normalizeAgentMode(agentMode);
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, toolNames, undefined, mode);
    commandSignal.throwIfAborted();

    addAllowedRoot(cwd);

    if (mode) {
      await session.send({ type: "set_mode", mode });
    }

    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
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
