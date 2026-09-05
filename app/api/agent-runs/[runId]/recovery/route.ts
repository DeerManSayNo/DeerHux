import { NextResponse } from "next/server";
import { inspectCollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-store";
import { buildLegacyWorktreeRecoveryReport } from "@/lib/parallel-agent/worktree-legacy-report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Export only untrusted-history metadata, never a legacy diff or filesystem path. */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = inspectCollaborationRunSnapshot(runId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const report = buildLegacyWorktreeRecoveryReport(run);
  if (!report) return NextResponse.json({ error: "Legacy recovery report is not applicable" }, { status: 409 });
  return NextResponse.json(report, { headers: {
    "Cache-Control": "no-store",
    "Content-Disposition": 'attachment; filename="legacy-worktree-recovery.json"',
    "X-Content-Type-Options": "nosniff",
  } });
}
