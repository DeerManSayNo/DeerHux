import { NextResponse } from "next/server";
import { continueCollaborationWorker, getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";

/** 脱敏：不对外暴露 worker sessionId / worktreePath。 */
function sanitizeWorkers<T extends CollaborationRunSnapshot>(state: T): T {
  return {
    ...state,
    workers: state.workers.map((worker) => {
      const { sessionId: _sessionId, worktreePath: _worktreePath, ...rest } = worker;
      return rest;
    }),
  };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; workerId: string }> },
) {
  const { runId, workerId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const worker = state.workers.find((item) => item.workerId === workerId || item.name === workerId);
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  if (state.canContinue === false || worker.canContinue === false) {
    return NextResponse.json({
      error: worker.continueUnavailableReason ?? state.continueUnavailableReason ?? "Worker cannot be continued",
    }, { status: 409 });
  }
  if (!worker.sessionId) return NextResponse.json({ error: "Worker session is not available yet" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown };
  try {
    const updated = await continueCollaborationWorker(runId, workerId, typeof body.prompt === "string" ? body.prompt : undefined);
    // 脱敏后再返回，避免泄露 worker sessionId / worktreePath。
    return NextResponse.json({ run: sanitizeWorkers(updated) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
