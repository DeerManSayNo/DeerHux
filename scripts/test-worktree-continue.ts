import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContinueValidationError, claimContinueLease, settleContinueLease, validateContinueResources, type ContinueValidationInput } from "../lib/parallel-agent/worktree-continue.ts";
import { getGitProcessStartMarker } from "../lib/parallel-agent/git-lock.ts";
import { GitRepository } from "../lib/parallel-agent/git-repository.ts";
import { captureWorktreeArtifact } from "../lib/parallel-agent/worktree-artifacts.ts";
import type { WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";
import { readWorktreeManifest, writeWorktreeManifestAtomic } from "../lib/parallel-agent/worktree-manifest.ts";

const root = path.resolve("/tmp/deerhux-continue-test");
const workerPath = path.join(root, "runs", "run_1", "1-worker_1");
const agentCwd = path.join(workerPath, "packages", "app");
const baseCommit = "a".repeat(40);
const head = "b".repeat(40);
const manifest: WorktreeManifestV1 = {
  version: 1, runId: "run_1", instanceId: "old-instance", ownerPid: 123,
  processStartIdentity: "old-process", heartbeatAt: "2026-01-01T00:00:00.000Z", activeOperation: null,
  repoRoot: path.join(root, "repo"), gitCommonDir: path.join(root, "repo", ".git"),
  sourceCwdRelative: "packages/app", baseCommit, state: "captured",
  workers: [{
    workerId: "worker_1", displayName: "Worker 1", index: 0, worktreePath: workerPath, agentCwd,
    branch: "deerhux/run_1/1-worker_1", provider: "test", state: "captured",
    capture: {
      changed: true, workerBranch: "deerhux/run_1/1-worker_1", workerHead: head,
      patchPath: path.join(root, "runs", "run_1", "artifacts", "worker.patch"), patchSha256: "c".repeat(64),
      patchBytes: 1, changedFiles: ["file.ts"], binaryFiles: [], capturedAt: "2026-01-01T00:01:00.000Z", captureError: null,
    }, cleanup: null,
  }],
  apply: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", expiresAt: "2026-01-01T02:01:00.000Z",
};
const valid: ContinueValidationInput = {
  manifest, worker: manifest.workers[0],
  facts: {
    workerId: "worker_1", repoMatches: true, pathSafe: true, worktreeExists: true, worktreeRegistered: true,
    branchOid: head, worktreeBranch: manifest.workers[0].branch, head, dirty: false, ignoredFilesPresent: false, artifactExists: true, artifactDigestMatches: true,
    captureMatchesWorktree: true,
  },
  expectedRunId: manifest.runId, expectedRepoRoot: manifest.repoRoot, expectedGitCommonDir: manifest.gitCommonDir,
  expectedBaseCommit: baseCommit, instanceId: "new-instance", processStartIdentity: "new-process", foreignOwnerAlive: false,
  agentCwdValid: true, baseCommitExists: true, baseCommitIsAncestor: true,
  sessionHeader: { id: "session_1", cwd: agentCwd }, expectedSessionId: "session_1",
  sessionOrigin: { runId: "run_1", workerName: "Worker 1" },
};
assert.doesNotThrow(() => validateContinueResources(valid));

const cases: Array<{ name: string; code: ContinueValidationError["code"]; mutate: (input: ContinueValidationInput) => void }> = [
  { name: "run binding", code: "CONTINUE_BINDING_INVALID", mutate: (input) => { input.expectedRunId = "run_other"; } },
  { name: "foreign live owner", code: "CONTINUE_OWNER_ACTIVE", mutate: (input) => { input.foreignOwnerAlive = true; } },
  { name: "active operation", code: "CONTINUE_OPERATION_ACTIVE", mutate: (input) => { input.manifest.instanceId = input.instanceId; input.manifest.processStartIdentity = input.processStartIdentity; input.manifest.activeOperation = "continue"; } },
  { name: "repository identity", code: "CONTINUE_REPOSITORY_MISMATCH", mutate: (input) => { input.expectedGitCommonDir = path.join(root, "other.git"); } },
  { name: "registered worktree", code: "CONTINUE_WORKTREE_INVALID", mutate: (input) => { input.facts.worktreeRegistered = false; } },
  { name: "worktree branch", code: "CONTINUE_WORKTREE_INVALID", mutate: (input) => { input.facts.worktreeBranch = "wrong"; } },
  { name: "branch head", code: "CONTINUE_WORKTREE_INVALID", mutate: (input) => { input.facts.branchOid = "d".repeat(40); } },
  { name: "agent cwd", code: "CONTINUE_WORKTREE_INVALID", mutate: (input) => { input.agentCwdValid = false; } },
  { name: "base commit", code: "CONTINUE_BASE_INVALID", mutate: (input) => { input.baseCommitIsAncestor = false; } },
  { name: "session id", code: "CONTINUE_SESSION_INVALID", mutate: (input) => { input.sessionHeader = { id: "other", cwd: agentCwd }; } },
  { name: "session cwd", code: "CONTINUE_SESSION_INVALID", mutate: (input) => { input.sessionHeader = { id: "session_1", cwd: workerPath }; } },
  { name: "session origin", code: "CONTINUE_SESSION_INVALID", mutate: (input) => { input.sessionOrigin = { runId: "run_other", workerName: "Worker 1" }; } },
];
for (const testCase of cases) {
  const input = structuredClone(valid);
  input.worker = input.manifest.workers[0];
  testCase.mutate(input);
  assert.throws(() => validateContinueResources(input), (error: unknown) => error instanceof ContinueValidationError && error.code === testCase.code, testCase.name);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-continue-integration-"));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
try {
  const repo = path.join(sandbox, "repo");
  const runsRoot = path.join(sandbox, "runs");
  const runId = "run_continue_real";
  const runDir = path.join(runsRoot, runId);
  const realWorkerPath = path.join(runDir, "1-worker_1");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "continue@test.invalid"]);
  git(repo, ["config", "user.name", "Continue Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const realBase = git(repo, ["rev-parse", "HEAD"]);
  const realBranch = `deerhux/${runId}/1-worker_1`;
  git(repo, ["worktree", "add", "-q", "-b", realBranch, realWorkerPath, realBase]);
  const timestamp = new Date(Date.now() - 10_000).toISOString();
  const realManifest: WorktreeManifestV1 = {
    version: 1,
    runId,
    instanceId: "dead-instance",
    ownerPid: 2_147_483_647,
    processStartIdentity: "dead-process",
    heartbeatAt: timestamp,
    activeOperation: null,
    repoRoot: fs.realpathSync(repo),
    gitCommonDir: fs.realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    sourceCwdRelative: ".",
    baseCommit: realBase,
    state: "preserved",
    workers: [{
      workerId: "worker_1",
      displayName: "Worker 1",
      index: 0,
      worktreePath: realWorkerPath,
      agentCwd: realWorkerPath,
      branch: realBranch,
      provider: "test",
      state: "stopped",
      capture: null,
      cleanup: null,
    }],
    apply: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  writeWorktreeManifestAtomic(manifestPath, realManifest);
  fs.writeFileSync(path.join(realWorkerPath, "tracked.txt"), "first capture\n");
  const firstCapture = await captureWorktreeArtifact(manifestPath, "worker_1");
  assert.equal(firstCapture.ok, true);
  const firstPatchPath = firstCapture.capture?.patchPath;
  assert.ok(firstPatchPath && fs.existsSync(firstPatchPath));
  const repository = await GitRepository.open(repo, { instanceId: "continue-owner" });
  const processStartIdentity = getGitProcessStartMarker();
  const binding = await claimContinueLease({
    runsRoot,
    runId,
    workerId: "worker_1",
    repository,
    expectedBaseCommit: realBase,
    sessionId: "session_1",
    sessionHeader: { id: "session_1", cwd: realWorkerPath },
    sessionOrigin: { runId, workerName: "Worker 1" },
    instanceId: "continue-owner",
    processStartIdentity,
  });
  assert.equal(binding.agentCwd, realWorkerPath);
  const claimed = readWorktreeManifest(manifestPath);
  assert.equal(claimed.kind, "ok");
  if (claimed.kind === "ok") {
    assert.equal(claimed.manifest.activeOperation, "continue");
    assert.equal(claimed.manifest.state, "running");
  }
  fs.writeFileSync(path.join(realWorkerPath, "continued.txt"), "continued result\n");
  const secondCapture = await captureWorktreeArtifact(manifestPath, "worker_1");
  assert.equal(secondCapture.ok, true);
  assert.notEqual(secondCapture.capture?.patchPath, firstPatchPath);
  assert.equal(fs.existsSync(firstPatchPath!), true, "Continue capture must retain the previous content-addressed artifact");
  await assert.rejects(
    claimContinueLease({
      runsRoot,
      runId,
      workerId: "worker_1",
      repository,
      expectedBaseCommit: realBase,
      sessionId: "session_1",
      sessionHeader: { id: "session_1", cwd: realWorkerPath },
      sessionOrigin: { runId, workerName: "Worker 1" },
      instanceId: "other-instance",
      processStartIdentity: "other-process",
    }),
    (error: unknown) => error instanceof ContinueValidationError && error.code === "CONTINUE_OWNER_ACTIVE",
  );
  await settleContinueLease(binding);
  const settled = readWorktreeManifest(manifestPath);
  assert.equal(settled.kind, "ok");
  if (settled.kind === "ok") {
    assert.equal(settled.manifest.activeOperation, null);
    assert.equal(settled.manifest.state, "captured");
    assert.equal(settled.manifest.workers[0].state, "captured");
  }
  const retryBinding = await claimContinueLease({
    runsRoot,
    runId,
    workerId: "worker_1",
    repository,
    expectedBaseCommit: realBase,
    sessionId: "session_1",
    sessionHeader: { id: "session_1", cwd: realWorkerPath },
    sessionOrigin: { runId, workerName: "Worker 1" },
    instanceId: "continue-owner",
    processStartIdentity,
  });
  fs.writeFileSync(path.join(realWorkerPath, "continued.txt"), "capture failure must preserve this\n");
  const failedCapture = await captureWorktreeArtifact(manifestPath, "worker_1", { faults: { forceTreeMismatch: true } });
  assert.equal(failedCapture.ok, false);
  assert.equal(fs.existsSync(secondCapture.capture!.patchPath!), true, "failed Continue capture must preserve the previous artifact");
  await settleContinueLease(retryBinding);
  const afterFailure = readWorktreeManifest(manifestPath);
  assert.equal(afterFailure.kind, "ok");
  if (afterFailure.kind === "ok") {
    assert.equal(afterFailure.manifest.state, "preserved");
    assert.equal(afterFailure.manifest.activeOperation, null);
  }
  const retried = await claimContinueLease({
    runsRoot,
    runId,
    workerId: "worker_1",
    repository,
    expectedBaseCommit: realBase,
    sessionId: "session_1",
    sessionHeader: { id: "session_1", cwd: realWorkerPath },
    sessionOrigin: { runId, workerName: "Worker 1" },
    instanceId: "continue-owner",
    processStartIdentity,
  });
  await settleContinueLease(retried);
} finally {
  try {
    const repo = path.join(sandbox, "repo");
    const workerPath = path.join(sandbox, "runs", "run_continue_real", "1-worker_1");
    if (fs.existsSync(repo) && fs.existsSync(workerPath)) git(repo, ["worktree", "remove", "--force", workerPath]);
  } catch { /* fixture cleanup */ }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
console.log("worktree continue validation tests passed");
