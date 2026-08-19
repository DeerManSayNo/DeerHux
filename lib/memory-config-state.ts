export type MemoryConfigLoadStatus = "loading" | "ready" | "error";

export interface MemoryConfigLoadState<T> {
  status: MemoryConfigLoadStatus;
  data: T;
  error?: string;
}

export function loadingState<T>(data: T): MemoryConfigLoadState<T> {
  return { status: "loading", data };
}

export function readyState<T>(data: T): MemoryConfigLoadState<T> {
  return { status: "ready", data };
}

export function failedState<T>(data: T, error: string): MemoryConfigLoadState<T> {
  return { status: "error", data, error };
}

/** A missing response field is malformed, not an empty successful collection. */
export function readRequiredArray<T>(payload: unknown, field: string): T[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>)[field])) {
    throw new Error(`响应格式无效：缺少 ${field} 数组`);
  }
  return (payload as Record<string, T[]>)[field];
}

export function canEditMemory(
  globalStatus: MemoryConfigLoadStatus,
  rolesStatus: MemoryConfigLoadStatus,
): boolean {
  // Saving either scope broadcasts a roles update and refreshes both sources.
  // Do not let a partial load turn an unavailable source into an implicit empty
  // value that could be persisted during that refresh cycle.
  return globalStatus === "ready" && rolesStatus === "ready";
}
