type JsonObject = Record<string, unknown>;

export type ImportedProviders = Record<string, JsonObject>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeProviderConfig(name: string, provider: JsonObject): string {
  return JSON.stringify({ providers: { [name]: provider } }, null, 2);
}

export function parseProviderConfigJson(text: string): ImportedProviders {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式无效，请检查逗号、引号和括号");
  }

  if (!isObject(parsed) || !isObject(parsed.providers)) {
    throw new Error('JSON 必须包含 "providers" 对象');
  }

  const entries = Object.entries(parsed.providers);
  if (entries.length === 0) throw new Error("JSON 中没有可导入的服务商");

  const providers: ImportedProviders = {};
  for (const [name, provider] of entries) {
    if (!name.trim()) throw new Error("服务商名称不能为空");
    if (!isObject(provider)) throw new Error(`服务商 ${name} 的配置必须是对象`);
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      throw new Error(`服务商 ${name} 的 models 必须是数组`);
    }
    if (Array.isArray(provider.models)) {
      const invalidIndex = provider.models.findIndex((model) =>
        !isObject(model) || typeof model.id !== "string" || !model.id.trim());
      if (invalidIndex >= 0) {
        throw new Error(`服务商 ${name} 的第 ${invalidIndex + 1} 个模型缺少有效的 id`);
      }
    }
    providers[name] = provider;
  }
  return providers;
}
