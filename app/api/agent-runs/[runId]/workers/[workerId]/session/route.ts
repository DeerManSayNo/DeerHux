import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Resolve a Worker Session only after an explicit user navigation request.
 * Ambient Run/SSE snapshots remain sanitized and never carry sessionId.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; workerId: string }> },
) {
  const { runId, workerId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const worker = state.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker) {
    return NextResponse.json({ error: "Worker not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (worker.workerSessionState === "deleted" || worker.workerSessionState === "expired") {
    return NextResponse.json({ error: "Worker Session 已不可用" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  if (!worker.sessionId) {
    return NextResponse.json({ error: "Worker Session 尚未就绪" }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  const sessionPath = await resolveSessionPath(worker.sessionId);
  if (!sessionPath || !existsSync(sessionPath)) {
    return NextResponse.json({ error: "Worker Session 已不可用" }, { status: 410, headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json({ sessionId: worker.sessionId }, { headers: { "Cache-Control": "no-store" } });
}
