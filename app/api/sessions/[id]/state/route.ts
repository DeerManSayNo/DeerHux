import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { isSessionTraceEnabled } from "@/lib/session/session-trace";

/**
 * GET /api/sessions/:id/state
 *
 * Returns ONLY the live agent runtime state for a session — decoupled from
 * history loading (remediation plan §5.3). The history endpoint no longer
 * blocks on the agent runtime, so opening a session shows messages first and
 * the runtime state (running / compacting / contextUsage / systemPrompt) is
 * filled in asynchronously here.
 *
 * Behaviour:
 *  - no live rpc session → `{ running: false }` immediately
 *  - live rpc → `rpc.send({ type: "get_state" })` with a short internal
 *    timeout (5s) so a stuck runtime can never hang the caller
 *  - live runtime state read failure → conservative `{ running: true }`:
 *    unknown must not be interpreted as idle, otherwise the UI can start a
 *    second turn against a runtime that is merely slow.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const start = Date.now();
  const rpc = getRpcSession(id);

  if (!rpc?.isAlive()) {
    if (isSessionTraceEnabled()) {
      console.log(`[session-trace] sessionState id=${id} total=${Date.now() - start}ms running=false reason=no-rpc`);
    }
    return NextResponse.json({ running: false });
  }

  try {
    const state = await withTimeout(rpc.send({ type: "get_state" }), 5_000);
    if (isSessionTraceEnabled()) {
      console.log(`[session-trace] sessionState id=${id} total=${Date.now() - start}ms running=true`);
    }
    return NextResponse.json({ running: true, state });
  } catch (err) {
    // Runtime exists but didn't answer. Keep the UI locked conservatively;
    // history rendering is already decoupled and does not depend on this result.
    if (isSessionTraceEnabled()) {
      console.log(`[session-trace] sessionState id=${id} total=${Date.now() - start}ms running=false reason=timeout-or-error`);
    }
    return NextResponse.json({
      running: true,
      state: { isRunning: true },
      unavailable: true,
      error: String(err),
    });
  }
}

/**
 * Reject if the given promise doesn't settle within `ms`. Never throws if the
 * promise itself rejects — the caller's catch handles it.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`get_state timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
