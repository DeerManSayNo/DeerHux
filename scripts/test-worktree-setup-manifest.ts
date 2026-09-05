import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorktreeManifest } from "../lib/parallel-agent/worktree-manifest.ts";
import { manifestAllowsWorkspaceCleanup, setupIsolatedWorkspace } from "../lib/parallel-agent/worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function cleanupPreservedRun(repo: string, runId: string): void {
  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  for (const line of listed.split("\n")) {
    if (!line.startsWith("worktree ") || !line.includes(runId)) continue;
    try { git(repo, ["worktree", "remove", line.slice("worktree ".length), "--force"]); } catch { /* fixture cleanup */ }
  }
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${runId}`]);
  for (const ref of refs.split("\n").filter(Boolean)) {
    try { git(repo, ["update-ref", "-d", ref]); } catch { /* fixture cleanup */ }
  }
  const runPath = path.join(os.tmpdir(), "deerhux-runs", runId);
  fs.rmSync(runPath, { recursive: true, force: true });
  assert.equal(git(repo, ["worktree", "list", "--porcelain"]).includes(runId), false, "fixture must remove all worktree registrations");
  assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${runId}`]), "", "fixture must remove all branches");
  assert.equal(fs.existsSync(runPath), false, "fixture must remove the run directory");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-manifest-setup-"));
