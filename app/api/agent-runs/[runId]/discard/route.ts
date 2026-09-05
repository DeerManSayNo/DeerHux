import { NextResponse } from "next/server";
import { getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { emitCollaborationRunEvent, updateCollaborationRun } from "@/lib/parallel-agent/collaboration-store";
import { getIsolatedRunDir } from "@/lib/parallel-agent/worktree";
import path from "node:path";
import { GitRepository } from "@/lib/parallel-agent/git-repository";
import {
  commitWorktreeDiscard,
  DISCARD_STRONG_CONFIRMATION,
  previewWorktreeDiscard,
} from "@/lib/parallel-agent/worktree-discard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function invalid(message: string) {
  return NextResponse.json({ error: message, errorCode: "INVALID_REQUEST" }, { status: 400 });
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Array.isArray(body) || (body.mode !== "preview" && body.mode !== "commit")) return invalid("mode must be preview or commit");
  const allowed = body.mode === "preview" ? ["mode", "workerIds", "strongConfirmation"] : ["mode", "confirmationToken"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return invalid("request contains unknown fields");
  const state = getCollaborationRun(runId);
  if (!state) return NextResponse.json({ error: "Run not found", errorCode: "RUN_NOT_FOUND" }, { status: 404 });
  if (state.mode !== "isolated_coding" || !state.worktreeManifestPath) {
    return NextResponse.json({ error: "Run has no isolated worktree", errorCode: "DISCARD_NOT_SUPPORTED" }, { status: 409 });
  }
  let expectedManifestPath: string;
  try { expectedManifestPath = path.join(getIsolatedRunDir(runId), "worktree-manifest.json"); }
  catch { return NextResponse.json({ error: "Run identity is invalid", errorCode: "RUN_NOT_FOUND" }, { status: 404 }); }
  if (path.resolve(state.worktreeManifestPath) !== expectedManifestPath) {
    return NextResponse.json({ error: "Run manifest identity does not match", errorCode: "MANIFEST_UNAVAILABLE" }, { status: 409 });
  }
  if (body.mode === "preview") {
    if (!Array.isArray(body.workerIds) || body.workerIds.length === 0 || body.workerIds.length > 32
      || body.workerIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 200 || id !== id.trim())
      || new Set(body.workerIds).size !== body.workerIds.length) return invalid("workerIds must be a non-empty unique string array");
    if (body.strongConfirmation !== undefined && body.strongConfirmation !== DISCARD_STRONG_CONFIRMATION) return invalid("strongConfirmation is invalid");
    const sessionCapabilities = Object.fromEntries(state.workers.map((worker) => [worker.workerId, { hasSession: Boolean(worker.sessionId), canContinue: Boolean(worker.canContinue) }]));
    // This authority comes from the host-created Run, never from request/manifest data.
    let trustedRepository;
    try {
      if (!state.baseCommit) throw new Error("Missing creation baseline");
      const repository = await GitRepository.open(state.cwd);
      trustedRepository = { root: repository.root, commonDir: repository.commonDir, baseCommit: state.baseCommit };
    } catch {
      return NextResponse.json({ error: "Run repository identity is unavailable", errorCode: "REPOSITORY_MISMATCH" }, { status: 409 });
    }
    const result = await previewWorktreeDiscard({
      runId,
      manifestPath: state.worktreeManifestPath,
      workerIds: body.workerIds as string[],
      strongConfirmation: body.strongConfirmation as string | undefined,
      sessionCapabilities,
      trustedRepository,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : result.errorCode === "WORKER_UNKNOWN" ? 400 : 409, headers: { "Cache-Control": "no-store" } });
  }
  if (typeof body.confirmationToken !== "string" || body.confirmationToken.length < 20 || body.confirmationToken.length > 200) return invalid("confirmationToken is invalid");
  const result = await commitWorktreeDiscard({ runId, confirmationToken: body.confirmationToken });
  if (result.workers.length > 0) {
    const retained = result.workers.some((worker) => worker.retainedResources.length > 0);
    const persisted = updateCollaborationRun(runId, (run) => {
      for (const cleanup of result.workers) {
        const worker = run.workers.find((candidate) => candidate.workerId === cleanup.workerId);
        if (!worker) continue;
        worker.canContinue = false;
        worker.continueUnavailableReason = retained ? "manual_recovery_required" : "worktree_discarded";
        if (cleanup.worktreeRemoved) {
          worker.worktreePath = undefined;
        }
        if (cleanup.patchRemoved) {
          worker.patchSha256 = undefined;
          worker.patchBytes = undefined;
        }
      }
      if (retained) {
        run.captureState = "preserved";
        run.recoveryState = "manual_recovery_required";
        if (run.status !== "applied" && run.status !== "aborted") run.status = "recoverable";
      }
      run.canContinue = false;
      run.continueUnavailableReason = retained ? "manual_recovery_required" : "worktree_discarded";
    });
    if (!persisted) {
      result.ok = false;
      result.complete = false;
      result.errorCode = "INTERNAL_ERROR";
      emitCollaborationRunEvent({
        type: "worktree_cleanup_error", runId,
        errorCode: "WORKTREE_CLEANUP_STATE_PERSISTENCE_FAILED",
        reasonCode: "WORKTREE_CLEANUP_STATE_PERSISTENCE_FAILED",
        error: "Worktree cleanup state could not be persisted",
      });
    }
    if (persisted) {
      for (const worker of result.workers) {
        emitCollaborationRunEvent(worker.success
          ? { type: "worktree_cleanup_completed", runId, workerId: worker.workerId, reasonCode: "WORKTREE_CLEANUP_COMPLETED" }
          : worker.retainedResources.length > 0
            ? { type: "worktree_preserved", runId, workerId: worker.workerId, reasonCode: "PRESERVED_FOR_RECOVERY" }
            : { type: "worktree_cleanup_error", runId, workerId: worker.workerId, errorCode: "WORKTREE_CLEANUP_PARTIAL", reasonCode: "WORKTREE_CLEANUP_PARTIAL", error: "Worktree cleanup did not complete" });
      }
    }
  }
  const status = result.complete ? 200 : result.workers.length > 0 ? 207
    : result.errorCode === "TOKEN_INVALID" || result.errorCode === "TOKEN_EXPIRED" ? 401
    : result.errorCode === "MANIFEST_CHANGED" || result.errorCode === "PRECONDITION_FAILED" ? 412 : 500;
  return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
}
