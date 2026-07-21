/**
 * 一次性 LLM 纯推理调用辅助（无工具、无持久化、无 session）。
 *
 * 供 subagent 的 planner / aggregator 这类「失败可优雅降级到正则/静态拼接」的
 * 场景使用：任何错误（model 解析失败、网络超时、空响应）都返回 null，由调用方
 * 走 fallback，绝不中断主流程。
 *
 * 技术路径：pi-ai 的 completeSimple(model, context, options) —— 同步返回一条
 * AssistantMessage。model 经 ModelRegistry.find(provider, modelId) 解析（与主
 * session 的 set_model 同路径，apiKey 由 ModelRegistry 自动绑定）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  acquireLlmPermit,
  classifyLlmError,
  hashLlmApiKey,
  type LlmRequestKind,
  type LlmRequestMeta,
} from "@/lib/llm-gateway";
import { recordLlmError, recordLlmRequest, recordLlmSuccess } from "@/lib/llm-gateway/metrics";

export interface LlmCallOptions {
  model: { provider: string; modelId: string };
  systemPrompt: string;
  userPrompt: string;
  /** 超时 ms，默认 30s。超时返回 null（调用方降级）。 */
  timeoutMs?: number;
  /** LLM Gateway 调度类型：planner/aggregator 默认低优先级。 */
  requestKind?: Extract<LlmRequestKind, "planner" | "aggregator" | "healthcheck">;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 调一次 LLM 拿纯文本。成功返回 assistant 文本；失败/超时/空返回 null。
 * 不抛异常 —— planner/aggregator 的降级路径依赖这一点。
 */
export async function callLlmForText(options: LlmCallOptions): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestKind = options.requestKind ?? "planner";
  const meta: LlmRequestMeta = {
    provider: options.model.provider,
    modelId: options.model.modelId,
    requestKind,
    priority: "low",
    stream: false,
    estimatedInputTokens: Math.ceil((options.systemPrompt.length + options.userPrompt.length) / 4),
  };
  let permit: Awaited<ReturnType<typeof acquireLlmPermit>> | null = null;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    const [{ completeSimple }, { ModelRegistry, AuthStorage }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    const registry = ModelRegistry.create(AuthStorage.create());
    const model = registry.find(options.model.provider, options.model.modelId);
    // find 可能返回 undefined（provider/modelId 配置缺失或 modelRegistry 未注册）。
    if (!model) return null;
    const apiKeyResolver = (registry as { getApiKeyForProvider?: unknown }).getApiKeyForProvider;
    if (typeof apiKeyResolver === "function") {
      const apiKey = await apiKeyResolver.call(registry, options.model.provider);
      const apiKeyHash = hashLlmApiKey(typeof apiKey === "string" ? apiKey : undefined);
      if (apiKeyHash) meta.apiKeyHash = apiKeyHash;
    }
    recordLlmRequest(meta);
    permit = await acquireLlmPermit(meta, timeoutController.signal);
    const callPromise = completeSimple(model, {
      systemPrompt: options.systemPrompt,
      messages: [
        { role: "user", content: options.userPrompt, timestamp: Date.now() },
      ],
    });

    // completeSimple 无原生 AbortSignal 选项，用 Promise.race 兜底超时，
    // 避免模型卡住拖死整个 subagent run（worker 有自己的 30min watchdog，
    // 但 planner/aggregator 必须快速失败快速降级）。
    const assistant = await Promise.race([
      callPromise,
      new Promise<null>((resolve) => {
        timeoutController.signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
    if (!assistant) return null;
    const text = extractAssistantText(assistant);
    if (text) recordLlmSuccess(meta);
    return text;
  } catch (error) {
    const normalized = classifyLlmError(error, meta);
    recordLlmError(meta, normalized.code);
    return null;
  } finally {
    clearTimeout(timeout);
    permit?.release();
  }
}

/** 从 AssistantMessage.content 提取纯文本（跳过 thinking/tool_call 块）。 */
function extractAssistantText(assistant: AssistantMessage): string {
  if (assistant.errorMessage) return "";
  const content = assistant.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const record = block as { type?: string; text?: string };
      return record.type === "text" ? record.text ?? "" : "";
    })
    .join("")
    .trim();
}
