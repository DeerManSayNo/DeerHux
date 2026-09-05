import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { listCollaborationRuns, startCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { sanitizeCollaborationRun } from "@/lib/parallel-agent/collaboration-sanitize";
import type { CollaborationRunMode, CollaborationWorkerSpec, SubagentWorkflow } from "@/lib/parallel-agent/collaboration-types";
import { MAX_WORKERS_PER_RUN } from "@/lib/parallel-agent/subagent-planner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeMode(value: unknown): CollaborationRunMode {
  return value === "isolated_coding" ? "isolated_coding" : "analysis";
}

function normalizeWorkflow(value: unknown): SubagentWorkflow | undefined {
  return value === "parallel" || value === "sequential" || value === "pipeline" || value === "dag" ? value : undefined;
}

function normalizeWorkers(value: unknown): CollaborationWorkerSpec[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const workers: CollaborationWorkerSpec[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as { name?: unknown; task?: unknown; dependsOn?: unknown };
    if (typeof record.name !== "string" || !record.name.trim()) return null;
    if (typeof record.task !== "string" || !record.task.trim()) return null;
    const dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.map((d) => (typeof d === "string" ? d.trim() : "")).filter(Boolean)
      : [];
    workers.push({ name: record.name.trim(), task: record.task.trim(), ...(dependsOn.length ? { dependsOn } : {}) });
  }
  return workers;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: unknown;
      message?: unknown;
      mode?: unknown;
      workflow?: unknown;
      workers?: unknown;
      parentSessionId?: unknown;
      parentEntryId?: unknown;
    };

    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }
    if (typeof body.message !== "string" || !body.message.trim()) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const workers = normalizeWorkers(body.workers);
    if (!workers) {
      return NextResponse.json({ error: "workers must be a non-empty array of { name, task }" }, { status: 400 });
    }
    if (workers.length > MAX_WORKERS_PER_RUN) {
      return NextResponse.json({ error: `Maximum ${MAX_WORKERS_PER_RUN} workers allowed` }, { status: 400 });
    }

    const state = await startCollaborationRun({
      cwd: body.cwd,
      message: body.message,
      workers,
      mode: normalizeMode(body.mode),
      workflow: normalizeWorkflow(body.workflow),
      parentSessionId: typeof body.parentSessionId === "string" && body.parentSessionId.trim() ? body.parentSessionId.trim() : undefined,
      parentEntryId: typeof body.parentEntryId === "string" && body.parentEntryId.trim() ? body.parentEntryId.trim() : undefined,
    });
    return NextResponse.json(sanitizeCollaborationRun(state));
  } catch (error) {
    if (error instanceof Error && error.message === "WORKTREE_V2_DISABLED") {
      return NextResponse.json({ error: "New isolated runs are disabled", errorCode: "WORKTREE_V2_DISABLED" }, { status: 503 });
    }
    if (error instanceof Error && /Worker (names|dependency)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parentSessionId = url.searchParams.get("parentSessionId")?.trim();
  const runs = listCollaborationRuns()
    .filter((run) => !parentSessionId || run.parentSessionId === parentSessionId)
    .map((run) => sanitizeCollaborationRun(run));
  return NextResponse.json(runs);
}
