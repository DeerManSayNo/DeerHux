import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST as discardRoute } from "../app/api/agent-runs/[runId]/discard/route.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import { createCollaborationRun, getCollaborationRun, removeCollaborationRun, updateCollaborationRun } from "../lib/parallel-agent/collaboration-store.ts";
import {
  clearDiscardTokensForTests,
  commitWorktreeDiscard,
  DISCARD_STRONG_CONFIRMATION,
  previewWorktreeDiscard as previewWithAuthority,
  type DiscardRepositoryIdentity,
} from "../lib/parallel-agent/worktree-discard.ts";
import { MAX_WORKTREE_PATCH_BYTES, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";
import { getIsolatedRunDir } from "../lib/parallel-agent/worktree.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-discard-"));
// Capture authority at fixture creation, separately from the mutable manifest.
const fixtureAuthorities = new Map<string, DiscardRepositoryIdentity>();
function previewWorktreeDiscard(options: Parameters<typeof previewWithAuthority>[0]) {
  return previewWithAuthority({ ...options, trustedRepository: fixtureAuthorities.get(options.runId) });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(runId: string, workerCount = 1, managed = false) {
  const repo = path.join(sandbox, `${runId}-repo`);
  const runsRoot = path.join(sandbox, `${runId}-runs`);
  const runDir = managed ? getIsolatedRunDir(runId) : path.join(runsRoot, runId);
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "discard@test.invalid"]);
  git(repo, ["config", "user.name", "Discard Test"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".private/\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const manifest: WorktreeManifestV1 = {
    version: 1, runId, instanceId: "discard-test", ownerPid: process.pid,
    processStartIdentity: "discard-test-process", heartbeatAt: createdAt, activeOperation: null,
    repoRoot: fs.realpathSync(repo),
    gitCommonDir: fs.realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    sourceCwdRelative: ".", baseCommit, state: "preserved", apply: null,
    workers: Array.from({ length: workerCount }, (_, index) => {
      const workerId = `worker_${index + 1}`;
      return {
        workerId, displayName: `Worker ${index + 1}`, index,
        worktreePath: path.join(runDir, `${index + 1}-${workerId}`),
        agentCwd: path.join(runDir, `${index + 1}-${workerId}`),
        branch: `deerhux/${runId}/${index + 1}-${workerId}`,
        provider: "test", state: "preserved" as const, capture: null, cleanup: null,
      };
    }),
    createdAt, updatedAt: createdAt, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  for (const worker of manifest.workers) git(repo, ["worktree", "add", "-b", worker.branch, worker.worktreePath, baseCommit]);
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  writeWorktreeManifestAtomic(manifestPath, manifest);
  fixtureAuthorities.set(runId, { root: manifest.repoRoot, commonDir: manifest.gitCommonDir, baseCommit });
  return { repo, runDir, manifestPath, manifest };
}

try {
  clearDiscardTokensForTests();

  const clean = fixture("run_clean");
  const artifactPath = path.join(clean.runDir, "artifacts", "worker_1.patch");
  fs.mkdirSync(path.dirname(artifactPath), { mode: 0o700 });
  fs.writeFileSync(artifactPath, "", { mode: 0o600 });
  clean.manifest.workers[0].capture = {
    changed: false, workerBranch: clean.manifest.workers[0].branch, workerHead: clean.manifest.baseCommit,
    patchPath: artifactPath, patchSha256: createHash("sha256").update("").digest("hex"), patchBytes: 0,
    changedFiles: [], binaryFiles: [], capturedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(), captureError: null,
  };
  clean.manifest.updatedAt = new Date().toISOString();
  writeWorktreeManifestAtomic(clean.manifestPath, clean.manifest);
  git(clean.repo, ["worktree", "remove", "--force", clean.manifest.workers[0].worktreePath]);
  const preview = await previewWorktreeDiscard({ runId: clean.manifest.runId, manifestPath: clean.manifestPath, workerIds: ["worker_1"], sessionCapabilities: { worker_1: { hasSession: true, canContinue: true } } });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.workers[0].sessionCapability, "continue_will_be_lost");
  assert.ok(preview.confirmationToken);
  assert.equal(fs.existsSync(clean.manifest.workers[0].worktreePath), false);
  assert.deepEqual(preview.workers[0].retainedResources, ["patch"]);
  assert.equal(preview.unappliedFileCount, 0);
  assert.equal(fs.existsSync(artifactPath), true, "preview must not delete the patch");
  const committed = await commitWorktreeDiscard({ runId: clean.manifest.runId, confirmationToken: preview.confirmationToken! });
  assert.equal(committed.complete, false);
  assert.equal(committed.workers[0].reason, "PRESERVED_FOR_RECOVERY");
  assert.equal(fs.existsSync(clean.manifest.workers[0].worktreePath), false);
  assert.equal(fs.existsSync(artifactPath), true, "existing patch must remain for the audit retention window");
  assert.equal(git(clean.repo, ["for-each-ref", "--format=%(refname)", `refs/heads/${clean.manifest.workers[0].branch}`]), "");
  assert.equal((await commitWorktreeDiscard({ runId: clean.manifest.runId, confirmationToken: preview.confirmationToken! })).errorCode, "TOKEN_INVALID", "token must be one-time");

  const noArtifact = fixture("run_no_artifact");
  git(noArtifact.repo, ["worktree", "remove", "--force", noArtifact.manifest.workers[0].worktreePath]);
  const noArtifactPreview = await previewWorktreeDiscard({ runId: noArtifact.manifest.runId, manifestPath: noArtifact.manifestPath, workerIds: ["worker_1"] });
  const noArtifactResult = await commitWorktreeDiscard({ runId: noArtifact.manifest.runId, confirmationToken: noArtifactPreview.confirmationToken! });
  assert.equal(noArtifactResult.complete, true);
  assert.equal(noArtifactResult.workers[0].reason, "DISCARDED");

  const recreated = fixture("run_recreated_removed");
  recreated.manifest.workers[0].state = "removed";
  recreated.manifest.workers[0].cleanup = {
    intent: "discard", eligibility: "eligible", checkedAt: new Date().toISOString(),
    worktreeRemoved: true, branchRemoved: true, reason: "explicit_discard",
  };
  writeWorktreeManifestAtomic(recreated.manifestPath, recreated.manifest);
  const recreatedPreview = await previewWorktreeDiscard({ runId: recreated.manifest.runId, manifestPath: recreated.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION });
  const recreatedResult = await commitWorktreeDiscard({ runId: recreated.manifest.runId, confirmationToken: recreatedPreview.confirmationToken! });
  assert.equal(recreatedResult.complete, false, "historical removed flags must not hide recreated resources");
  assert.equal(recreatedResult.workers[0].worktreeRemoved, false);
  assert.equal(recreatedResult.workers[0].branchRemoved, false);
  assert.equal(fs.existsSync(recreated.manifest.workers[0].worktreePath), true);

  const bounded = fixture("run_bounded_artifact");
  git(bounded.repo, ["worktree", "remove", "--force", bounded.manifest.workers[0].worktreePath]);
  const boundedPath = path.join(bounded.runDir, "artifacts", "bounded.patch");
  const boundedBytes = Buffer.alloc(2 * 1024 * 1024, 0x78);
  fs.mkdirSync(path.dirname(boundedPath), { mode: 0o700 });
  fs.writeFileSync(boundedPath, boundedBytes, { mode: 0o600 });
  bounded.manifest.workers[0].capture = {
    changed: true, workerBranch: bounded.manifest.workers[0].branch, workerHead: bounded.manifest.baseCommit,
    patchPath: boundedPath, patchSha256: createHash("sha256").update(boundedBytes).digest("hex"), patchBytes: boundedBytes.length,
    changedFiles: ["large.txt"], binaryFiles: [], capturedAt: new Date().toISOString(), captureError: null,
  };
  writeWorktreeManifestAtomic(bounded.manifestPath, bounded.manifest);
  const originalReadFileSync = fs.readFileSync;
  let synchronousArtifactReads = 0;
  fs.readFileSync = ((target: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (String(target) === boundedPath) {
      synchronousArtifactReads += 1;
      throw new Error("Discard must not synchronously load the artifact");
    }
    return Reflect.apply(originalReadFileSync, fs, [target, ...args]);
  }) as typeof fs.readFileSync;
  try {
    let eventLoopProgressed = false;
    setImmediate(() => { eventLoopProgressed = true; });
    const boundedPreview = await previewWorktreeDiscard({ runId: bounded.manifest.runId, manifestPath: bounded.manifestPath, workerIds: ["worker_1"] });
    assert.equal(eventLoopProgressed, true, "Discard artifact verification must yield to the event loop");
    assert.equal(boundedPreview.ok, true, JSON.stringify(boundedPreview));
    const boundedResult = await commitWorktreeDiscard({ runId: bounded.manifest.runId, confirmationToken: boundedPreview.confirmationToken! });
    assert.equal(boundedResult.complete, false, "verified audit artifact remains retained");
    assert.deepEqual(boundedResult.workers[0].retainedResources, ["patch"]);
    const externalArtifacts = path.join(sandbox, "external-artifacts");
    const originalOpen = fsp.open;
    let unsafeArtifactOpens = 0;
    fs.renameSync(path.dirname(boundedPath), externalArtifacts);
    fs.symlinkSync(externalArtifacts, path.dirname(boundedPath));
    fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
      if (String(args[0]) === boundedPath) unsafeArtifactOpens += 1;
      return Reflect.apply(originalOpen, fsp, args);
    }) as typeof fsp.open;
    try {
      const escapedPreview = await previewWorktreeDiscard({ runId: bounded.manifest.runId, manifestPath: bounded.manifestPath, workerIds: ["worker_1"] });
      assert.equal(escapedPreview.ok, false);
      assert.equal(unsafeArtifactOpens, 0, "artifact-directory symlink must be rejected before opening content");
    } finally {
      fsp.open = originalOpen;
      fs.unlinkSync(path.dirname(boundedPath));
      fs.renameSync(externalArtifacts, path.dirname(boundedPath));
    }
    fs.chmodSync(boundedPath, 0o644);
    const nonPrivatePreview = await previewWorktreeDiscard({ runId: bounded.manifest.runId, manifestPath: bounded.manifestPath, workerIds: ["worker_1"] });
    assert.equal(nonPrivatePreview.ok, false, "non-private artifact must not authorize branch deletion");
    fs.chmodSync(boundedPath, 0o600);
    fs.truncateSync(boundedPath, MAX_WORKTREE_PATCH_BYTES + 1);
    const grownPreview = await previewWorktreeDiscard({ runId: bounded.manifest.runId, manifestPath: bounded.manifestPath, workerIds: ["worker_1"] });
    assert.equal(grownPreview.ok, false, "actual oversized file must be rejected despite bounded manifest patchBytes");
    assert.ok(grownPreview.errorCode === "MANIFEST_UNAVAILABLE" || grownPreview.workers[0]?.blockedBy.includes("ARTIFACT_INVALID"));
    assert.equal(grownPreview.confirmationToken, undefined, "an oversized artifact cannot authorize deletion");
    assert.equal(fs.existsSync(boundedPath), true, "invalid extant artifact must remain available for recovery");
    assert.equal(synchronousArtifactReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  const changed = fixture("run_changed");
  const changedPreview = await previewWorktreeDiscard({ runId: changed.manifest.runId, manifestPath: changed.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION });
  changed.manifest.expiresAt = new Date(Date.now() + 120_000).toISOString();
  changed.manifest.updatedAt = new Date().toISOString();
  writeWorktreeManifestAtomic(changed.manifestPath, changed.manifest);
  const stale = await commitWorktreeDiscard({ runId: changed.manifest.runId, confirmationToken: changedPreview.confirmationToken! });
  assert.equal(stale.errorCode, "MANIFEST_CHANGED");
  assert.equal(fs.existsSync(changed.manifest.workers[0].worktreePath), true);

  const dirty = fixture("run_dirty");
  fs.writeFileSync(path.join(dirty.manifest.workers[0].worktreePath, "untracked.txt"), "valuable\n");
  const risky = await previewWorktreeDiscard({ runId: dirty.manifest.runId, manifestPath: dirty.manifestPath, workerIds: ["worker_1"] });
  assert.deepEqual(risky.riskCodes, ["UNCAPTURED_DIRTY_WORKTREE"]);
  assert.equal(risky.requiresStrongConfirmation, true);
  assert.equal(risky.confirmationToken, undefined);
  const acknowledged = await previewWorktreeDiscard({ runId: dirty.manifest.runId, manifestPath: dirty.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION });
  assert.ok(acknowledged.confirmationToken);
  fs.writeFileSync(path.join(dirty.manifest.workers[0].worktreePath, "late-important.txt"), "arrived after confirmation\n");
  const dirtyCommitted = await commitWorktreeDiscard({ runId: dirty.manifest.runId, confirmationToken: acknowledged.confirmationToken! });
  assert.equal(dirtyCommitted.complete, false);
  assert.equal(dirtyCommitted.workers[0].reason, "PRESERVED_FOR_RECOVERY");
  assert.deepEqual(dirtyCommitted.workers[0].retainedResources, ["worktree", "branch"]);
  assert.equal(fs.readFileSync(path.join(dirty.manifest.workers[0].worktreePath, "late-important.txt"), "utf8"), "arrived after confirmation\n");

  const ignored = fixture("run_ignored");
  fs.mkdirSync(path.join(ignored.manifest.workers[0].worktreePath, ".private"));
  fs.writeFileSync(path.join(ignored.manifest.workers[0].worktreePath, ".private", "valuable.env"), "secret\n");
  const ignoredPreview = await previewWorktreeDiscard({ runId: ignored.manifest.runId, manifestPath: ignored.manifestPath, workerIds: ["worker_1"] });
  assert.ok(ignoredPreview.riskCodes.includes("IGNORED_FILES_PRESENT"));
  assert.ok(ignoredPreview.riskCodes.includes("WORKTREE_CONTENT_UNVERIFIED"));
  assert.equal(ignoredPreview.requiresStrongConfirmation, true);
  assert.equal(ignoredPreview.confirmationToken, undefined);

  const ignoredAcknowledged = await previewWorktreeDiscard({ runId: ignored.manifest.runId, manifestPath: ignored.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION });
  const ignoredResult = await commitWorktreeDiscard({
    runId: ignored.manifest.runId,
    confirmationToken: ignoredAcknowledged.confirmationToken!,
    beforeWorkerDiscard: () => fs.writeFileSync(path.join(ignored.manifest.workers[0].worktreePath, ".private", "late.env"), "late secret\n"),
  });
  assert.equal(ignoredResult.workers[0].reason, "PRESERVED_FOR_RECOVERY");
  assert.equal(fs.existsSync(path.join(ignored.manifest.workers[0].worktreePath, ".private", "late.env")), true);

  const partial = fixture("run_partial", 2);
  git(partial.repo, ["worktree", "remove", "--force", partial.manifest.workers[0].worktreePath]);
  const partialPreview = await previewWorktreeDiscard({ runId: partial.manifest.runId, manifestPath: partial.manifestPath, workerIds: ["worker_1", "worker_2"], strongConfirmation: DISCARD_STRONG_CONFIRMATION });
  const partialResult = await commitWorktreeDiscard({
    runId: partial.manifest.runId,
    confirmationToken: partialPreview.confirmationToken!,
    beforeWorkerDiscard: async (workerId) => {
      if (workerId !== "worker_2") return;
      fs.writeFileSync(path.join(partial.manifest.workers[1].worktreePath, "late.txt"), "changed after strict scan\n");
    },
  });
  assert.equal(partialResult.complete, false);
  assert.equal(partialResult.ok, false);
  assert.deepEqual(partialResult.workers.map((worker) => [worker.workerId, worker.success, worker.reason]), [
    ["worker_1", true, "DISCARDED"],
    ["worker_2", false, "PRESERVED_FOR_RECOVERY"],
  ]);
  assert.equal(fs.existsSync(partial.manifest.workers[0].worktreePath), false);
  assert.equal(fs.existsSync(partial.manifest.workers[1].worktreePath), true);
  assert.equal(fs.existsSync(path.join(partial.manifest.workers[1].worktreePath, "late.txt")), true);

  const replacement = fixture("run_token_replacement");
  const firstToken = (await previewWorktreeDiscard({ runId: replacement.manifest.runId, manifestPath: replacement.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION })).confirmationToken!;
  const secondToken = (await previewWorktreeDiscard({ runId: replacement.manifest.runId, manifestPath: replacement.manifestPath, workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION })).confirmationToken!;
  assert.notEqual(firstToken, secondToken);
  assert.equal((await commitWorktreeDiscard({ runId: replacement.manifest.runId, confirmationToken: firstToken })).errorCode, "TOKEN_INVALID");

  const advanced = fixture("run_branch_advanced");
  git(advanced.repo, ["worktree", "remove", "--force", advanced.manifest.workers[0].worktreePath]);
  const advancedPreview = await previewWorktreeDiscard({ runId: advanced.manifest.runId, manifestPath: advanced.manifestPath, workerIds: ["worker_1"] });
  const advancedTree = git(advanced.repo, ["rev-parse", `${advanced.manifest.baseCommit}^{tree}`]);
  const advancedCommit = git(advanced.repo, ["commit-tree", advancedTree, "-p", advanced.manifest.baseCommit, "-m", "late branch commit"]);
  git(advanced.repo, ["update-ref", `refs/heads/${advanced.manifest.workers[0].branch}`, advancedCommit, advanced.manifest.baseCommit]);
  const advancedResult = await commitWorktreeDiscard({ runId: advanced.manifest.runId, confirmationToken: advancedPreview.confirmationToken! });
  assert.equal(advancedResult.errorCode, "PRECONDITION_FAILED", "preview token must bind the branch OID");
  assert.equal(git(advanced.repo, ["rev-parse", advanced.manifest.workers[0].branch]), advancedCommit, "late branch commit must be retained");

  const failedCapture = fixture("run_failed_capture");
  git(failedCapture.repo, ["worktree", "remove", "--force", failedCapture.manifest.workers[0].worktreePath]);
  const failedTree = git(failedCapture.repo, ["rev-parse", `${failedCapture.manifest.baseCommit}^{tree}`]);
  const failedHead = git(failedCapture.repo, ["commit-tree", failedTree, "-p", failedCapture.manifest.baseCommit, "-m", "uncaptured commit"]);
  git(failedCapture.repo, ["update-ref", `refs/heads/${failedCapture.manifest.workers[0].branch}`, failedHead, failedCapture.manifest.baseCommit]);
  failedCapture.manifest.workers[0].capture = {
    changed: false, workerBranch: failedCapture.manifest.workers[0].branch, workerHead: failedHead,
    patchPath: null, patchSha256: null, patchBytes: null, changedFiles: [], binaryFiles: [], capturedAt: null,
    captureError: "ARTIFACT_PATCH_WRITE_FAILED",
  };
  failedCapture.manifest.updatedAt = new Date().toISOString();
  writeWorktreeManifestAtomic(failedCapture.manifestPath, failedCapture.manifest);
  const failedCapturePreview = await previewWorktreeDiscard({ runId: failedCapture.manifest.runId, manifestPath: failedCapture.manifestPath, workerIds: ["worker_1"] });
  assert.deepEqual(failedCapturePreview.workers[0].retainedResources, ["branch"]);
  const failedCaptureResult = await commitWorktreeDiscard({ runId: failedCapture.manifest.runId, confirmationToken: failedCapturePreview.confirmationToken! });
  assert.equal(failedCaptureResult.workers[0].reason, "PRESERVED_FOR_RECOVERY");
  assert.equal(git(failedCapture.repo, ["rev-parse", failedCapture.manifest.workers[0].branch]), failedHead);

  const unapplied = fixture("run_unapplied_count");
  git(unapplied.repo, ["worktree", "remove", "--force", unapplied.manifest.workers[0].worktreePath]);
  const unappliedPatch = path.join(unapplied.runDir, "artifacts", "unapplied.patch");
  fs.mkdirSync(path.dirname(unappliedPatch), { mode: 0o700 });
  fs.writeFileSync(unappliedPatch, "", { mode: 0o600 });
  unapplied.manifest.workers[0].capture = {
    changed: true, workerBranch: unapplied.manifest.workers[0].branch, workerHead: unapplied.manifest.baseCommit,
    patchPath: unappliedPatch, patchSha256: createHash("sha256").update("").digest("hex"), patchBytes: 0,
    changedFiles: ["already-applied.txt", "still-unapplied.txt"], binaryFiles: [], capturedAt: new Date().toISOString(), captureError: null,
  };
  const appliedAt = new Date().toISOString();
  unapplied.manifest.apply = {
    transactionId: "applied-count", requestedWorkerIds: ["worker_1"], requestedFiles: null,
    appliedFiles: ["already-applied.txt"], startedAt: appliedAt, finishedAt: appliedAt, outcome: "applied", errorCode: null,
  };
  unapplied.manifest.state = "applied";
  unapplied.manifest.updatedAt = appliedAt;
  writeWorktreeManifestAtomic(unapplied.manifestPath, unapplied.manifest);
  const unappliedPreview = await previewWorktreeDiscard({ runId: unapplied.manifest.runId, manifestPath: unapplied.manifestPath, workerIds: ["worker_1"] });
  assert.equal(unappliedPreview.unappliedFileCount, 1);
  assert.deepEqual(unappliedPreview.workers[0].retainedResources, ["patch"]);

  const routeRunId = `route_discard_${Date.now()}`;
  const routeFixture = fixture(routeRunId, 1, true);
  const routeNow = new Date().toISOString();
  const routeState: CollaborationRunState = {
    runId: routeRunId, version: 0, cwd: routeFixture.repo, message: "discard route integration",
    mode: "isolated_coding", status: "complete", worktreeManifestPath: routeFixture.manifestPath, baseCommit: routeFixture.manifest.baseCommit,
    canContinue: true,
    workers: [{ name: "Worker 1", task: "test", workerId: "worker_1", status: "complete", worktreePath: routeFixture.manifest.workers[0].worktreePath, canContinue: true }],
    events: [], createdAt: routeNow, updatedAt: routeNow,
  };
  createCollaborationRun(routeState);
  try {
    const routePreviewResponse = await discardRoute(new Request(`http://localhost/api/agent-runs/${routeRunId}/discard`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "preview", workerIds: ["worker_1"], strongConfirmation: DISCARD_STRONG_CONFIRMATION }),
    }), { params: Promise.resolve({ runId: routeRunId }) });
    assert.equal(routePreviewResponse.status, 200);
    const routePreview = await routePreviewResponse.json();
    assert.deepEqual(routePreview.workers[0].retainedResources, ["worktree", "branch"]);
    const routeCommitResponse = await discardRoute(new Request(`http://localhost/api/agent-runs/${routeRunId}/discard`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "commit", confirmationToken: routePreview.confirmationToken }),
    }), { params: Promise.resolve({ runId: routeRunId }) });
    assert.equal(routeCommitResponse.status, 207);
    const stored = getCollaborationRun(routeRunId)!;
    assert.equal(stored.status, "recoverable");
    assert.equal(stored.canContinue, false);
    assert.equal(stored.workers[0].canContinue, false);
    assert.equal(stored.events.at(-1)?.type, "worktree_preserved");
    assert.equal(stored.events.at(-1)?.reasonCode, "PRESERVED_FOR_RECOVERY");

    updateCollaborationRun(routeRunId, (run) => { run.worktreeManifestPath = routeFixture.manifestPath.replace(routeRunId, "different-run"); });
    const poisoned = await discardRoute(new Request(`http://localhost/api/agent-runs/${routeRunId}/discard`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "preview", workerIds: ["worker_1"] }),
    }), { params: Promise.resolve({ runId: routeRunId }) });
    assert.equal(poisoned.status, 409, "route must reject a snapshot pointing outside its fixed run directory");
  } finally {
    await removeCollaborationRun(routeRunId);
    try { git(routeFixture.repo, ["worktree", "remove", "--force", routeFixture.manifest.workers[0].worktreePath]); } catch { /* cleanup */ }
    fs.rmSync(routeFixture.runDir, { recursive: true, force: true });
  }

  console.log("worktree discard tests passed");
} finally {
  for (const name of fs.existsSync(sandbox) ? fs.readdirSync(sandbox) : []) {
    if (!name.endsWith("-repo")) continue;
    const repo = path.join(sandbox, name);
    try {
      for (const line of git(repo, ["worktree", "list", "--porcelain"]).split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== repo) {
          try { git(repo, ["worktree", "remove", "--force", line.slice(9)]); } catch { /* cleanup */ }
        }
      }
    } catch { /* cleanup */ }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