const repo = path.join(root, "repo");
const runId = `manifest_setup_${Date.now()}`;
let worktreePath: string | undefined;
let runDir: string | undefined;
let branch: string | undefined;
try {
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@deerhux.local"]);
  git(repo, ["config", "user.name", "DeerHux Test"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);

  const setup = await setupIsolatedWorkspace(repo, runId, "test-instance", [
    { workerId: "worker_1", displayName: "Worker One" },
  ]);
  worktreePath = setup.worktrees.get("worker_1");
  runDir = setup.runDir;
  assert.equal(setup.baseCommit, baseCommit);
  assert.ok(worktreePath);
  assert.equal(git(worktreePath, ["rev-parse", "HEAD"]), baseCommit);
  const loaded = readWorktreeManifest(setup.manifestPath);
  branch = loaded.kind === "ok" ? loaded.manifest.workers[0]?.branch : undefined;
  assert.equal(loaded.kind, "ok");
  if (loaded.kind === "ok") {
    assert.equal(loaded.manifest.state, "running");
    assert.equal(loaded.manifest.workers[0]?.workerId, "worker_1");
    assert.equal(loaded.manifest.workers[0]?.worktreePath, worktreePath);
  }
  assert.equal(manifestAllowsWorkspaceCleanup(setup.manifestPath), false, "running manifest must deny cleanup");

  git(repo, ["worktree", "remove", worktreePath, "--force"]);
  worktreePath = undefined;
  git(repo, ["branch", "-D", `deerhux/${runId}/1-worker_1`]);
  branch = undefined;
  fs.rmSync(setup.runDir, { recursive: true });
  runDir = undefined;

  const baseline = git(repo, ["worktree", "list", "--porcelain"]);
  for (const { failIndex, failStep } of [
    { failIndex: 0, failStep: "after_add" as const },
    { failIndex: 1, failStep: "after_add" as const },
    { failIndex: 2, failStep: "after_add" as const },
    { failIndex: 0, failStep: "before_add" as const },
    { failIndex: 2, failStep: "after_verify" as const },
  ]) {
    const failedRunId = `${runId}_failure_${failIndex}`;
    await assert.rejects(setupIsolatedWorkspace(repo, failedRunId, "test-instance", [0, 1, 2].map((index) => ({
      workerId: `worker_${index + 1}`,
      displayName: `Worker ${index + 1}`,
    })), {
      onStep(step, workerIndex) {
        if (step === failStep && workerIndex === failIndex) throw new Error(`injected worker ${workerIndex}`);
      },
    }), /injected worker/);
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]), baseline);
    for (const index of [0, 1, 2]) {
      assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${failedRunId}/${index + 1}-worker_${index + 1}`]), "");
    }
    assert.equal(fs.existsSync(path.join(os.tmpdir(), "deerhux-runs", failedRunId)), false);
  }

  for (const manifestWriteIndex of [0, 3]) {
    const failedRunId = `${runId}_manifest_${manifestWriteIndex}`;
    await assert.rejects(setupIsolatedWorkspace(repo, failedRunId, "test-instance", [
      { workerId: "worker_1", displayName: "Worker 1" },
    ], {
      onManifestWrite(writeIndex) {
        if (writeIndex === manifestWriteIndex) throw new Error(`injected manifest ${writeIndex}`);
      },
    }), /injected manifest/);
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]), baseline);
    assert.equal(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${failedRunId}`]), "");
  }

  const existingRunId = `${runId}_existing`;
  const existingBranch = `deerhux/${existingRunId}/1-worker_1`;
  git(repo, ["branch", existingBranch]);
  await assert.rejects(setupIsolatedWorkspace(repo, existingRunId, "test-instance", [
    { workerId: "worker_1", displayName: "Worker 1" },
  ]));
  assert.equal(git(repo, ["rev-parse", existingBranch]), git(repo, ["rev-parse", "HEAD"]));
  const existingManifest = readWorktreeManifest(path.join(os.tmpdir(), "deerhux-runs", existingRunId, "worktree-manifest.json"));
  assert.equal(existingManifest.kind === "ok" ? existingManifest.manifest.state : existingManifest.kind, "cleanup_error");
  git(repo, ["branch", "-D", existingBranch]);
  cleanupPreservedRun(repo, existingRunId);

  const ownershipRunId = `${runId}_ownership_uncertain`;
  await assert.rejects(setupIsolatedWorkspace(repo, ownershipRunId, "test-instance", [
    { workerId: "worker_1", displayName: "Worker 1" },
  ], {
    onStep(step) {
      if (step === "after_branch_command") throw new Error("injected ownership uncertainty");
    },
  }), /ownership uncertainty/);
  const ownershipManifest = readWorktreeManifest(path.join(os.tmpdir(), "deerhux-runs", ownershipRunId, "worktree-manifest.json"));
  assert.equal(ownershipManifest.kind, "ok");
  if (ownershipManifest.kind === "ok") {
    assert.equal(ownershipManifest.manifest.state, "cleanup_error");
    assert.equal(ownershipManifest.manifest.workers[0]?.cleanup?.reason, "branch_ownership_uncertain");
  }
  assert.notEqual(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${ownershipRunId}`]), "");
  cleanupPreservedRun(repo, ownershipRunId);

  for (const rollbackStep of ["before_worktree_query", "before_branch_query", "before_branch_remove", "before_run_dir_remove"] as const) {
    const failedRunId = `${runId}_${rollbackStep}`;
    await assert.rejects(setupIsolatedWorkspace(repo, failedRunId, "test-instance", [
      { workerId: "worker_1", displayName: "Worker 1" },
    ], {
      onStep(step) {
        if (step === "after_add") throw new Error("trigger rollback");
        if (step === rollbackStep) throw new Error(`injected ${rollbackStep}`);
      },
    }), /trigger rollback/);
    const failedManifest = readWorktreeManifest(path.join(os.tmpdir(), "deerhux-runs", failedRunId, "worktree-manifest.json"));
    assert.equal(failedManifest.kind, "ok");
    if (failedManifest.kind === "ok") {
      const cleanup = failedManifest.manifest.workers[0]?.cleanup;
      const expected = {
        before_worktree_query: { state: "cleanup_error", reason: "worktree_query_failed:Error", worktreeRemoved: false, branchRemoved: false },
        before_branch_query: { state: "cleanup_error", reason: "branch_query_failed:Error", worktreeRemoved: true, branchRemoved: false },
        before_branch_remove: { state: "cleanup_error", reason: "branch_remove_failed:Error", worktreeRemoved: true, branchRemoved: false },
        before_run_dir_remove: { state: "discarded", reason: "setup_failed", worktreeRemoved: true, branchRemoved: true },
      }[rollbackStep];
      assert.equal(failedManifest.manifest.state, expected.state);
      assert.equal(cleanup?.reason, expected.reason);
      assert.equal(cleanup?.worktreeRemoved, expected.worktreeRemoved);
      assert.equal(cleanup?.branchRemoved, expected.branchRemoved);
      const hasRegistration = git(repo, ["worktree", "list", "--porcelain"]).includes(failedRunId);
      const hasBranch = Boolean(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/deerhux/${failedRunId}`]));
      assert.equal(hasRegistration, !expected.worktreeRemoved);
      assert.equal(hasBranch, !expected.branchRemoved);
    }
    cleanupPreservedRun(repo, failedRunId);
  }

  const movingRunId = `${runId}_moving_head`;
  const movingBase = git(repo, ["rev-parse", "HEAD"]);
  const moving = await setupIsolatedWorkspace(repo, movingRunId, "test-instance", [0, 1].map((index) => ({
    workerId: `worker_${index + 1}`,
    displayName: `Worker ${index + 1}`,
  })), {
    onStep(step, workerIndex) {
      if (step === "after_add" && workerIndex === 0) git(repo, ["commit", "--allow-empty", "-m", "advance source head"]);
    },
  });
  assert.notEqual(git(repo, ["rev-parse", "HEAD"]), movingBase);
  for (const [workerId, workerRoot] of moving.worktrees) {
    assert.equal(git(workerRoot, ["rev-parse", "HEAD"]), movingBase);
    git(repo, ["worktree", "remove", workerRoot, "--force"]);
    const index = Number(workerId.split("_")[1]);
    git(repo, ["branch", "-D", `deerhux/${movingRunId}/${index}-${workerId}`]);
  }
  fs.rmSync(moving.runDir, { recursive: true });

  const nested = path.join(repo, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "add nested cwd"]);
  const nestedRunId = `${runId}_nested`;
  const nestedSetup = await setupIsolatedWorkspace(nested, nestedRunId, "test-instance", [
    { workerId: "worker_1", displayName: "Worker 1" },
  ]);
  const nestedRoot = nestedSetup.worktrees.get("worker_1")!;
  assert.equal(nestedSetup.agentCwds.get("worker_1"), path.join(nestedRoot, "packages", "app"));
  git(repo, ["worktree", "remove", nestedRoot, "--force"]);
  git(repo, ["branch", "-D", `deerhux/${nestedRunId}/1-worker_1`]);
  fs.rmSync(nestedSetup.runDir, { recursive: true });
} finally {
  if (worktreePath && fs.existsSync(repo)) {
    try { git(repo, ["worktree", "remove", worktreePath, "--force"]); } catch { /* fixture cleanup */ }
  }
  if (branch && fs.existsSync(repo)) {
    try { git(repo, ["branch", "-D", branch]); } catch { /* fixture cleanup */ }
  }
  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("worktree setup manifest tests passed");
