import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKTREE_AUDIT_RETENTION_MS,
  WORKTREE_TTL_MS,
  collectGitFacts,
  executeCleanup,
  planCleanup,
  reconcileRuns,
  scanRunsRoot,
} from "../lib/parallel-agent/worktree-reconciler.ts";
import { MAX_WORKTREE_PATCH_BYTES, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-reconciler-"));
const now = Date.now();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createRepo(name: string): string {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "reconcile@test.invalid"]);
  git(repo, ["config", "user.name", "Reconcile Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

function manifestFor(runsRoot: string, runId: string, repo: string, state: WorktreeManifestV1["state"] = "running"): { runDir: string; manifestPath: string; manifest: WorktreeManifestV1 } {
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  const base = git(repo, ["rev-parse", "HEAD"]);
  const manifest: WorktreeManifestV1 = {
    version: 1,
    runId,
    instanceId: "dead-instance",
    ownerPid: 2_147_483_647,
    processStartIdentity: "dead-process",
    heartbeatAt: new Date(now - WORKTREE_TTL_MS).toISOString(),
    activeOperation: state === "running" ? "running" : null,
    repoRoot: fs.realpathSync(repo),
    gitCommonDir: fs.realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    sourceCwdRelative: ".",
    baseCommit: base,
    state,
    workers: [{
      workerId: "worker_1",
      displayName: "Worker 1",
      index: 0,
      worktreePath: path.join(runDir, "1-worker_1"),
      agentCwd: path.join(runDir, "1-worker_1"),
      branch: `deerhux/${runId}/1-worker_1`,
      provider: "test",
      state: state === "running" ? "running" : "captured",
      capture: null,
      cleanup: null,
    }],
    apply: null,
    createdAt: new Date(now - WORKTREE_TTL_MS).toISOString(),
    updatedAt: new Date(now - WORKTREE_TTL_MS).toISOString(),
    expiresAt: new Date(now - 1).toISOString(),
  };
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  writeWorktreeManifestAtomic(manifestPath, manifest);
  return { runDir, manifestPath, manifest };
}

try {
  assert.equal(WORKTREE_TTL_MS, 2 * 60 * 60_000);
  assert.equal(WORKTREE_AUDIT_RETENTION_MS, 7 * 24 * 60 * 60_000);
  const repo = createRepo("repo-one");
  const otherRepo = createRepo("repo-two");
  const runsRoot = path.join(sandbox, "runs");
  fs.mkdirSync(runsRoot, { mode: 0o700 });

  const valid = manifestFor(runsRoot, "run_valid", repo);
  fs.mkdirSync(path.join(runsRoot, "unknown"));
  fs.mkdirSync(path.join(runsRoot, "run_invalid"));
  fs.writeFileSync(path.join(runsRoot, "run_invalid", "worktree-manifest.json"), JSON.stringify({ version: 1, runId: "run_invalid", state: "applied", repoRoot: otherRepo, workers: [] }));
  fs.symlinkSync(valid.runDir, path.join(runsRoot, "run_symlink"));
  let scan = scanRunsRoot(runsRoot);
  assert.deepEqual(scan.runs.map((run) => run.manifest.runId), ["run_valid"]);
  assert.deepEqual(scan.issues.map((issue) => issue.reason).sort(), ["invalid_manifest", "symlink", "unknown_directory"]);
  assert.ok(fs.existsSync(path.join(runsRoot, "unknown")));

  const validFacts = collectGitFacts(valid.manifest, valid.manifest.workers[0], valid.runDir);
  scan.runs[0].manifest.heartbeatAt = new Date(now).toISOString();
  let plan = planCleanup(scan.runs[0], { worker_1: validFacts }, {
    now,
    instanceId: "other-instance",
    processStartIdentity: "other-process",
    isProcessAlive: () => true,
  });
  assert.equal(plan.workers[0].reason, "foreign_owner_active");

  valid.manifest.activeOperation = null;
  valid.manifest.expiresAt = new Date(now + 1_000).toISOString();
  writeWorktreeManifestAtomic(valid.manifestPath, valid.manifest);
  scan = scanRunsRoot(runsRoot);
  plan = planCleanup(scan.runs.find((run) => run.manifest.runId === "run_valid")!, { worker_1: validFacts }, { now });
  assert.equal(plan.workers[0].reason, "continue_ttl_active");

  const recovery = manifestFor(runsRoot, "run_recovery", repo);
  git(repo, ["worktree", "add", "-b", recovery.manifest.workers[0].branch, recovery.manifest.workers[0].worktreePath, recovery.manifest.baseCommit]);
  const recovered = await reconcileRuns({
    runsRoot,
    now,
    instanceId: "current-instance",
    processStartIdentity: "current-process",
    isProcessAlive: () => false,
  });
  assert.equal(recovered.recovered.find((entry) => entry.runId === "run_recovery")?.state, "recoverable");
  assert.equal(JSON.parse(fs.readFileSync(recovery.manifestPath, "utf8")).state, "preserved");

  const applying = manifestFor(runsRoot, "run_applying", repo, "applying");
  applying.manifest.apply = {
    transactionId: "tx-1",
    requestedWorkerIds: ["worker_1"],
    requestedFiles: null,
    appliedFiles: [],
    startedAt: new Date(now - 10_000).toISOString(),
    finishedAt: null,
    outcome: "pending",
    errorCode: null,
  };
  writeWorktreeManifestAtomic(applying.manifestPath, applying.manifest);
  const applyingRecovery = await reconcileRuns({ runsRoot, now, instanceId: "current", processStartIdentity: "current", isProcessAlive: () => false });
  assert.equal(applyingRecovery.recovered.find((entry) => entry.runId === "run_applying")?.state, "apply_recovery_required");
  assert.equal(JSON.parse(fs.readFileSync(applying.manifestPath, "utf8")).state, "applying");

  const cleanup = manifestFor(runsRoot, "run_cleanup", repo, "running");
  git(repo, ["worktree", "add", "-b", cleanup.manifest.workers[0].branch, cleanup.manifest.workers[0].worktreePath, cleanup.manifest.baseCommit]);
  fs.writeFileSync(path.join(cleanup.manifest.workers[0].worktreePath, "tracked.txt"), "changed\n");
  git(cleanup.manifest.workers[0].worktreePath, ["add", "."]);
  git(cleanup.manifest.workers[0].worktreePath, ["commit", "-qm", "captured worker change"]);
  const patchPath = path.join(cleanup.runDir, "artifacts", "artifact.patch");
  fs.mkdirSync(path.dirname(patchPath), { mode: 0o700 });
  execFileSync("git", ["diff", "--cached", "--binary", "--full-index", cleanup.manifest.baseCommit, `--output=${patchPath}`], { cwd: cleanup.manifest.workers[0].worktreePath });
  fs.chmodSync(patchPath, 0o600);
  const patch = fs.readFileSync(patchPath);
  const workerHead = git(cleanup.manifest.workers[0].worktreePath, ["rev-parse", "HEAD"]);
  cleanup.manifest.workers[0].capture = {
    changed: true,
    workerBranch: cleanup.manifest.workers[0].branch,
    workerHead,
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    patchBytes: patch.length,
    changedFiles: ["tracked.txt"],
    binaryFiles: [],
    capturedAt: new Date(now - 1_000).toISOString(),
    captureError: null,
  };
  cleanup.manifest.apply = {
    transactionId: "applied-tx",
    requestedWorkerIds: ["worker_1"],
    requestedFiles: null,
    appliedFiles: ["tracked.txt"],
    startedAt: new Date(now - 2_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    outcome: "applied",
    errorCode: null,
  };
  cleanup.manifest.state = "applied";
  cleanup.manifest.workers[0].state = "captured";
  cleanup.manifest.activeOperation = null;
  writeWorktreeManifestAtomic(cleanup.manifestPath, cleanup.manifest);
  const unsafeWorker = structuredClone(cleanup.manifest.workers[0]);
  const outsidePatch = path.join(sandbox, "outside.patch");
  fs.writeFileSync(outsidePatch, patch, { mode: 0o600 });
  unsafeWorker.capture!.patchPath = outsidePatch;
  const originalOpen = fs.openSync;
  let outsideOpened = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === outsidePatch) outsideOpened = true;
    return originalOpen(...args);
  }) as typeof fs.openSync;
  try {
    const outsideFacts = collectGitFacts(cleanup.manifest, unsafeWorker, cleanup.runDir);
    assert.equal(outsideFacts.pathSafe, false);
    assert.equal(outsideFacts.artifactDigestMatches, false);
    assert.equal(outsideOpened, false, "out-of-root artifacts must be rejected before open");
  } finally { fs.openSync = originalOpen; }
  fs.chmodSync(patchPath, 0o644);
  assert.equal(collectGitFacts(cleanup.manifest, cleanup.manifest.workers[0], cleanup.runDir).artifactDigestMatches, false);
  fs.chmodSync(patchPath, 0o600);
  const growFd = fs.openSync(patchPath, "r+");
  fs.ftruncateSync(growFd, MAX_WORKTREE_PATCH_BYTES + 1);
  fs.closeSync(growFd);
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => { reads++; return originalRead(...args); }) as typeof fs.readSync;
  try {
    const hugeFacts = collectGitFacts(cleanup.manifest, cleanup.manifest.workers[0], cleanup.runDir);
    assert.equal(hugeFacts.artifactDigestMatches, false);
    assert.equal(reads, 0, "oversized patch must not be read");
  } finally { fs.readSync = originalRead; }
  fs.writeFileSync(patchPath, patch);
  unsafeWorker.capture!.patchPath = patchPath;
  unsafeWorker.capture!.patchBytes = patch.length + 1;
  assert.equal(collectGitFacts(cleanup.manifest, unsafeWorker, cleanup.runDir).artifactDigestMatches, false);
  fs.renameSync(patchPath, `${patchPath}.real`);
  fs.symlinkSync(outsidePatch, patchPath);
  assert.equal(collectGitFacts(cleanup.manifest, cleanup.manifest.workers[0], cleanup.runDir).pathSafe, false);
  fs.unlinkSync(patchPath);
  fs.renameSync(`${patchPath}.real`, patchPath);
  let mutatedDuringRead = false;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const count = originalRead(...args);
    if (!mutatedDuringRead && count > 0) {
      mutatedDuringRead = true;
      fs.appendFileSync(patchPath, "tampered");
    }
    return count;
  }) as typeof fs.readSync;
  try {
    assert.equal(collectGitFacts(cleanup.manifest, cleanup.manifest.workers[0], cleanup.runDir).artifactDigestMatches, false,
      "artifact growth during a fixed-FD read must invalidate evidence");
  } finally { fs.readSync = originalRead; fs.writeFileSync(patchPath, patch); }
  const cleanupRun = scanRunsRoot(runsRoot).runs.find((run) => run.manifest.runId === "run_cleanup")!;
  const cleanupFacts = collectGitFacts(cleanupRun.manifest, cleanupRun.manifest.workers[0], cleanupRun.runDir);
  assert.notEqual(cleanupFacts.repoMatches, collectGitFacts({ ...cleanupRun.manifest, repoRoot: otherRepo }, cleanupRun.manifest.workers[0], cleanupRun.runDir).repoMatches);
  const cleanupPlan = planCleanup(cleanupRun, { worker_1: cleanupFacts }, { now });
  assert.equal(cleanupPlan.workers[0].reason, "worktree_requires_explicit_discard");
  const cleanupResult = await executeCleanup(cleanupPlan, { instanceId: cleanup.manifest.instanceId, processStartIdentity: cleanup.manifest.processStartIdentity });
  assert.equal(cleanupResult.complete, false);
  assert.equal(fs.existsSync(cleanup.manifest.workers[0].worktreePath), true);
  assert.notEqual(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/${cleanup.manifest.workers[0].branch}`]), "");
  assert.equal(fs.existsSync(patchPath), true, "artifact must remain for the audit retention window");

  const emptyCleanup = manifestFor(runsRoot, "run_empty_cleanup", repo, "running");
  git(repo, ["worktree", "add", "-b", emptyCleanup.manifest.workers[0].branch, emptyCleanup.manifest.workers[0].worktreePath, emptyCleanup.manifest.baseCommit]);
  const emptyPatchPath = path.join(emptyCleanup.runDir, "artifacts", "empty.patch");
  fs.mkdirSync(path.dirname(emptyPatchPath), { mode: 0o700 });
  fs.writeFileSync(emptyPatchPath, "", { mode: 0o600 });
  emptyCleanup.manifest.workers[0].capture = {
    changed: false,
    workerBranch: emptyCleanup.manifest.workers[0].branch,
    workerHead: emptyCleanup.manifest.baseCommit,
    patchPath: emptyPatchPath,
    patchSha256: createHash("sha256").update("").digest("hex"),
    patchBytes: 0,
    changedFiles: [],
    binaryFiles: [],
    capturedAt: new Date(now - 1_000).toISOString(),
    captureError: null,
  };
  emptyCleanup.manifest.apply = {
    transactionId: "empty-applied-tx",
    requestedWorkerIds: ["worker_1"],
    requestedFiles: null,
    appliedFiles: [],
    startedAt: new Date(now - 2_000).toISOString(),
    finishedAt: new Date(now - 1_000).toISOString(),
    outcome: "applied",
    errorCode: null,
  };
  emptyCleanup.manifest.state = "applied";
  emptyCleanup.manifest.workers[0].state = "captured";
  emptyCleanup.manifest.activeOperation = null;
  writeWorktreeManifestAtomic(emptyCleanup.manifestPath, emptyCleanup.manifest);
  git(repo, ["worktree", "remove", emptyCleanup.manifest.workers[0].worktreePath]);
  const emptyRun = scanRunsRoot(runsRoot).runs.find((run) => run.manifest.runId === emptyCleanup.manifest.runId)!;
  const emptyFacts = collectGitFacts(emptyRun.manifest, emptyRun.manifest.workers[0], emptyRun.runDir);
  const emptyPlan = planCleanup(emptyRun, { worker_1: emptyFacts }, { now });
  assert.equal(emptyPlan.workers[0].reason, "eligible_applied");
  const emptyResult = await executeCleanup(emptyPlan, { instanceId: emptyCleanup.manifest.instanceId, processStartIdentity: emptyCleanup.manifest.processStartIdentity });
  assert.equal(emptyResult.complete, false);
  assert.equal(emptyResult.workers[0].reason, "untrusted_creation_identity");
  assert.notEqual(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/${emptyCleanup.manifest.workers[0].branch}`]), "");

  const postCaptureCases: Array<{ name: string; mutate: (worktree: string) => void }> = [
    { name: "tracked", mutate: (worktree) => fs.writeFileSync(path.join(worktree, "tracked.txt"), "post-capture tracked\n") },
    { name: "untracked", mutate: (worktree) => fs.writeFileSync(path.join(worktree, "post-capture.txt"), "untracked\n") },
    { name: "binary", mutate: (worktree) => fs.writeFileSync(path.join(worktree, "post-capture.bin"), Buffer.from([0, 255, 1, 254])) },
    { name: "commit", mutate: (worktree) => {
      fs.writeFileSync(path.join(worktree, "committed-after-capture.txt"), "committed\n");
      git(worktree, ["add", "."]);
      git(worktree, ["commit", "-qm", "post-capture commit"]);
    } },
  ];
  for (const postCaptureCase of postCaptureCases) {
    const fixture = manifestFor(runsRoot, `run_post_capture_${postCaptureCase.name}`, repo, "running");
    git(repo, ["worktree", "add", "-b", fixture.manifest.workers[0].branch, fixture.manifest.workers[0].worktreePath, fixture.manifest.baseCommit]);
    fs.writeFileSync(path.join(fixture.manifest.workers[0].worktreePath, "tracked.txt"), "captured\n");
    git(fixture.manifest.workers[0].worktreePath, ["add", "-A"]);
    const fixturePatchPath = path.join(fixture.runDir, "artifacts", "artifact.patch");
    fs.mkdirSync(path.dirname(fixturePatchPath), { mode: 0o700 });
    execFileSync("git", ["diff", "--cached", "--binary", "--full-index", fixture.manifest.baseCommit, `--output=${fixturePatchPath}`], { cwd: fixture.manifest.workers[0].worktreePath });
    fs.chmodSync(fixturePatchPath, 0o600);
    const fixturePatch = fs.readFileSync(fixturePatchPath);
    fixture.manifest.workers[0].capture = {
      changed: true,
      workerBranch: fixture.manifest.workers[0].branch,
      workerHead: git(fixture.manifest.workers[0].worktreePath, ["rev-parse", "HEAD"]),
      patchPath: fixturePatchPath,
      patchSha256: createHash("sha256").update(fixturePatch).digest("hex"),
      patchBytes: fixturePatch.length,
      changedFiles: ["tracked.txt"],
      binaryFiles: [],
      capturedAt: new Date(now - 1_000).toISOString(),
      captureError: null,
    };
    fixture.manifest.apply = {
      transactionId: `applied-${postCaptureCase.name}`,
      requestedWorkerIds: ["worker_1"],
      requestedFiles: null,
      appliedFiles: ["tracked.txt"],
      startedAt: new Date(now - 2_000).toISOString(),
      finishedAt: new Date(now - 1_000).toISOString(),
      outcome: "applied",
      errorCode: null,
    };
    fixture.manifest.state = "applied";
    fixture.manifest.workers[0].state = "captured";
    fixture.manifest.activeOperation = null;
    writeWorktreeManifestAtomic(fixture.manifestPath, fixture.manifest);
    postCaptureCase.mutate(fixture.manifest.workers[0].worktreePath);

    const fixtureRun = scanRunsRoot(runsRoot).runs.find((run) => run.manifest.runId === fixture.manifest.runId)!;
    const realIndexBefore = fs.readFileSync(git(fixture.manifest.workers[0].worktreePath, ["rev-parse", "--git-path", "index"]));
    const statusBefore = git(fixture.manifest.workers[0].worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const fixtureFacts = collectGitFacts(fixtureRun.manifest, fixtureRun.manifest.workers[0], fixtureRun.runDir);
    assert.notEqual(fixtureFacts.captureMatchesWorktree, true, postCaptureCase.name);
    assert.deepEqual(fs.readFileSync(git(fixture.manifest.workers[0].worktreePath, ["rev-parse", "--git-path", "index"])), realIndexBefore, `${postCaptureCase.name}: real index changed`);
    assert.equal(git(fixture.manifest.workers[0].worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), statusBefore, `${postCaptureCase.name}: worktree changed`);
    const fixturePlan = planCleanup(fixtureRun, { worker_1: fixtureFacts }, { now });
    const expectedReason = fixtureFacts.captureMatchesWorktree === false ? "worktree_changed_after_capture" : "worktree_requires_explicit_discard";
    assert.equal(fixturePlan.workers[0].reason, expectedReason, postCaptureCase.name);
    const fixtureCleanup = await executeCleanup(fixturePlan, { instanceId: fixture.manifest.instanceId, processStartIdentity: fixture.manifest.processStartIdentity });
    assert.equal(fixtureCleanup.complete, false, postCaptureCase.name);
    assert.equal(fixtureCleanup.workers[0].reason, expectedReason, postCaptureCase.name);
    assert.equal(fs.existsSync(fixture.manifest.workers[0].worktreePath), true, postCaptureCase.name);
    assert.notEqual(git(repo, ["for-each-ref", "--format=%(refname)", `refs/heads/${fixture.manifest.workers[0].branch}`]), "", postCaptureCase.name);
  }

  const missingArtifact = manifestFor(runsRoot, "run_missing_artifact", repo, "running");
  git(repo, ["worktree", "add", "-b", missingArtifact.manifest.workers[0].branch, missingArtifact.manifest.workers[0].worktreePath, missingArtifact.manifest.baseCommit]);
  const missingPatchPath = path.join(missingArtifact.runDir, "artifacts", "missing.patch");
  missingArtifact.manifest.workers[0].capture = {
    changed: true,
    workerBranch: missingArtifact.manifest.workers[0].branch,
    workerHead: missingArtifact.manifest.baseCommit,
    patchPath: missingPatchPath,
    patchSha256: "0".repeat(64),
    patchBytes: 1,
    changedFiles: ["tracked.txt"],
    binaryFiles: [],
    capturedAt: new Date(now - 1_000).toISOString(),
    captureError: null,
  };
  writeWorktreeManifestAtomic(missingArtifact.manifestPath, missingArtifact.manifest);
  const missingScan = scanRunsRoot(runsRoot);
  assert.ok(missingScan.runs.some((run) => run.manifest.runId === missingArtifact.manifest.runId));
  assert.equal(missingScan.issues.some((issue) => issue.path.includes(missingArtifact.manifest.runId)), false);
  const missingRecovery = await reconcileRuns({ runsRoot, now, instanceId: "current", processStartIdentity: "current", isProcessAlive: () => false });
  assert.equal(missingRecovery.recovered.find((entry) => entry.runId === missingArtifact.manifest.runId)?.state, "recoverable");
  assert.equal(JSON.parse(fs.readFileSync(missingArtifact.manifestPath, "utf8")).state, "preserved");
  assert.equal(missingRecovery.plans.find((entry) => entry.manifest.runId === missingArtifact.manifest.runId)?.workers[0].reason, "artifact_invalid");

  const tampered = JSON.parse(fs.readFileSync(cleanup.manifestPath, "utf8"));
  tampered.untrusted = true;
  fs.writeFileSync(cleanup.manifestPath, JSON.stringify(tampered));
  assert.equal(scanRunsRoot(runsRoot).issues.some((issue) => issue.path.includes("run_cleanup") && issue.reason === "invalid_manifest"), true);

  console.log("worktree reconciler tests passed");
} finally {
  try {
    const repo = path.join(sandbox, "repo-one");
    if (fs.existsSync(repo)) {
      for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (line.startsWith("worktree ") && line.includes(sandbox) && line.slice(9) !== repo) {
          try { git(repo, ["worktree", "remove", "--force", line.slice(9)]); } catch { /* cleanup */ }
        }
      }
    }
  } catch { /* cleanup */ }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
