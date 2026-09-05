import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectGitFacts, executeCleanup, planCleanup, scanRunsRoot } from "../lib/parallel-agent/worktree-reconciler.ts";
import { MAX_WORKTREE_PATCH_BYTES, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";
import { previewWorktreeDiscard, commitWorktreeDiscard } from "../lib/parallel-agent/worktree-discard.ts";

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-security-redteam-")));
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(runId: string, managedRunDir?: string) {
  const repo = path.join(sandbox, `${runId}-repo`);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Redteam"]);
  git(repo, ["config", "user.email", "redteam@example.invalid"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const runsRoot = path.join(sandbox, `${runId}-runs`);
  const runDir = managedRunDir ?? path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const workerPath = path.join(runDir, "1-worker_1");
  const branch = `deerhux/${runId}/1-worker_1`;
  const patchPath = path.join(runDir, "artifacts", "empty.patch");
  fs.mkdirSync(path.dirname(patchPath), { mode: 0o700 });
  fs.writeFileSync(patchPath, "", { mode: 0o600 });
  const old = new Date(Date.now() - 100_000_000).toISOString();
  const manifest: WorktreeManifestV1 = {
    version: 1, runId, instanceId: "dead", ownerPid: 2_147_483_647, processStartIdentity: "dead",
    heartbeatAt: old, activeOperation: null, repoRoot: fs.realpathSync(repo),
    gitCommonDir: fs.realpathSync(path.join(repo, ".git")), sourceCwdRelative: ".", baseCommit: base,
    state: "captured", apply: null, createdAt: old, updatedAt: old, expiresAt: old,
    workers: [{ workerId: "worker_1", displayName: "Worker", index: 0, worktreePath: workerPath,
      agentCwd: workerPath, branch, provider: "test", state: "captured", cleanup: null,
      capture: { changed: false, workerBranch: branch, workerHead: base, patchPath,
        patchSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", patchBytes: 0,
        changedFiles: [], binaryFiles: [], capturedAt: old, captureError: null } }],
  };
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  writeWorktreeManifestAtomic(manifestPath, manifest);
  return { repo, base, runsRoot, runDir, manifestPath, manifest };
}

try {
  // Git status can execute clean filters even without git add. Management
  // diagnostics must not turn shared repository config into command execution.
  const configured = fixture("run_shared_config");
  const marker = path.join(sandbox, "filter-ran");
  const filterScript = path.join(sandbox, "filter.sh");
  fs.writeFileSync(filterScript, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o700 });
  git(configured.repo, ["config", "filter.redteam.clean", filterScript]);
  fs.writeFileSync(path.join(configured.repo, ".gitattributes"), "*.txt filter=redteam\n");
  git(configured.repo, ["add", ".gitattributes"]);
  git(configured.repo, ["commit", "-qm", "filter attribute"]);
  git(configured.repo, ["worktree", "add", "-b", configured.manifest.workers[0].branch,
    configured.manifest.workers[0].worktreePath, "HEAD"]);
  git(configured.manifest.workers[0].worktreePath, ["config", "deerhux.sharedBoundary", "worker-wrote-common-config"]);
  assert.equal(git(configured.repo, ["config", "--get", "deerhux.sharedBoundary"]), "worker-wrote-common-config",
    "the fixture documents collaboration isolation: Worker Git config is shared, not an OS sandbox");
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(configured.manifest.workers[0].worktreePath, "source.txt"), "edit\n");
  collectGitFacts(configured.manifest, configured.manifest.workers[0], configured.runDir);
  assert.equal(fs.existsSync(marker), false, "management Git fact reads must not execute repository clean filters");

  const artifacts = fixture("run_artifact_boundary");
  const artifactWorker = artifacts.manifest.workers[0];
  const artifactPath = artifactWorker.capture!.patchPath!;
  assert.equal(collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir).artifactDigestMatches, true);
  fs.chmodSync(artifactPath, 0o644);
  assert.equal(collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir).artifactDigestMatches, false, "public artifact mode must fail closed");
  fs.chmodSync(artifactPath, 0o600);
  fs.writeFileSync(artifactPath, "x");
  artifactWorker.capture!.patchBytes = 1;
  assert.equal(collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir).artifactDigestMatches, false, "digest mismatch must fail closed");
  fs.truncateSync(artifactPath, MAX_WORKTREE_PATCH_BYTES + 1);
  assert.equal(collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir).artifactDigestMatches, false, "oversized sparse artifact must not be loaded");
  fs.truncateSync(artifactPath, 0);
  const outsidePatch = path.join(sandbox, "outside.patch");
  fs.writeFileSync(outsidePatch, "not a managed artifact", { mode: 0o600 });
  const originalOpen = fs.openSync;
  let outsideOpened = false;
  fs.openSync = ((target: Parameters<typeof fs.openSync>[0], ...args: unknown[]) => {
    if (String(target) === outsidePatch) outsideOpened = true;
    return Reflect.apply(originalOpen, fs, [target, ...args]);
  }) as typeof fs.openSync;
  try {
    artifactWorker.capture!.patchPath = outsidePatch;
    const outsideFacts = collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir);
    assert.equal(outsideFacts.pathSafe, false);
    assert.equal(outsideOpened, false, "out-of-root patch must be rejected before opening");
  } finally { fs.openSync = originalOpen; }
  artifactWorker.capture!.patchPath = artifactPath;
  fs.unlinkSync(artifactPath);
  fs.symlinkSync(outsidePatch, artifactPath);
  assert.equal(collectGitFacts(artifacts.manifest, artifactWorker, artifacts.runDir).pathSafe, false, "artifact symlink must fail closed");

  // The scan is a read-time snapshot, not durable deletion authority. A stale
  // plan must not authorize a different ref even if updatedAt is forged equal.
  const swapped = fixture("run_branch_swap");
  const scanned = scanRunsRoot(swapped.runsRoot).runs[0];
  assert.ok(scanned);
  const facts = collectGitFacts(scanned.manifest, scanned.manifest.workers[0], scanned.runDir);
  const plan = planCleanup(scanned, { worker_1: facts }, { isProcessAlive: () => false });
  swapped.manifest.workers[0].branch = "main";
  swapped.manifest.workers[0].capture!.workerBranch = "main";
  writeWorktreeManifestAtomic(swapped.manifestPath, swapped.manifest);
  await executeCleanup(plan, { instanceId: "redteam", processStartIdentity: "redteam", isProcessAlive: () => false });
  assert.equal(git(swapped.repo, ["rev-parse", "--verify", "refs/heads/main"]), swapped.base,
    "a forged current manifest must never authorize deletion outside the run branch namespace");

  const forged = fixture("run_foreign_identity");
  const victim = fixture("run_victim");
  const foreignBranch = forged.manifest.workers[0].branch;
  git(victim.repo, ["branch", foreignBranch, victim.base]);
  forged.manifest.repoRoot = victim.manifest.repoRoot;
  forged.manifest.gitCommonDir = victim.manifest.gitCommonDir;
  forged.manifest.baseCommit = victim.base;
  forged.manifest.workers[0].capture!.workerHead = victim.base;
  writeWorktreeManifestAtomic(forged.manifestPath, forged.manifest);
  const foreignRun = scanRunsRoot(forged.runsRoot).runs[0];
  assert.ok(foreignRun);
  const foreignFacts = collectGitFacts(foreignRun.manifest, foreignRun.manifest.workers[0], foreignRun.runDir);
  const foreignPlan = planCleanup(foreignRun, { worker_1: foreignFacts }, { isProcessAlive: () => false });
  if (!process.argv.includes("--discard-only")) {
    await executeCleanup(foreignPlan, { instanceId: "redteam", processStartIdentity: "redteam", isProcessAlive: () => false });
  }
  assert.equal(git(victim.repo, ["rev-parse", "--verify", foreignBranch]), victim.base,
    "self-consistent foreign repo/common manifest is not independent creation authority");
  const preview = await previewWorktreeDiscard({ runId: forged.manifest.runId, manifestPath: forged.manifestPath, workerIds: ["worker_1"] });
  if (preview.confirmationToken) await commitWorktreeDiscard({ runId: forged.manifest.runId, confirmationToken: preview.confirmationToken });
  assert.equal(git(victim.repo, ["rev-parse", "--verify", foreignBranch]), victim.base,
    "Discard without trusted repository identity must not delete a manifest-selected foreign ref");

  const symlinked = fixture("run_root_symlink");
  const rootAlias = path.join(sandbox, "runs-root-alias");
  fs.symlinkSync(symlinked.runsRoot, rootAlias);
  assert.equal(scanRunsRoot(rootAlias).runs.length, 0, "a symlink management root must not grant run authority");

  if (process.argv.includes("--http")) {
    const { POST } = await import("../app/api/agent-runs/[runId]/discard/route.ts");
    const { createCollaborationRun, getCollaborationRun, removeCollaborationRun } = await import("../lib/parallel-agent/collaboration-store.ts");
    const { getIsolatedRunDir } = await import("../lib/parallel-agent/worktree.ts");
    const runId = `security_http_${process.pid}_${Date.now()}`;
    const managedDir = getIsolatedRunDir(runId);
    assert.equal(fs.existsSync(managedDir), false);
    const httpFixture = fixture(runId, managedDir);
    const originalManifest = structuredClone(httpFixture.manifest);
    const foreignHttpBranch = originalManifest.workers[0].branch;
    git(victim.repo, ["branch", foreignHttpBranch, victim.base]);
    const createdAt = new Date().toISOString();
    createCollaborationRun({ runId, version: 0, cwd: httpFixture.repo, message: "security test",
      mode: "isolated_coding", status: "complete", worktreeManifestPath: httpFixture.manifestPath,
      baseCommit: httpFixture.base, canContinue: false,
      workers: [{ workerId: "worker_1", name: "Worker", task: "test", status: "complete" }],
      events: [], createdAt, updatedAt: createdAt });
    try {
      httpFixture.manifest.repoRoot = victim.manifest.repoRoot;
      httpFixture.manifest.gitCommonDir = victim.manifest.gitCommonDir;
      httpFixture.manifest.baseCommit = victim.base;
      httpFixture.manifest.workers[0].capture!.workerHead = victim.base;
      writeWorktreeManifestAtomic(httpFixture.manifestPath, httpFixture.manifest);
      const before = JSON.stringify(getCollaborationRun(runId));
      const response = await POST(new Request(`http://localhost/api/agent-runs/${runId}/discard`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "preview", workerIds: ["worker_1"] }),
      }), { params: Promise.resolve({ runId }) });
      assert.equal(response.status, 409, "HTTP preview must reject foreign manifest despite valid managed path and run ID");
      const body = await response.json();
      assert.equal(body.errorCode, "REPOSITORY_MISMATCH");
      assert.equal(body.confirmationToken, undefined);
      assert.equal(JSON.stringify(getCollaborationRun(runId)), before, "rejected preview must not change Run state");
      assert.equal(git(victim.repo, ["rev-parse", "--verify", foreignHttpBranch]), victim.base);
    } finally {
      await removeCollaborationRun(runId);
      fs.rmSync(managedDir, { recursive: true, force: true });
    }
  }
  console.log("worktree security redteam tests passed (branch/foreign-repository authority and root symlink)");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
