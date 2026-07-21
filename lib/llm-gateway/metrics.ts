import type { LlmErrorCode, LlmRequestKind, LlmRequestMeta } from "./types.ts";

type CounterMap = Map<string, number>;

interface LlmGatewayMetricsStore {
  counters: CounterMap;
}

declare global {
  var __deerhuxLlmGatewayMetrics: LlmGatewayMetricsStore | undefined;
}

function getStore(): LlmGatewayMetricsStore {
  if (!globalThis.__deerhuxLlmGatewayMetrics) {
    globalThis.__deerhuxLlmGatewayMetrics = { counters: new Map() };
  }
  return globalThis.__deerhuxLlmGatewayMetrics;
}

function key(name: string, labels: Record<string, string | number | undefined>): string {
  const suffix = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label] ?? ""}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
}

export function incrementLlmMetric(name: string, labels: Record<string, string | number | undefined> = {}, value = 1): void {
  const store = getStore();
  const metricKey = key(name, labels);
  store.counters.set(metricKey, (store.counters.get(metricKey) ?? 0) + value);
}

export function recordLlmRequest(meta: LlmRequestMeta): void {
  incrementLlmMetric("llm.requests.total", {
    provider: meta.provider,
    model: meta.modelId,
    kind: meta.requestKind,
  });
}

export function recordLlmSuccess(meta: LlmRequestMeta): void {
  incrementLlmMetric("llm.requests.success", {
    provider: meta.provider,
    model: meta.modelId,
    kind: meta.requestKind,
  });
}

export function recordLlmError(meta: Partial<LlmRequestMeta>, code: LlmErrorCode): void {
  incrementLlmMetric("llm.errors.total", {
    provider: meta.provider,
    model: meta.modelId,
    kind: meta.requestKind as LlmRequestKind | undefined,
    errorCode: code,
  });
  if (code === "RATE_LIMIT_REQUESTS" || code === "RATE_LIMIT_TOKENS") {
    incrementLlmMetric("llm.rate_limited.total", {
      provider: meta.provider,
      model: meta.modelId,
      limitType: code === "RATE_LIMIT_TOKENS" ? "tokens" : "requests",
    });
  }
}

export function snapshotLlmGatewayMetrics(): Record<string, number> {
  return Object.fromEntries(getStore().counters.entries());
}
