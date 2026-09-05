import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicApply } from "../lib/parallel-agent/atomic-apply.ts";
import { captureWorktreeArtifact } from "../lib/parallel-agent/worktree-artifacts.ts";
import { reconcileRuns } from "../lib/parallel-agent/worktree-reconciler.ts";
import { readWorktreeManifest, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-restart-redteam-")));
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  const repo = path.join(sandbox, "repo");
  fs.mkdirSync(repo); git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Restart Redteam"]); git(repo, ["config", "user.email", "restart@example.invalid"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const runsRoot = path.join(sandbox, "runs");
  const runId = "run_restart_applied";
  const runDir = path.join(runsRoot, runId); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const worktreePath = path.join(runDir, "1-worker_1");
  const branch = `deerhux/${runId}/1-worker_1`;
  git(repo, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const manifest: WorktreeManifestV1 = { version: 1, runId, instanceId: "dead-owner", ownerPid: 2_147_483_647,
    processStartIdentity: "dead-owner", heartbeatAt: createdAt, activeOperation: null, repoRoot: repo,
    gitCommonDir: path.join(repo, ".git"), sourceCwdRelative: ".", baseCommit, state: "running", apply: null,
    workers: [{ workerId: "worker_1", displayName: "Worker", index: 0, worktreePath, agentCwd: worktreePath,
      branch, provider: "test", state: "running", capture: null, cleanup: null }],
    createdAt, updatedAt: createdAt, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const manifestPath = path.join(runDir, "worktree-manifest.json"); writeWorktreeManifestAtomic(manifestPath, manifest);
  fs.writeFileSync(path.join(worktreePath, "source.txt"), "worker result\n");
  const captured = await captureWorktreeArtifact(manifestPath, "worker_1"); assert.equal(captured.ok, true);
  const interrupted = structuredClone(manifest);
  interrupted.runId = "run_restart_interrupted";
  interrupted.state = "running"; interrupted.activeOperation = "continue";
  const interruptedDir = path.join(runsRoot, interrupted.runId); fs.mkdirSync(interruptedDir, { mode: 0o700 });
  const interruptedWorker = interrupted.workers[0];
  interruptedWorker.branch = `deerhux/${interrupted.runId}/1-worker_1`;
  interruptedWorker.worktreePath = interruptedWorker.agentCwd = path.join(interruptedDir, "1-worker_1");
  git(repo, ["worktree", "add", "-b", interruptedWorker.branch, interruptedWorker.worktreePath, baseCommit]);
  const interruptedArtifact = path.join(interruptedDir, "artifacts", "previous.patch");
  fs.mkdirSync(path.dirname(interruptedArtifact), { mode: 0o700 }); fs.copyFileSync(captured.capture!.patchPath!, interruptedArtifact);
  interruptedWorker.capture = { ...captured.capture!, patchPath: interruptedArtifact, workerBranch: interruptedWorker.branch };
  const interruptedManifestPath = path.join(interruptedDir, "worktree-manifest.json"); writeWorktreeManifestAtomic(interruptedManifestPath, interrupted);
  fs.writeFileSync(path.join(interruptedWorker.worktreePath, "unsettled.txt"), "interrupted Continue output\n");
  const discarded = structuredClone(manifest); discarded.runId = "run_restart_discarded"; discarded.state = "discarded";
  const discardedDir = path.join(runsRoot, discarded.runId); fs.mkdirSync(discardedDir, { mode: 0o700 });
  discarded.workers[0].worktreePath = discarded.workers[0].agentCwd = path.join(discardedDir, "1-worker_1");
  discarded.workers[0].branch = `deerhux/${discarded.runId}/1-worker_1`; discarded.workers[0].state = "removed";
  discarded.workers[0].cleanup = { intent: "discard", eligibility: "eligible", checkedAt: createdAt, worktreeRemoved: true, branchRemoved: true, reason: "explicit_discard" };
  const discardedManifestPath = path.join(discardedDir, "worktree-manifest.json"); writeWorktreeManifestAtomic(discardedManifestPath, discarded);
  const discardedBytes = fs.readFileSync(discardedManifestPath);
  await reconcileRuns({ runsRoot, instanceId: "new-owner", processStartIdentity: "new-owner", isProcessAlive: () => false });
  const afterInterrupted = readWorktreeManifest(interruptedManifestPath); assert.equal(afterInterrupted.kind, "ok");
  assert.equal(afterInterrupted.kind === "ok" && afterInterrupted.manifest.state, "preserved", "interrupted Continue must not revive its previous capture as a settled result");
  assert.equal(afterInterrupted.kind === "ok" && afterInterrupted.manifest.activeOperation, null);
  assert.deepEqual(afterInterrupted.kind === "ok" && afterInterrupted.manifest.workers[0].capture, interruptedWorker.capture);
  assert.equal(fs.readFileSync(path.join(interruptedWorker.worktreePath, "unsettled.txt"), "utf8"), "interrupted Continue output\n");
  assert.deepEqual(fs.readFileSync(discardedManifestPath), discardedBytes, "settled discarded fact must not be rewritten or downgraded");
  if (process.argv.includes("--captured")) {
    await reconcileRuns({ runsRoot, instanceId: "new-owner", processStartIdentity: "new-owner", isProcessAlive: () => false });
    const restartedCapture = readWorktreeManifest(manifestPath);
    assert.equal(restartedCapture.kind === "ok" && restartedCapture.manifest.state, "captured",
      "a validated settled capture must stay applyable after reconciliation while resources remain preserved");
  }
  const request = { manifestPath, targetCwd: repo, workerIds: ["worker_1"], transactionId: "tx_restart", idempotencyKey: "key_restart" };
  assert.equal((await atomicApply(request)).outcome, "applied");
  git(repo, ["commit", "-qm", "user accepts applied result"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "later user edit\n");
  const before = { head: git(repo, ["rev-parse", "HEAD"]), status: git(repo, ["status", "--porcelain=v1"]),
    bytes: fs.readFileSync(path.join(repo, "source.txt")), index: fs.readFileSync(path.join(repo, ".git", "index")) };
  await reconcileRuns({ runsRoot, instanceId: "new-owner", processStartIdentity: "new-owner", isProcessAlive: () => false });
  const restored = readWorktreeManifest(manifestPath); assert.equal(restored.kind, "ok");
  assert.equal(restored.kind === "ok" && restored.manifest.state, "applied", "restart must preserve durable applied fact even when its worktree remains");
  const replay = await atomicApply(request);
  assert.equal(replay.outcome, "applied", "same-key historical replay must remain valid after reconciliation and later user edits");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before.head); assert.equal(git(repo, ["status", "--porcelain=v1"]), before.status);
  assert.deepEqual(fs.readFileSync(path.join(repo, "source.txt")), before.bytes); assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), before.index);
  assert.equal(fs.existsSync(worktreePath), true); assert.equal(fs.existsSync(captured.capture!.patchPath!), true);
  console.log("worktree restart redteam passed (captured/applied/discarded facts and interrupted Continue preservation)");
} finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
