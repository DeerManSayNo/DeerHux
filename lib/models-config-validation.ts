/** Shared draft validation; the server additionally checks the runtime schema. */
export function findEmptyModelId(config: unknown): { provider: string; index: number; message: string } | null {
  if (!config || typeof config !== "object" || !("providers" in config)) return null;
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  for (const [provider, value] of Object.entries(providers)) {
    if (!value || typeof value !== "object" || !Array.isArray(value.models)) continue;
    const index = value.models.findIndex((model: unknown) =>
      !model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string" || !model.id.trim());
    if (index >= 0) return { provider, index, message: `${provider} 的第 ${index + 1} 个模型缺少模型 ID，请填写或删除该模型后再保存。` };
  }
  return null;
}
