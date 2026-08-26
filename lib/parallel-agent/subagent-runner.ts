import path from "path";
import { existsSync, readFileSync } from "fs";
import { startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { getAgentDir, resolveSessionPath } from "@/lib/session-reader";
import { classifyLlmError, isRetryableLlmErrorCode } from "@/lib/llm-gateway";
import type { CollaborationRunMode } from "./collaboration-types";
import { registerWorkerSession } from "./subagent-registry";
import { resolveWorkerOutcome, type AssistantSnapshot } from "./subagent-outcome";

const WORKER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const SUBAGENT_MAX_TOOL_ROUNDS = 100;

export type WorkerSession = {
  sessionId: string;
  sendPrompt: (message: string, onStarted?: () => void) => Promise<string>;
  setModel: (model: RecoveryModel) => Promise<void>;
  listen: (listener: (event: AgentEvent) => void) => () => void;
  abort: () => Promise<void>;
  destroy: () => void;
};

export type RecoveryModel = { provider: string; modelId: string };

export function getAutoRecoveryModels(): RecoveryModel[] {
  const modelsPath = path.join(getAgentDir(), "models.json");
  if (!existsSync(modelsPath)) return [];
  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as { autoRecoveryModels?: unknown };
    if (!Array.isArray(data.autoRecoveryModels)) return [];
    return data.autoRecoveryModels.flatMap((entry): RecoveryModel[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { provider?: unknown; modelId?: unknown };
      const provider = typeof record.provider === "string" ? record.provider.trim() : "";
      const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
      return provider && modelId ? [{ provider, modelId }] : [];
    }).slice(0, 3);
  } catch {
    return [];
  }
}

export async function createSubagentWorkerSession(
  cwd: string,
  mode: CollaborationRunMode,
  existingSessionId?: string,
  origin?: { parentSessionId?: string; runId?: string; workerName?: string },
  parentModel?: { provider: string; modelId: string },
): Promise<WorkerSession> {
  const sessionFile = existingSessionId ? await resolveSessionPath(existingSessionId) : "";
  if (existingSessionId && !sessionFile) throw new Error("Worker session file was not found");
  const tempKey = existingSessionId ?? `__collab__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tools = mode === "analysis"
    ? ["read", "grep", "find", "ls", "code_search", "codegraph"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls", "code_search", "codegraph"];
  const { session, realSessionId } = await startRpcSession(
    tempKey,
    sessionFile || "",
    cwd,
    tools,
    undefined,
    undefined,
    parentModel,
    { allowSubagentTool: false, maxToolRounds: SUBAGENT_MAX_TOOL_ROUNDS, requestKind: "subagent" },
  );

  // Record this worker session's origin so the sidebar can hide it from the
  // top-level project list and the UI can surface it under its parent message
  // instead. pi's SessionManager.create has no parent notion, so we keep our
  // own index (see subagent-registry).
  if (origin) {
    registerWorkerSession({
      workerSessionId: realSessionId,
      parentSessionId: origin.parentSessionId,
      runId: origin.runId,
      workerName: origin.workerName,
      mode,
      createdAt: new Date().toISOString(),
    });
  }

  const workerSession: WorkerSession = {
    sessionId: realSessionId,
    sendPrompt: (message: string, onStarted?: () => void) => new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        unsubscribe();
        fn();
      };
      let unsubscribe: () => void = () => undefined;
      const resetTimeout = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => settle(() => {
          reject(new Error("Worker session made no progress for 30 minutes"));
        }), WORKER_INACTIVITY_TIMEOUT_MS);
      };
      let lastAssistant: AssistantSnapshot | null = null;
      resetTimeout();
      unsubscribe = session.onEvent((event: AgentEvent) => {
        resetTimeout();
        if (event.type === "agent_start") {
          try { onStarted?.(); } catch { /* UI readiness must not fail a started worker turn */ }
          return;
        }
        if (event.type === "message_end") {
          const completed = event.message as typeof lastAssistant;
          if (completed?.role === "assistant") lastAssistant = completed;
          return;
        }
        if (event.type !== "agent_end") return;
        const outcome = resolveWorkerOutcome(lastAssistant, {
          willRetry: event.willRetry,
          error: event.error,
        });
        if (outcome.kind === "pending") return;
        settle(() => {
          if (outcome.kind === "reject") reject(new Error(outcome.error));
          else resolve(outcome.text);
        });
      });
      session.send({ type: "prompt", message }).catch((error: unknown) => {
        settle(() => {
          reject(error);
        });
      });
    }),
    setModel: async (model) => {
      await session.send({ type: "set_model", provider: model.provider, modelId: model.modelId });
    },
    listen: (listener) => session.onEvent(listener),
    abort: async () => { await session.send({ type: "abort" }); },
    destroy: () => session.destroy(),
  };
  // ★ 父 model 通过 startRpcSession 的 model 参数在创建 engine 时直接注入
  //   （见 startDeerLoopSession 的 modelOverride），而非创建后再 setModel——
  //   后者在 prompt 期间会被 _isRunning 拒绝，且 worker 默认 model 与父 session
  //   不一致会导致超时。
  return workerSession;
}

export async function runWorkerPromptWithRecovery(
  workerSession: WorkerSession,
  prompt: string,
  recoveryModels: RecoveryModel[],
  onRetry: (model: RecoveryModel, attempt: number, error: unknown) => void,
  onStarted?: () => void,
): Promise<string> {
  let lastError: unknown;
  let startedNotified = false;
  const notifyStarted = () => {
    if (startedNotified) return;
    startedNotified = true;
    onStarted?.();
  };
  for (let attempt = 0; attempt <= recoveryModels.length; attempt += 1) {
    const fallbackModel = attempt > 0 ? recoveryModels[attempt - 1] : null;
    try {
      if (fallbackModel) {
        // 切换 recovery model 前先 abort：上一轮 sendPrompt 超时 reject 来自
        // workerSession 的 30min watchdog，engine 的 prompt loop 可能仍在 running
        //（_isRunning=true），此时 setModel 会抛 "prompt 正在运行"。先 abort 让
        // loop 进入 idle 态，setModel 才能成功。
        await workerSession.abort().catch(() => {});
        await workerSession.setModel(fallbackModel);
      }
      const retryPrefix = fallbackModel
        ? `上一轮子 Agent 请求失败，已切换到自动恢复模型 ${fallbackModel.provider}/${fallbackModel.modelId}。请重新完成同一个子任务，不要依赖上一轮失败输出。\n\n`
        : "";
      return await workerSession.sendPrompt(`${retryPrefix}${prompt}`, notifyStarted);
    } catch (error) {
      lastError = error;
      if (!isRecoverableModelError(error) || attempt >= recoveryModels.length) break;
      onRetry(recoveryModels[attempt], attempt + 1, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRecoverableModelError(error: unknown): boolean {
  const normalized = classifyLlmError(error);
  if (normalized.code === "UNKNOWN") {
    const message = error instanceof Error ? error.message : String(error);
    return /upstream rejected|model|provider|temporar|no output/i.test(message);
  }
  return isRetryableLlmErrorCode(normalized.code);
}
