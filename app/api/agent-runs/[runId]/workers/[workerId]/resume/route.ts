import { NextResponse } from "next/server";
import { continueCollaborationWorker, getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import {
  projectCollaborationError,
  sanitizeCollaborationReasonCode,
  sanitizeCollaborationRun,
} from "@/lib/parallel-agent/collaboration-sanitize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; workerId: string }> },
) {
  const { runId, workerId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const worker = state.workers.find((item) => item.workerId === workerId);
  if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });
  if (state.canContinue === false || worker.canContinue === false) {
    return NextResponse.json({
      error: projectCollaborationError(undefined, "Worker cannot be continued"),
      errorCode: "CONTINUE_UNAVAILABLE",
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  if (!worker.sessionId) return NextResponse.json({ error: "Worker session is not available yet" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { prompt?: unknown };
  try {
    const updated = await continueCollaborationWorker(runId, workerId, typeof body.prompt === "string" ? body.prompt : undefined);
    // 脱敏后再返回，避免泄露 worker sessionId / worktreePath。
    return NextResponse.json({ run: sanitizeCollaborationRun(updated) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const errorCode = sanitizeCollaborationReasonCode(
      error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined,
    ) ?? "CONTINUE_FAILED";
    return NextResponse.json({
      error: projectCollaborationError(errorCode, "Worker cannot be continued"),
      errorCode,
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
}
