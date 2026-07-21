/**
 * 上游健康状态与冷却（in-memory，进程级）。
 *
 * 针对外部中转站高峰排队场景：当某个上游 endpoint 连续出现 TTFT 超时 / 429 /
 * 5xx 时，将其临时「冷却」（从候选集移除），让 recovery / 路由层优先选择备用
 * 模型，而不是反复撞击同一个拥堵的上游。
 *
 * 设计取舍（第二批最小实现）：
 * - 仅进程内存，不持久化、不跨进程共享。DeerHux 是单进程 Next.js 服务，
 *   足够覆盖单机场景；多副本部署需后续引入 Redis（与 rate-limiter 一致）。
 * - 冷却状态只记录与查询，不强制改变模型选择（当前 DeerHux 单模型会话，
 *   切模型由 wrapper 的 recover 命令完成）。本模块为后续「自动路由选择」
 *   提供数据基础，并可通过 getStatus 暴露给 UI / 诊断接口。
 * - key = provider:modelId:baseUrl:apiKeyHash。baseUrl 区分同 provider 同模型
 *   但走不同中转站的 endpoint；apiKeyHash 区分同 endpoint 不同 Key 的额度池。
 */

import { hashLlmApiKey } from "./rate-limiter.ts";
import type { LlmErrorCode, ModelRef } from "./types.ts";

/**
 * 带 baseUrl 的上游标识。
 *
 * baseUrl 区分同 provider、同 modelId 但走不同中转站的 endpoint（用户常见配置：
 * 同一 claude-sonnet 经多个中转站访问，各自额度池与排队状态独立）。
 */
export interface UpstreamRef {
  provider: string;
  modelId: string;
  baseUrl?: string;
}

/** 触发冷却的错误类型（排队 / 过载 / 限流）。 */
const COOLDOWN_TRIGGER_CODES: ReadonlySet<LlmErrorCode> = new Set([
  "UPSTREAM_TTFT_TIMEOUT",
  "SERVER_OVERLOADED",
  "RATE_LIMIT_REQUESTS",
  "RATE_LIMIT_TOKENS",
]);

/** 连续失败多少次进入冷却。 */
const CONSECUTIVE_FAILS_THRESHOLD = 2;

/** 基础冷却时长（ms）。指数退避：k 次冷却 = base * 2^(k-1)。 */
const BASE_COOLDOWN_MS = 30_000;

/** 冷却上限。 */
const MAX_COOLDOWN_MS = 5 * 60_000;

/** 观察窗口：连续失败计数在该窗口内累积，窗口外清零。 */
const FAIL_WINDOW_MS = 60_000;

export interface UpstreamHealthEntry {
  /** 最近一次失败时间戳。 */
  lastFailureAt: number;
  /** 失败原因码。 */
  lastFailureReason: LlmErrorCode;
  /** 观察窗口内的连续失败次数（成功后清零）。 */
  consecutiveFails: number;
  /** 当前冷却到期时间戳（0 = 未冷却）。 */
  cooldownUntil: number;
  /** 累计冷却次数（用于指数退避）。 */
  cooldownCount: number;
}

interface UpstreamHealthStore {
  entries: Map<string, UpstreamHealthEntry>;
}

declare global {
  // eslint-disable-next-line no-var
  var __deerhuxUpstreamHealth: UpstreamHealthStore | undefined;
}

function getStore(): UpstreamHealthStore {
  if (!globalThis.__deerhuxUpstreamHealth) {
    globalThis.__deerhuxUpstreamHealth = { entries: new Map() };
  }
  return globalThis.__deerhuxUpstreamHealth;
}

/**
 * 构造上游 endpoint 的稳定 key。
 *
 * provider + modelId + baseUrl + apiKeyHash。baseUrl 区分同 provider 同模型但走
 * 不同中转站的 endpoint；apiKeyHash 区分同 endpoint 不同 Key 的额度池。
 */
export function buildUpstreamKey(ref: UpstreamRef, apiKeyHash?: string): string {
  return [ref.provider, ref.modelId, ref.baseUrl ?? "default", apiKeyHash ?? "default"].join(":");
}

/** 便捷重载：从 apiKey 原文构造 key（内部 hash）。 */
export function buildUpstreamKeyFromApiKey(ref: UpstreamRef, apiKey?: string): string {
  return buildUpstreamKey(ref, hashLlmApiKey(apiKey));
}

