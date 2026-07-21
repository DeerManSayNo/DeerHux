import { createHash } from "node:crypto";
import { getLlmUserMessage } from "./error-classifier.ts";
import type { LlmPermit, LlmRequestMeta, LlmRequestPriority, NormalizedLlmError } from "./types.ts";
import { LlmGatewayError } from "./types.ts";

export interface RateLimitConfig {
  maxConcurrency: number;
  requestsPerMinute: number;
  tokensPerMinute?: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxConcurrency: 2,
  requestsPerMinute: 20,
  tokensPerMinute: 80_000,
  maxQueueSize: 100,
  queueTimeoutMs: 120_000,
};

type QueueItem = {
  meta: LlmRequestMeta;
  requestedAt: number;
  resolve: (permit: LlmPermit) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

type Bucket = {
  active: number;
  queue: QueueItem[];
  requestTimestamps: number[];
  drainTimer?: ReturnType<typeof setTimeout>;
};

declare global {
  var __deerhuxLlmRateLimiterBuckets: Map<string, Bucket> | undefined;
}

function getBuckets(): Map<string, Bucket> {
  if (!globalThis.__deerhuxLlmRateLimiterBuckets) {
    globalThis.__deerhuxLlmRateLimiterBuckets = new Map();
  }
  return globalThis.__deerhuxLlmRateLimiterBuckets;
}

function getConfig(): RateLimitConfig {
  return {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    maxConcurrency: readPositiveIntEnv("DEERHUX_LLM_MAX_CONCURRENCY") ?? DEFAULT_RATE_LIMIT_CONFIG.maxConcurrency,
    requestsPerMinute: readPositiveIntEnv("DEERHUX_LLM_REQUESTS_PER_MINUTE") ?? DEFAULT_RATE_LIMIT_CONFIG.requestsPerMinute,
    maxQueueSize: readPositiveIntEnv("DEERHUX_LLM_MAX_QUEUE_SIZE") ?? DEFAULT_RATE_LIMIT_CONFIG.maxQueueSize,
    queueTimeoutMs: readPositiveIntEnv("DEERHUX_LLM_QUEUE_TIMEOUT_MS") ?? DEFAULT_RATE_LIMIT_CONFIG.queueTimeoutMs,
  };
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function isLlmGatewayEnabled(): boolean {
  return process.env.DEERHUX_LLM_GATEWAY_ENABLED !== "0";
}

export function isLlmRateLimiterEnabled(): boolean {
  return isLlmGatewayEnabled() && process.env.DEERHUX_LLM_RATE_LIMITER_ENABLED !== "0";
}

export function hashLlmApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function buildBucketKey(meta: LlmRequestMeta): string {
  return [meta.provider, meta.modelId, meta.apiKeyHash ?? "default"].join(":");
}

function priorityRank(priority: LlmRequestPriority): number {
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  return 2;
}

function makeLocalError(
  code: "LOCAL_QUEUE_TIMEOUT" | "LOCAL_QUEUE_FULL",
  meta: LlmRequestMeta,
  message: string,
): LlmGatewayError {
  const normalized: NormalizedLlmError = {
    code,
    message,
    provider: meta.provider,
    modelId: meta.modelId,
    retryable: code === "LOCAL_QUEUE_TIMEOUT",
    userMessage: getLlmUserMessage(code),
    suggestedAction: code === "LOCAL_QUEUE_TIMEOUT" ? "wait" : "retry_later",
  };
  return new LlmGatewayError(normalized);
}

function pruneRequestWindow(bucket: Bucket, now: number): void {
  const cutoff = now - 60_000;
  bucket.requestTimestamps = bucket.requestTimestamps.filter((ts) => ts > cutoff);
}

function getBucket(bucketKey: string): Bucket {
  const buckets = getBuckets();
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { active: 0, queue: [], requestTimestamps: [] };
    buckets.set(bucketKey, bucket);
  }
  return bucket;
}

function canStart(bucket: Bucket, config: RateLimitConfig, now: number): boolean {
  pruneRequestWindow(bucket, now);
  return bucket.active < config.maxConcurrency && bucket.requestTimestamps.length < config.requestsPerMinute;
}

function scheduleDrain(bucketKey: string, bucket: Bucket, config: RateLimitConfig): void {
  if (bucket.queue.length === 0 || bucket.drainTimer) return;
  const now = Date.now();
  pruneRequestWindow(bucket, now);
  const oldest = bucket.requestTimestamps[0];
  if (oldest === undefined) return;
  const delayMs = Math.max(50, oldest + 60_000 - now);
  bucket.drainTimer = setTimeout(() => {
    bucket.drainTimer = undefined;
    drainBucket(bucketKey);
  }, delayMs);
  bucket.drainTimer.unref?.();
}

function cleanupItem(item: QueueItem): void {
  clearTimeout(item.timer);
  if (item.signal && item.abortListener) {
    item.signal.removeEventListener("abort", item.abortListener);
  }
}

function startItem(bucketKey: string, bucket: Bucket, item: QueueItem): void {
  cleanupItem(item);
  const now = Date.now();
  bucket.active += 1;
  bucket.requestTimestamps.push(now);
  let released = false;
  item.resolve({
    bucketKey,
    queuedMs: now - item.requestedAt,
    release: () => {
      if (released) return;
      released = true;
      bucket.active = Math.max(0, bucket.active - 1);
      drainBucket(bucketKey);
    },
  });
}

function drainBucket(bucketKey: string): void {
  const bucket = getBuckets().get(bucketKey);
  if (!bucket || bucket.queue.length === 0) return;
  const config = getConfig();
  while (bucket.queue.length > 0 && canStart(bucket, config, Date.now())) {
    const next = bucket.queue.shift();
    if (!next) return;
    startItem(bucketKey, bucket, next);
  }
  if (bucket.queue.length > 0) scheduleDrain(bucketKey, bucket, config);
}

function enqueue(bucketKey: string, bucket: Bucket, item: QueueItem): void {
  bucket.queue.push(item);
  bucket.queue.sort((a, b) => {
    const rank = priorityRank(a.meta.priority) - priorityRank(b.meta.priority);
    return rank !== 0 ? rank : a.requestedAt - b.requestedAt;
  });
}

export async function acquireLlmPermit(meta: LlmRequestMeta, signal?: AbortSignal): Promise<LlmPermit> {
  if (!isLlmRateLimiterEnabled()) {
    return { bucketKey: buildBucketKey(meta), queuedMs: 0, release: () => undefined };
  }

  const config = getConfig();
  const bucketKey = buildBucketKey(meta);
  const bucket = getBucket(bucketKey);
  const now = Date.now();
  if (canStart(bucket, config, now)) {
    bucket.active += 1;
    bucket.requestTimestamps.push(now);
    let released = false;
    return {
      bucketKey,
      queuedMs: 0,
      release: () => {
        if (released) return;
        released = true;
        bucket.active = Math.max(0, bucket.active - 1);
        drainBucket(bucketKey);
      },
    };
  }

  if (bucket.queue.length >= config.maxQueueSize) {
    throw makeLocalError("LOCAL_QUEUE_FULL", meta, `LLM local queue is full for ${bucketKey}`);
  }

  if (signal?.aborted) {
    throw makeLocalError("LOCAL_QUEUE_TIMEOUT", meta, `LLM local queue was aborted before acquiring ${bucketKey}`);
  }

  return new Promise<LlmPermit>((resolve, reject) => {
    const item: QueueItem = {
      meta,
      requestedAt: now,
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        const index = bucket.queue.indexOf(item);
        if (index >= 0) bucket.queue.splice(index, 1);
        cleanupItem(item);
        reject(makeLocalError("LOCAL_QUEUE_TIMEOUT", meta, `LLM local queue timed out for ${bucketKey}`));
      }, config.queueTimeoutMs),
    };

    if (signal) {
      item.abortListener = () => {
        const index = bucket.queue.indexOf(item);
        if (index >= 0) bucket.queue.splice(index, 1);
        cleanupItem(item);
        reject(makeLocalError("LOCAL_QUEUE_TIMEOUT", meta, `LLM local queue was aborted for ${bucketKey}`));
      };
      signal.addEventListener("abort", item.abortListener, { once: true });
    }

    enqueue(bucketKey, bucket, item);
    scheduleDrain(bucketKey, bucket, config);
  });
}

export function getLlmRateLimiterSnapshot(): Record<string, { active: number; queued: number; recentRequests: number }> {
  const now = Date.now();
  const snapshot: Record<string, { active: number; queued: number; recentRequests: number }> = {};
  for (const [bucketKey, bucket] of getBuckets()) {
    pruneRequestWindow(bucket, now);
    snapshot[bucketKey] = {
      active: bucket.active,
      queued: bucket.queue.length,
      recentRequests: bucket.requestTimestamps.length,
    };
  }
  return snapshot;
}
