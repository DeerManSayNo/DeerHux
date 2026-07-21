import { NextResponse } from "next/server";
import { applyCollaborationPatches, getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  try {
    const body = await request.json().catch(() => ({})) as { workerNames?: unknown; files?: unknown };
    if (!Array.isArray(body.workerNames) || body.workerNames.some((name) => typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "workerNames must be a string array" }, { status: 400 });
    }
    if (!getCollaborationRun(runId)) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    const files = Array.isArray(body.files) ? body.files.map((file) => typeof file === "string" ? file.trim() : "").filter(Boolean) : undefined;
    const result = await applyCollaborationPatches(runId, body.workerNames.map((name) => String(name).trim()), files);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
