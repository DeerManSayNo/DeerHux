import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface FastModePreferences {
  models?: Record<string, boolean>;
}

const preferencePath = () => join(getAgentDir(), "model-preferences.json");
const modelKey = (provider: string, modelId: string) => `${provider}\0${modelId}`;

let cachedMtimeMs = -1;
let cachedPreferences: FastModePreferences = {};

function readPreferences(): FastModePreferences {
  const path = preferencePath();
  try {
    const { mtimeMs } = statSync(path);
    if (mtimeMs === cachedMtimeMs) return cachedPreferences;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FastModePreferences;
    cachedMtimeMs = mtimeMs;
    cachedPreferences = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cachedMtimeMs = -1;
    cachedPreferences = {};
  }
  return cachedPreferences;
}

export function isModelFastModeEnabled(provider: string, modelId: string): boolean {
  return readPreferences().models?.[modelKey(provider, modelId)] === true;
}

export function mergeFastModePreferences(config: Record<string, unknown>): Record<string, unknown> {
  const enabled = readPreferences().models ?? {};
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return config;

  const mergedProviders = Object.fromEntries(Object.entries(providers).map(([providerName, rawProvider]) => {
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) return [providerName, rawProvider];
    const provider = rawProvider as Record<string, unknown>;
    const models = Array.isArray(provider.models)
      ? provider.models.map((rawModel) => {
          if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) return rawModel;
          const model = rawModel as Record<string, unknown>;
          const id = typeof model.id === "string" ? model.id : "";
          return enabled[modelKey(providerName, id)] ? { ...model, fastMode: true } : model;
        })
      : provider.models;
    return [providerName, { ...provider, models }];
  }));
  return { ...config, providers: mergedProviders };
}

export function extractFastModePreferences(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  preferences: FastModePreferences;
} {
  const models: Record<string, boolean> = {};
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return { config, preferences: { models } };
  }

  const cleanProviders = Object.fromEntries(Object.entries(providers).map(([providerName, rawProvider]) => {
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) return [providerName, rawProvider];
    const provider = rawProvider as Record<string, unknown>;
    const cleanModels = Array.isArray(provider.models)
      ? provider.models.map((rawModel) => {
          if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) return rawModel;
          const { fastMode, ...model } = rawModel as Record<string, unknown>;
          if (fastMode === true && typeof model.id === "string") models[modelKey(providerName, model.id)] = true;
          return model;
        })
      : provider.models;
    return [providerName, { ...provider, models: cleanModels }];
  }));
  return { config: { ...config, providers: cleanProviders }, preferences: { models } };
}

export function writeFastModePreferences(preferences: FastModePreferences): void {
  const path = preferencePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(preferences, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, path);
  cachedMtimeMs = -1;
}
