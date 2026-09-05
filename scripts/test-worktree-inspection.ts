import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectManagedWorktrees, parseInspectionArguments, WORKTREE_INSPECTION_LIMITS } from "../lib/parallel-agent/worktree-inspection.ts";
import { writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-inspection-")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const old = "2026-01-01T00:00:00.000Z";
function directory(name: string): string { const result = path.join(root, name); fs.mkdirSync(result, { mode: 0o700 }); return result; }
function fixture(runs: string, repo: string, runId: string): { manifest: WorktreeManifestV1; manifestPath: string } {
  const runDirectory = path.join(runs, runId); fs.mkdirSync(runDirectory, { mode: 0o700 });
  const worktree = path.join(runDirectory, "1-worker");
  const manifest: WorktreeManifestV1 = { version: 1, runId, instanceId: "test-instance", ownerPid: process.pid, processStartIdentity: "test-process",
    heartbeatAt: old, activeOperation: null, repoRoot: repo, gitCommonDir: path.join(repo, ".git"), sourceCwdRelative: ".",
    baseCommit: git(repo, ["rev-parse", "HEAD"]), state: "preserved", workers: [{ workerId: "worker", displayName: "DO_NOT_PRINT_SECRET", index: 0,
      worktreePath: worktree, agentCwd: worktree, branch: `deerhux/${runId}/1-worker`, provider: "private-provider", state: "preserved", capture: null, cleanup: null }],
    apply: null, createdAt: old, updatedAt: old, expiresAt: old };
  const manifestPath = path.join(runDirectory, "worktree-manifest.json");
  writeWorktreeManifestAtomic(manifestPath, manifest);
  return { manifest, manifestPath };
}
try {
  assert.deepEqual(parseInspectionArguments(["--git", "--json"]), { git: true, json: true, help: false });
  for (const args of [["--delete"], ["--execute"], ["--runs-root"], ["--runs-root", "--git"]]) assert.throws(() => parseInspectionArguments(args), /INVALID_ARGUMENTS/);
  const repo = directory("repo"); git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "Inspection"]); git(repo, ["config", "user.email", "inspection@test.invalid"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "base\n"); fs.writeFileSync(path.join(repo, ".gitattributes"), "source.txt filter=inspection\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
  const runs = directory("runs");
  const live = fixture(runs, repo, "run-live");
  git(repo, ["worktree", "add", "-b", live.manifest.workers[0].branch, live.manifest.workers[0].worktreePath, "HEAD"]);
  const worker = live.manifest.workers[0];
  fs.writeFileSync(path.join(worker.worktreePath, "source.txt"), "edit\n");
  fs.writeFileSync(path.join(worker.worktreePath, "private-untracked.txt"), "PRIVATE_CONTENT");
  const marker = path.join(root, "filter-executed");
  git(repo, ["config", "filter.inspection.clean", `touch '${marker}'; cat`]);
  git(repo, ["config", "core.fsmonitor", `touch '${marker}'`]);
  const missing = fixture(runs, repo, "run-missing");
  missing.manifest.state = "applying";
  missing.manifest.apply = { transactionId: "private-tx", requestedWorkerIds: ["worker"], requestedFiles: null, appliedFiles: [], startedAt: old,
    finishedAt: null, outcome: "pending", errorCode: null };
  writeWorktreeManifestAtomic(missing.manifestPath, missing.manifest);
  const baseline = {
    refs: git(repo, ["show-ref"]), index: fs.readFileSync(git(worker.worktreePath, ["rev-parse", "--git-path", "index"])),
    mainIndex: fs.readFileSync(path.join(repo, ".git", "index")), manifest: fs.readFileSync(live.manifestPath), missing: fs.readFileSync(missing.manifestPath),
    source: fs.readFileSync(path.join(worker.worktreePath, "source.txt")), config: fs.readFileSync(path.join(repo, ".git", "config")),
  };
  const declared = await inspectManagedWorktrees({ runsRoot: runs });
  assert.equal(declared.gitChecked, false); assert.equal(declared.plans.length, 0); assert.equal(declared.counts.orphan, null);
  assert.equal(declared.inventory.gauges.managedRuns, 2);
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = (() => { throw new Error("unbounded synchronous directory scanning is forbidden"); }) as typeof fs.readdirSync;
  let report;
  try { report = await inspectManagedWorktrees({ runsRoot: runs, git: true }); }
  finally { fs.readdirSync = originalReaddir; }
  assert.equal(report.inspectedWorkers, 2); assert.equal(report.counts.orphan, 1); assert.equal(report.counts.missingWorktree, 1);
  assert.equal(report.counts.uncapturedDirty, 1); assert.equal(report.counts.staleTx, 1); assert.equal(report.counts.contentUnverified, 1);
  assert.ok(report.plans.every((plan) => plan.decision === "retain"));
  assert.equal(fs.existsSync(marker), false, "inspection must not execute clean filters or fsmonitor");
  assert.equal(git(repo, ["show-ref"]), baseline.refs);
  assert.deepEqual(fs.readFileSync(git(worker.worktreePath, ["rev-parse", "--git-path", "index"])), baseline.index);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), baseline.mainIndex);
  assert.deepEqual(fs.readFileSync(live.manifestPath), baseline.manifest); assert.deepEqual(fs.readFileSync(missing.manifestPath), baseline.missing);
  assert.deepEqual(fs.readFileSync(path.join(worker.worktreePath, "source.txt")), baseline.source);
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "config")), baseline.config);
  for (const secret of [root, "DO_NOT_PRINT_SECRET", "PRIVATE_CONTENT", "private-untracked", "private-provider", "private-tx", "source.txt"]) assert.equal(JSON.stringify(report).includes(secret), false);
  const artifacts = path.join(path.dirname(live.manifestPath), "artifacts"); fs.mkdirSync(artifacts, { mode: 0o700 });
  const patch = path.join(artifacts, "audit.patch"); fs.writeFileSync(patch, "PRIVATE_PATCH", { mode: 0o600 });
  worker.capture = { changed: true, workerBranch: worker.branch, workerHead: live.manifest.baseCommit, patchPath: patch,
    patchSha256: "a".repeat(64), patchBytes: 13, changedFiles: ["source.txt"], binaryFiles: [], capturedAt: old, captureError: null };
  writeWorktreeManifestAtomic(live.manifestPath, live.manifest);
  const originalOpen = fs.openSync;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { assert.notEqual(args[0], patch, "CLI never opens a patch"); return originalOpen(...args); }) as typeof fs.openSync;
  try { assert.equal((await inspectManagedWorktrees({ runsRoot: runs, git: true })).inspectedWorkers, 2); }
  finally { fs.openSync = originalOpen; }
  const linkedRoot = path.join(root, "linked-runs"); fs.symlinkSync(runs, linkedRoot);
  assert.equal((await inspectManagedWorktrees({ runsRoot: linkedRoot, git: true })).inventory.reason, "unsafe_root");
  const capped = directory("capped");
  for (let index = 0; index < 35; index++) fixture(capped, repo, `capped-${index}`);
  const bounded = await inspectManagedWorktrees({ runsRoot: capped, git: true });
  assert.equal(bounded.scannedCandidates, WORKTREE_INSPECTION_LIMITS.runs); assert.equal(bounded.truncated, true);
  const cli = execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "scripts/inspect-subagent-worktrees.ts", "--runs-root", runs, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(cli).gitChecked, false); assert.equal(cli.includes(root), false);
  assert.throws(() => execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "scripts/inspect-subagent-worktrees.ts", "--delete"], { stdio: "pipe" }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("worktree inspection tests passed (bounded, redacted, read-only Git, no filter/patch access)");
