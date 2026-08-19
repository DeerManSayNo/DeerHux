import assert from "node:assert/strict";
import {
  ClientApiError,
  getClientApiErrorMessage,
  pollControlPlaneJson,
  readControlPlaneJson,
  writeControlPlaneJson,
} from "../lib/client-api.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

try {
  // HTTP errors retain their status and have the same user-facing shape as other requests.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: "bad request" }, 400);
    }) as typeof fetch;

    await assert.rejects(
      () => readControlPlaneJson("/api/test"),
      (error: unknown) => error instanceof ClientApiError
        && error.kind === "http"
        && error.status === 400
        && getClientApiErrorMessage(error) === "请求失败（HTTP 400）。",
    );
    assert.equal(calls, 1, "4xx 读取不应重试");
  }

  // A caller cancellation must win over retry and preserve an aborted classification.
  {
    const controller = new AbortController();
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
      controller.abort();
    })) as typeof fetch;

    await assert.rejects(
      () => readControlPlaneJson("/api/test", { signal: controller.signal }),
      (error: unknown) => error instanceof ClientApiError && error.kind === "aborted" && error.message === "请求已取消。",
    );
  }

  // Reads retry transient network failures, then return the successful payload.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("network down");
      return jsonResponse({ ready: true });
    }) as typeof fetch;

    assert.deepEqual(await readControlPlaneJson<{ ready: boolean }>("/api/test"), { ready: true });
    assert.equal(calls, 3, "GET 应在暂时网络失败后重试");
  }

  // Polling uses the same error semantics but never creates a retry backlog.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("network down");
    }) as typeof fetch;

    await assert.rejects(
      () => pollControlPlaneJson("/api/test"),
      (error: unknown) => error instanceof ClientApiError && error.kind === "network",
    );
    assert.equal(calls, 1, "高频轮询失败不应重试");
  }

  // Writes are deliberately single-shot so an ambiguous mutation is never replayed.
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("network down");
    }) as typeof fetch;

    await assert.rejects(
      () => writeControlPlaneJson("/api/test", { method: "PUT", body: "{}" }),
      (error: unknown) => error instanceof ClientApiError && error.kind === "network",
    );
    assert.equal(calls, 1, "写入失败绝不能自动重试");
  }

  // A mutation has a bounded lifetime without gaining a retry path.
  {
    let calls = 0;
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    })) as typeof fetch;

    await assert.rejects(
      () => writeControlPlaneJson("/api/test", { method: "POST" }, { timeoutMs: 1 }),
      (error: unknown) => error instanceof ClientApiError && error.kind === "timeout",
    );
    assert.equal(calls, 1, "写入超时不得触发重试");
  }

  console.log("client-api tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
