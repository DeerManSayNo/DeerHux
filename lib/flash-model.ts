/**
 * 全局唯一的 Flash 模型引用。
 *
 * 存储在 `~/.deerhux/agent/models.json` 的顶层 `flashModel` 字段，
 * 与 `autoRecoveryModels` 同级。轻量快速任务（解释选中文字等）优先使用它，
 * 未配置时调用方回退到当前会话模型。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface FlashModelRef {
  provider: string;
  modelId: string;
}

export function getFlashModel(): FlashModelRef | null {
  const modelsPath = join(getAgentDir(), "models.json");
  if (!existsSync(modelsPath)) return null;
  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as { flashModel?: unknown };
    const entry = data.flashModel;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
    if (!provider || !modelId) return null;
    return { provider, modelId };
  } catch {
    return null;
  }
}
