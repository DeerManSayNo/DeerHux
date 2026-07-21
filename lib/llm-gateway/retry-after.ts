function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getHeader(headers: unknown, name: string): unknown {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name);
  }

  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      return (headers as { get: (key: string) => unknown }).get(name);
    } catch {
      return undefined;
    }
  }

  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function parseSecondsOrDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000 ? Math.max(0, Math.round(value - Date.now())) : Math.max(0, Math.round(value * 1000));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function parseResetHeader(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000 ? Math.max(0, Math.round(value * 1000 - Date.now())) : Math.max(0, Math.round(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000 ? Math.max(0, Math.round(numeric * 1000 - Date.now())) : Math.max(0, Math.round(numeric * 1000));
  }
  return parseSecondsOrDate(trimmed);
}

export function parseRetryAfterMs(value: unknown): number | null {
  const direct = parseSecondsOrDate(value);
  return direct === null ? null : Math.min(direct, 10 * 60 * 1000);
}

export function extractRetryAfterMs(error: unknown): number | null {
  const candidates: unknown[] = [];
  if (isRecord(error)) {
    candidates.push(error.retryAfterMs, error.retryAfter, error["retry-after"]);
    candidates.push(getHeader(error.headers, "retry-after"));
    candidates.push(getHeader(error.headers, "x-ratelimit-reset-requests"));
    candidates.push(getHeader(error.headers, "x-ratelimit-reset-tokens"));
    candidates.push(getHeader(error.response, "retry-after"));
    if (isRecord(error.response)) {
      candidates.push(getHeader(error.response.headers, "retry-after"));
      candidates.push(getHeader(error.response.headers, "x-ratelimit-reset-requests"));
      candidates.push(getHeader(error.response.headers, "x-ratelimit-reset-tokens"));
    }
  }

  for (const candidate of candidates) {
    const retryAfter = parseRetryAfterMs(candidate) ?? parseResetHeader(candidate);
    if (retryAfter !== null) return retryAfter;
  }
  return null;
}
