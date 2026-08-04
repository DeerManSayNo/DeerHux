import { AuthStorage, ModelRegistry, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface ConfiguredModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
}

interface RecoveryFallbackModel {
  provider: string;
  modelId: string;
}
type AutoRecoveryModel = RecoveryFallbackModel | null;

function getConfiguredModels(agentDir: string): Map<string, ConfiguredModel> {
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return new Map();

  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { models?: {
        id?: unknown;
        name?: unknown;
        reasoning?: unknown;
        thinkingLevelMap?: unknown;
      }[] }>;
    };
    const models = new Map<string, ConfiguredModel>();
    for (const [provider, config] of Object.entries(data.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id === "string" && model.id.trim()) {
          const id = model.id.trim();
          const name = typeof model.name === "string" && model.name.trim() ? model.name : id;
          const thinkingLevelMap = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap)
            ? model.thinkingLevelMap as Record<string, string | null>
            : undefined;
          models.set(`${provider}:${id}`, {
            id,
            name,
            provider,
            reasoning: model.reasoning === true,
            thinkingLevelMap,
          });
        }
      }
    }
    return models;
  } catch {
    return new Map();
  }
}

function getAutoRecoveryModels(agentDir: string, configuredModels: Map<string, ConfiguredModel>): AutoRecoveryModel[] {
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return [];

  try {
    const data = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      autoRecoveryModels?: unknown;
    };
    if (!Array.isArray(data.autoRecoveryModels)) return [];
    const entries = data.autoRecoveryModels
      .map((entry) => {
        if (entry === null) return null;
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const provider = typeof record.provider === "string" ? record.provider.trim() : "";
        const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
        if (!provider || !modelId) return null;
        if (!configuredModels.has(`${provider}:${modelId}`)) return null;
        return { provider, modelId };
      })
      .slice(0, 3);
    while (entries.length > 0 && entries[entries.length - 1] === null) entries.pop();
    return entries;
  } catch {
    return [];
  }
}

export async function GET() {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  let autoRecoveryModels: AutoRecoveryModel[] = [];
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  try {
    const agentDir = getAgentDir();
    const configuredModels = getConfiguredModels(agentDir);
    autoRecoveryModels = getAutoRecoveryModels(agentDir, configuredModels);
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const available = registry
      .getAvailable()
      .filter((m: { id: string; provider: string }) => configuredModels.has(`${m.provider}:${m.id}`));
    const mergedModels = new Map<string, ConfiguredModel>();
    for (const m of available) {
      const key = `${m.provider}:${m.id}`;
      mergedModels.set(key, { ...m, name: m.name || m.id });
      nameMap.set(key, m.name);
      thinkingLevels[key] = getSupportedThinkingLevels(m);
      if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }
    // models.json 可能含无效条目导致 registry 整文件加载失败；UI 只能展示
    // registry 实际能 resolve 的模型，避免选中后 set_model 100% 报 500。
    for (const [key, m] of configuredModels) {
      if (mergedModels.has(key)) continue;
      if (!registry.find(m.provider, m.id)) continue;
      mergedModels.set(key, m);
      nameMap.set(key, m.name);
      if (m.thinkingLevelMap && !thinkingLevelMaps[key]) thinkingLevelMaps[key] = m.thinkingLevelMap;
    }
    modelList = [...mergedModels.values()].map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      input: (m as { input?: ("text" | "image")[] }).input ?? ["text"],
    }));

    const settings = SettingsManager.create(process.cwd(), agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId && registry.find(provider, modelId)) {
      defaultModel = { provider, modelId };
    }
  } catch { /* return empty */ }

  return Response.json({ models: Object.fromEntries(nameMap), modelList, defaultModel, autoRecoveryModels, thinkingLevels, thinkingLevelMaps });
}

// 新增：独立接口返回模型 input 能力（纯 UI 使用，轻量）
export async function POST(req: Request) {
  try {
    const { provider, modelId } = await req.json() as { provider?: string; modelId?: string };
    if (!provider || !modelId) return Response.json({ error: "provider and modelId required" }, { status: 400 });
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    const model = registry.find(provider, modelId);
    return Response.json({ input: (model as { input?: ("text" | "image")[] } | undefined)?.input ?? ["text"] });
  } catch (error) {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
