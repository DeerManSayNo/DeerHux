import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupIsolatedWorkspace, getIsolatedRunDir } from "../lib/parallel-agent/worktree.ts";
import { captureWorktreeArtifact } from "../lib/parallel-agent/worktree-artifacts.ts";
import { atomicApply } from "../lib/parallel-agent/atomic-apply.ts";
import { readWorktreeManifest, writeWorktreeManifestAtomic } from "../lib/parallel-agent/worktree-manifest.ts";
import { getWorktreeDiagnostics } from "../lib/parallel-agent/worktree-diagnostics.ts";
import { previewWorktreeDiscard, commitWorktreeDiscard } from "../lib/parallel-agent/worktree-discard.ts";
import { collectGitFacts, planCleanup } from "../lib/parallel-agent/worktree-reconciler.ts";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-observability-")));
const runId = `obs_${randomUUID().replaceAll("-", "")}`;
const runDir = getIsolatedRunDir(runId);
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
try {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Observability Test"]);
  git(repo, ["config", "user.email", "observability@test.invalid"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const baseline = getWorktreeDiagnostics();
  const workspace = await setupIsolatedWorkspace(repo, runId, "obs-test", [{ workerId: "worker_1", displayName: "Worker" }], { environmentConfig: { mode: "none" } });
  const workerPath = workspace.worktrees.get("worker_1")!;
  fs.writeFileSync(path.join(workerPath, "result.bin"), Buffer.from([0, 1, 255, 5, 0]));
  const capture = await captureWorktreeArtifact(workspace.manifestPath, "worker_1", { diagnosticRunId: runId });
  assert.equal(capture.ok, true, capture.error ?? "capture failed");
  const captured = readWorktreeManifest(workspace.manifestPath);
  assert.equal(captured.kind, "ok");
  if (captured.kind !== "ok") throw new Error("manifest fixture unavailable");
  captured.manifest.activeOperation = null;
  writeWorktreeManifestAtomic(workspace.manifestPath, captured.manifest);
  const applyOptions = { manifestPath: workspace.manifestPath, targetCwd: repo, workerIds: ["worker_1"], transactionId: "obs-transaction", idempotencyKey: "obs-key" };
  const applied = await atomicApply(applyOptions);
  assert.equal(applied.outcome, "applied", applied.error ?? "apply failed");
  const beforeRetry = git(repo, ["diff", "--cached", "--binary"]);
  assert.equal((await atomicApply(applyOptions)).outcome, "applied");
  assert.equal(git(repo, ["diff", "--cached", "--binary"]), beforeRetry, "telemetry must not turn replay into a new write");
  const invalid = await captureWorktreeArtifact(path.join(repo, "missing-manifest.json"), "worker_1", { diagnosticRunId: runId });
  assert.equal(invalid.ok, false);
  git(repo, ["worktree", "remove", "--force", workerPath]);
  const appliedManifest = readWorktreeManifest(workspace.manifestPath);
  assert.equal(appliedManifest.kind, "ok");
  if (appliedManifest.kind !== "ok") throw new Error("applied manifest fixture unavailable");
  const recoveryFacts = collectGitFacts(appliedManifest.manifest, appliedManifest.manifest.workers[0], runDir);
  const recoveryPlan = planCleanup(
    { runDir, manifestPath: workspace.manifestPath, manifest: appliedManifest.manifest },
    { worker_1: recoveryFacts },
    { instanceId: appliedManifest.manifest.instanceId, processStartIdentity: appliedManifest.manifest.processStartIdentity },
  );
  assert.equal(recoveryPlan.workers[0].reason, "artifact_audit_retained");
  const preview = await previewWorktreeDiscard({ runId, manifestPath: workspace.manifestPath, workerIds: ["worker_1"],
    trustedRepository: { root: repo, commonDir: captured.manifest.gitCommonDir, baseCommit: captured.manifest.baseCommit } });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const discarded = await commitWorktreeDiscard({ runId, confirmationToken: preview.confirmationToken! });
  assert.equal(discarded.complete, false, "audit patch stays retained");

  const diagnostics = getWorktreeDiagnostics();
  assert.equal(diagnostics.operations.setup.started - baseline.operations.setup.started, 1);
  assert.equal(diagnostics.operations.setup.completed - baseline.operations.setup.completed, 1);
  assert.equal(diagnostics.operations.capture.outcomes.completed - baseline.operations.capture.outcomes.completed, 1);
  assert.equal(diagnostics.operations.capture.failed - baseline.operations.capture.failed, 1);
  assert.equal(diagnostics.operations.capture.binaryPatches - baseline.operations.capture.binaryPatches, 1);
  assert.equal(diagnostics.operations.apply.outcomes.checked - baseline.operations.apply.outcomes.checked, 1, "only the real check, not replay, increments checkpoint");
  assert.equal(diagnostics.operations.apply.outcomes.applied - baseline.operations.apply.outcomes.applied, 2, "terminal counters measure calls, including replay");
  assert.ok(diagnostics.operations.cleanup.outcomes.partial > baseline.operations.cleanup.outcomes.partial);
  assert.ok(diagnostics.events.some((event) => event.kind === "capture" && event.runId === runId && event.workerId === "worker_1"));
  const recoveryDecision = diagnostics.events.findLast((event) => event.phase === "decision" && event.runId === runId && event.reason === "artifact_audit_retained");
  assert.equal(recoveryDecision?.reason, "artifact_audit_retained");
  assert.equal(recoveryDecision?.facts?.worktreeExists, false);
  assert.equal(recoveryDecision?.facts?.artifactDigestMatches, true);
  assert.ok(diagnostics.operations.apply.durationP95Ms >= 0 && diagnostics.operations.apply.successRate > 0);
  for (const privateValue of [repo, runDir, "result.bin", "result.bin contents"]) {
    assert.equal(JSON.stringify(diagnostics).includes(privateValue), false);
  }
  assert.ok(fs.existsSync(capture.capture!.patchPath!), "metrics and partial cleanup retain the audit artifact");
  console.log("worktree observability integration tests passed (real setup/capture/binary/Apply replay/partial Discard, bounded redacted metrics)");
} finally {
  // Only this fixture's own repository and validated unique run directory.
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}
