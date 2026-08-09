// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isAmbiguousAgentCommandError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") || error instanceof TypeError;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: T;
      error?: string;
    };
    if (!res.ok || body.error) {
      throw new AgentCommandError(body.error ?? `HTTP ${res.status}`, res.status);
    }
    return body.data as T;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
