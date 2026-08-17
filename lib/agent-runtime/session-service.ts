import { addAllowedRoot } from "@/lib/file-access";
import { resolveSessionPath, readSessionFileCached } from "@/lib/session-reader";
import { getAgentRunStore } from "./run-store";
import { getRpcSession, startRpcSession, AgentSessionWrapper } from "@/lib/rpc-manager";

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export async function ensureRpcSession(sessionId: string): Promise<AgentSessionWrapper> {
  // 运行时已失效的非终态 Run 必须先收敛；绝不自动重放未知副作用。
  getAgentRunStore().reconcileInterruptedRuns(sessionId);
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return existing;

  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionNotFoundError(sessionId);

  const { context, header } = readSessionFileCached(filePath);
  const cwd = header?.cwd ?? process.cwd();

  const { session } = await startRpcSession(
    sessionId,
    filePath,
    cwd,
    undefined,
    context.roleId ?? null,
    context.agentMode ?? "agent",
  );
  addAllowedRoot(cwd);
  return session;
}