/**
 * 记录一次上游失败。
 *
 * - 非 cooldown-trigger 错误（auth/permission/quota 等）不计入连续失败，
 *   直接返回（这些错误切备用模型也没用，应让上层明确报错）。
 * - 达到阈值 → 进入冷却，cooldownCount++ 触发指数退避。
 */
export function recordUpstreamFailure(
  ref: UpstreamRef,
  apiKeyHash: string | undefined,
  code: LlmErrorCode,
  now: number = Date.now(),
): UpstreamHealthEntry | undefined {
  if (!COOLDOWN_TRIGGER_CODES.has(code)) {
    // 非 trigger 错误（auth/permission/quota 等）不计入冷却，只回查现有 entry。
    return getStore().entries.get(buildUpstreamKey(ref, apiKeyHash));
  }
  const store = getStore();
  const key = buildUpstreamKey(ref, apiKeyHash);
  let entry = store.entries.get(key);
  if (!entry) {
    entry = freshEntry(now, code);
  }
  // 观察窗口外清零连续失败计数。
  if (now - entry.lastFailureAt > FAIL_WINDOW_MS) {
    entry.consecutiveFails = 0;
    entry.cooldownCount = 0;
  }
  entry.lastFailureAt = now;
  entry.lastFailureReason = code;
  entry.consecutiveFails += 1;
  // 达到阈值且当前未冷却 → 进入冷却（指数退避）。
  if (entry.consecutiveFails >= CONSECUTIVE_FAILS_THRESHOLD && entry.cooldownUntil <= now) {
    entry.cooldownCount += 1;
    const backoff = Math.min(
      MAX_COOLDOWN_MS,
      BASE_COOLDOWN_MS * Math.pow(2, entry.cooldownCount - 1),
    );
    entry.cooldownUntil = now + backoff;
  }
  store.entries.set(key, entry);
  return entry;
}

/**
 * 记录一次成功：清零连续失败计数，退出冷却。
 *
 * 首个流事件到达即调用，让瞬时抖动恢复的上游立即重回候选集。
 */
export function recordUpstreamSuccess(
  ref: UpstreamRef,
  apiKeyHash: string | undefined,
  now: number = Date.now(),
): void {
  const store = getStore();
  const key = buildUpstreamKey(ref, apiKeyHash);
  const entry = store.entries.get(key);
  if (!entry) return;
  entry.consecutiveFails = 0;
  entry.cooldownUntil = 0;
  entry.cooldownCount = 0;
  entry.lastFailureAt = now;
  store.entries.set(key, entry);
}

/** 该 endpoint 当前是否处于冷却期。 */
export function isUpstreamCoolingDown(
  ref: UpstreamRef,
  apiKeyHash: string | undefined,
  now: number = Date.now(),
): boolean {
  const entry = getStore().entries.get(buildUpstreamKey(ref, apiKeyHash));
  return Boolean(entry && entry.cooldownUntil > now);
}

/** 距离冷却结束还有多少 ms（已冷却返回 0，未冷却返回剩余，未记录返回 0）。 */
export function upstreamCooldownRemainingMs(
  ref: UpstreamRef,
  apiKeyHash: string | undefined,
  now: number = Date.now(),
): number {
  const entry = getStore().entries.get(buildUpstreamKey(ref, apiKeyHash));
  if (!entry || entry.cooldownUntil <= now) return 0;
  return entry.cooldownUntil - now;
}

/** 读取单个 endpoint 的健康快照（诊断 / UI 用）。 */
export function getUpstreamHealth(
  ref: UpstreamRef,
  apiKeyHash: string | undefined,
): UpstreamHealthEntry | undefined {
  return getStore().entries.get(buildUpstreamKey(ref, apiKeyHash));
}

/** 全量快照（诊断接口用）。 */
export function snapshotUpstreamHealth(now: number = Date.now()): Record<string, UpstreamHealthEntry> {
  return Object.fromEntries(getStore().entries.entries());
}

function freshEntry(now: number, code: LlmErrorCode): UpstreamHealthEntry {
  return {
    lastFailureAt: now,
    lastFailureReason: code,
    consecutiveFails: 0,
    cooldownUntil: 0,
    cooldownCount: 0,
  };
}
