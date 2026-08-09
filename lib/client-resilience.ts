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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit = {},
  config: { attempts?: number; timeoutMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, config.attempts ?? 3);
  const timeoutMs = config.timeoutMs ?? 10_000;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || attempt === attempts - 1) throw error;
    } finally {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }

    // Give a saturated event loop time to drain; jitter avoids all panels
    // retrying models/roles/sessions in the same tick.
    await delay(350 * (2 ** attempt) + Math.floor(Math.random() * 150));
  }

  throw lastError;
}
