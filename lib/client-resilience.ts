"use client";

/**
 * Small resilience helpers for control-plane GET requests.
 *
 * Agent streaming and UI metadata travel over different HTTP connections. Under
 * CPU pressure a metadata request can time out while SSE keeps flowing, so a
 * transient failure must not erase the last usable models/roles/sessions state.
 */
export function readCachedJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: T };
    return parsed.value ?? null;
  } catch {
    return null;
  }
}

export function writeCachedJson<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    // Private browsing/quota failures must not affect the live UI.
  }
}

export class ControlPlaneHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "ControlPlaneHttpError";
    this.status = status;
  }
}

export class ControlPlaneTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`请求超时（${timeoutMs}ms）`, cause === undefined ? undefined : { cause });
    this.name = "ControlPlaneTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isRetryableReadError(error: unknown): boolean {
  if (error instanceof ControlPlaneHttpError) return error.status >= 500;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return true;
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit = {},
  config: { attempts?: number; timeoutMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, config.attempts ?? 3);
  const timeoutMs = config.timeoutMs ?? 10_000;
  const externalSignal = options.signal;
  if (externalSignal?.aborted) {
    throw externalSignal.reason ?? new DOMException("The request was aborted.", "AbortError");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal) externalSignal.addEventListener("abort", abortFromExternal, { once: true });

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new ControlPlaneHttpError(response.status);
      return await response.json() as T;
    } catch (error) {
      lastError = timedOut ? new ControlPlaneTimeoutError(timeoutMs, error) : error;
      if (externalSignal?.aborted || !isRetryableReadError(lastError) || attempt === attempts - 1) throw lastError;
    } finally {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }

    // Give a saturated event loop time to drain; jitter avoids all panels
    // retrying models/roles/sessions in the same tick.
    await delay(350 * (2 ** attempt) + Math.floor(Math.random() * 150));
  }

  throw lastError;
}
