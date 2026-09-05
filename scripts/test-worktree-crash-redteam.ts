import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicApply } from "../lib/parallel-agent/atomic-apply.ts";
import { captureWorktreeArtifact } from "../lib/parallel-agent/worktree-artifacts.ts";
import { reconcileRuns } from "../lib/parallel-agent/worktree-reconciler.ts";
import { readWorktreeManifest, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-crash-redteam-")));
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(name: string) {
  const root = path.join(sandbox, name); fs.mkdirSync(root, { mode: 0o700 });
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "Crash Test"]); git(repo, ["config", "user.email", "crash@example.invalid"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const runsRoot = path.join(root, "runs"); const runId = `run_${name}`;
  const runDir = path.join(runsRoot, runId); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const worktreePath = path.join(runDir, "1-worker_1"); const branch = `deerhux/${runId}/1-worker_1`;
  git(repo, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  const now = new Date().toISOString();
  const manifest: WorktreeManifestV1 = { version: 1, runId, instanceId: "crash-owner", ownerPid: 2_147_483_647,
    processStartIdentity: "crash-owner", heartbeatAt: now, activeOperation: "running", repoRoot: repo,
    gitCommonDir: path.join(repo, ".git"), sourceCwdRelative: ".", baseCommit, state: "running", apply: null,
    workers: [{ workerId: "worker_1", displayName: "Worker", index: 0, worktreePath, agentCwd: worktreePath,
      branch, provider: "test", state: "running", capture: null, cleanup: null }], createdAt: now, updatedAt: now, expiresAt: now };
  const manifestPath = path.join(runDir, "worktree-manifest.json"); writeWorktreeManifestAtomic(manifestPath, manifest);
  fs.writeFileSync(path.join(worktreePath, "source.txt"), `${name} result\n`);
  const baseline = { head: baseCommit, status: git(repo, ["status", "--porcelain=v1"]), index: fs.readFileSync(path.join(repo, ".git", "index")) };
  return { repo, runsRoot, runDir, worktreePath, branch, manifestPath, baseline };
}
function crash(source: string, expectedCode: number) {
  // Abrupt exit intentionally retains scratch/locks. Register its tmp namespace
  // inside this fixture so final teardown cannot leak it to the host tmp root.
  const childTemporary = fs.mkdtempSync(path.join(sandbox, "crash-tmp-"));
  const child = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, TMPDIR: childTemporary, TMP: childTemporary, TEMP: childTemporary },
  });
  assert.equal(child.error, undefined); assert.equal(child.status, expectedCode, child.stderr);
}
try {
  for (const phase of ["Prepared", "Checked"] as const) {
    const test = fixture(phase.toLowerCase());
    assert.equal((await captureWorktreeArtifact(test.manifestPath, "worker_1")).ok, true);
    const request = { manifestPath: test.manifestPath, targetCwd: test.repo, workerIds: ["worker_1"], transactionId: `tx_${phase}`,
      idempotencyKey: `key_${phase}`, staleLockMs: 1 };
    const applyUrl = new URL("../lib/parallel-agent/atomic-apply.ts", import.meta.url).href;
    crash(`import { atomicApply } from ${JSON.stringify(applyUrl)};
      await atomicApply({ ...${JSON.stringify(request)}, faults: { after${phase}() { process.exit(71); } } });`, 71);
    const after = readWorktreeManifest(test.manifestPath); assert.equal(after.kind, "ok");
    assert.equal(after.kind === "ok" && after.manifest.state, "applying", `${phase}: real process exit bypassed catch/finally`);
    assert.equal(git(test.repo, ["status", "--porcelain=v1"]), test.baseline.status);
    assert.deepEqual(fs.readFileSync(path.join(test.repo, ".git", "index")), test.baseline.index);
    assert.equal(fs.readFileSync(path.join(test.repo, "source.txt"), "utf8"), "base\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recovered = await atomicApply(request);
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(fs.readFileSync(path.join(test.repo, "source.txt"), "utf8"), `${phase.toLowerCase()} result\n`);
    assert.equal(fs.existsSync(test.worktreePath), true); assert.equal(git(test.repo, ["rev-parse", test.branch]), test.baseline.head);
  }

  const published = fixture("capture_publish");
  const captureUrl = new URL("../lib/parallel-agent/worktree-artifacts.ts", import.meta.url).href;
  crash(`import { captureWorktreeArtifact } from ${JSON.stringify(captureUrl)};
    await captureWorktreeArtifact(${JSON.stringify(published.manifestPath)}, "worker_1", {
      faults: { beforeManifestWrite() { process.exit(72); } }
    });`, 72);
  const unsettled = readWorktreeManifest(published.manifestPath); assert.equal(unsettled.kind, "ok");
  assert.equal(unsettled.kind === "ok" && unsettled.manifest.workers[0].capture, null, "published artifact is not yet settled in manifest");
  const artifacts = fs.readdirSync(path.join(published.runDir, "artifacts")).filter((name) => name.endsWith(".patch"));
  assert.equal(artifacts.length, 1, "patch publication completed before abrupt process exit");
  const patchPath = path.join(published.runDir, "artifacts", artifacts[0]); const patchBytes = fs.readFileSync(patchPath);
  assert.match(patchBytes.toString("utf8"), /capture_publish result/);
  await reconcileRuns({ runsRoot: published.runsRoot, instanceId: "restart", processStartIdentity: "restart", isProcessAlive: () => false });
  const recovered = readWorktreeManifest(published.manifestPath);
  assert.equal(recovered.kind === "ok" && recovered.manifest.state, "preserved");
  assert.deepEqual(fs.readFileSync(patchPath), patchBytes); assert.equal(fs.existsSync(published.worktreePath), true);
  assert.equal(git(published.repo, ["rev-parse", published.branch]), published.baseline.head);
  assert.equal(git(published.repo, ["status", "--porcelain=v1"]), published.baseline.status);
  assert.deepEqual(fs.readFileSync(path.join(published.repo, ".git", "index")), published.baseline.index);
  console.log("worktree crash redteam passed (fresh process exits at prepared/checked and patch-published-before-manifest)");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  assert.equal(fs.existsSync(sandbox), false, "fixture-owned crash resources were not removed");
}
