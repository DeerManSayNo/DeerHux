import path from "path";
import { existsSync, readFileSync } from "fs";
import { startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { getAgentDir, resolveSessionPath } from "@/lib/session-reader";
import { classifyLlmError, isRetryableLlmErrorCode } from "@/lib/llm-gateway";
import type { CollaborationRunMode } from "./collaboration-types";
import { registerWorkerSession } from "./subagent-registry";

const WORKER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const SUBAGENT_MAX_TOOL_ROUNDS = 100;

export type WorkerSession = {
  sessionId: string;
  sendPrompt: (message: string) => Promise<string>;
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
    ? ["read", "grep", "find", "ls", "code_search", "codegraph_status", "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact"]
    : ["read", "bash", "edit", "write", "grep", "find", "ls", "code_search", "codegraph_status", "codegraph_search", "codegraph_callers", "codegraph_callees", "codegraph_impact"];
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
    sendPrompt: (message: string) => new Promise((resolve, reject) => {
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
      resetTimeout();
      unsubscribe = session.onEvent((event: AgentEvent) => {
        resetTimeout();
        if (event.type === "agent_end" && event.error) {
          settle(() => {
            reject(new Error(String(event.error)));
          });
          return;
        }
        if (event.type === "agent_end" && Array.isArray(event.messages)) {
          settle(() => {
            const messages = event.messages as Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>;
            const assistantError = getAssistantError(messages);
            if (assistantError) reject(new Error(assistantError));
            else {
              const text = textFromMessages(messages);
              // 空正文意味着模型出错（如 Request timed out / upstream rejected）
              // 但 pi 未填 event.error，且 agent_end.messages 可能不含那条 error assistant。
              // 当作可恢复错误，让上层 runWorkerPromptWithRecovery 切换备用模型重试。
              if (!text.trim()) reject(new Error("Worker produced no output (likely a model timeout or upstream error)"));
              else resolve(text);
            }
          });
        }
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
): Promise<string> {
  let lastError: unknown;
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
      return await workerSession.sendPrompt(`${retryPrefix}${prompt}`);
    } catch (error) {
      lastError = error;
      if (!isRecoverableModelError(error) || attempt >= recoveryModels.length) break;
      onRetry(recoveryModels[attempt], attempt + 1, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getAssistantError(messages: Array<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>): string | null {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return null;
  if (lastAssistant.errorMessage) return lastAssistant.errorMessage;
  return lastAssistant.stopReason === "error" ? "Model response failed" : null;
}

function isRecoverableModelError(error: unknown): boolean {
  const normalized = classifyLlmError(error);
  if (normalized.code === "UNKNOWN") {
    const message = error instanceof Error ? error.message : String(error);
    return /upstream rejected|model|provider|temporar|no output/i.test(message);
  }
  return isRetryableLlmErrorCode(normalized.code);
}

function textFromMessages(messages: Array<{ role: string; content?: unknown }>): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const content = lastAssistant?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    const record = block as { type?: string; text?: string; thinking?: string };
    if (record.type === "text") return record.text ?? "";
    if (record.type === "thinking") return record.thinking ?? "";
    return "";
  }).join("");
}
