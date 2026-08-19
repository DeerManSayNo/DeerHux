"use client";

import {
  ControlPlaneHttpError,
  ControlPlaneTimeoutError,
  fetchJsonWithRetry,
} from "./client-resilience.ts";

export type ClientApiErrorKind = "http" | "network" | "timeout" | "aborted" | "invalid-json";

/** A stable error shape for browser control-plane requests. */
export class ClientApiError extends Error {
  readonly kind: ClientApiErrorKind;
  readonly status?: number;

  constructor(kind: ClientApiErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClientApiError";
    this.kind = kind;
    this.status = options.status;
  }
}

export function getClientApiErrorMessage(error: unknown): string {
  if (error instanceof ClientApiError) return error.message;
  return "请求失败，请检查网络后重试。";
}

function normalizeError(error: unknown, signal?: AbortSignal | null): ClientApiError {
  if (error instanceof ClientApiError) return error;
  if (signal?.aborted) {
    return new ClientApiError("aborted", "请求已取消。", { cause: error });
  }
  if (error instanceof ControlPlaneHttpError) {
    return new ClientApiError("http", `请求失败（HTTP ${error.status}）。`, { status: error.status, cause: error });
  }
  if (error instanceof ControlPlaneTimeoutError) {
    return new ClientApiError("timeout", `请求超时，请稍后重试。`, { cause: error });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ClientApiError("aborted", "请求已取消。", { cause: error });
  }
  return new ClientApiError("network", "请求失败，请检查网络后重试。", { cause: error });
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new ClientApiError("invalid-json", "服务器返回了无效数据。", { cause: error });
  }
}

/** Idempotent control-plane read: retry transient failures up to three times. */
export async function readControlPlaneJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  try {
    return await fetchJsonWithRetry<T>(url, { ...options, method: "GET" }, { attempts: 3, timeoutMs: 10_000 });
  } catch (error) {
    throw normalizeError(error, options.signal);
  }
}

/** High-frequency poll: one short request only, preventing stale polls from piling up. */
export async function pollControlPlaneJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  try {
    return await fetchJsonWithRetry<T>(url, { ...options, method: "GET" }, { attempts: 1, timeoutMs: 3_000 });
  } catch (error) {
    throw normalizeError(error, options.signal);
  }
}

/** Mutation boundary: a single bounded request that never replays writes automatically. */
export async function writeControlPlaneJson<T>(
  url: string,
  options: RequestInit,
  config: { timeoutMs?: number } = {},
): Promise<T> {
  const externalSignal = options.signal;
  if (externalSignal?.aborted) {
    throw normalizeError(externalSignal.reason ?? new DOMException("The request was aborted.", "AbortError"), externalSignal);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs ?? 15_000);
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new ControlPlaneHttpError(response.status);
    return await parseJson<T>(response);
  } catch (error) {
    throw normalizeError(
      timedOut ? new ControlPlaneTimeoutError(config.timeoutMs ?? 15_000, error) : error,
      externalSignal,
    );
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
