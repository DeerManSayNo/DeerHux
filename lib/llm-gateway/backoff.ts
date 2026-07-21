export interface BackoffOptions {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMs?: number;
  jitterRatio?: number;
}

const DEFAULT_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 120_000;
const DEFAULT_JITTER_RATIO = 0.2;

export function addJitter(delayMs: number, jitterRatio = DEFAULT_JITTER_RATIO, random = Math.random): number {
  if (delayMs <= 0 || jitterRatio <= 0) return Math.max(0, Math.round(delayMs));
  const spread = delayMs * jitterRatio;
  const offset = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delayMs + offset));
}

export function calculateBackoffDelayMs(options: BackoffOptions): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const attempt = Math.max(1, options.attempt);
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  const rawDelay = Math.max(baseDelayMs, options.retryAfterMs ?? exponential);
  return Math.min(maxDelayMs, addJitter(rawDelay, options.jitterRatio));
}
