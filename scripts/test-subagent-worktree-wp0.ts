import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatch, inspectOrphanedRuns } from "../lib/parallel-agent/worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-wp0-"));
try {
  const main = path.join(fixtureRoot, "main repo");
  const worker = path.join(fixtureRoot, "worker tree");
  fs.mkdirSync(main);
  git(main, ["init"]);
  git(main, ["config", "user.email", "test@deerhux.local"]);
  git(main, ["config", "user.name", "DeerHux Test"]);
  fs.writeFileSync(path.join(main, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(main, "binary.bin"), Buffer.from([1, 0, 2]));
  git(main, ["add", "."]);
  git(main, ["commit", "-m", "base"]);
  git(main, ["worktree", "add", "--detach", worker, "HEAD"]);

  assert.equal(applyPatch(main, worker, []).success, false, "empty file selection must fail");
  assert.equal(applyPatch(main, worker).success, false, "empty patch must fail");

  fs.writeFileSync(path.join(worker, "new.txt"), "new file\n");
  assert.equal(applyPatch(main, worker).success, false, "untracked files must fail closed");
  assert.ok(fs.existsSync(path.join(worker, "new.txt")), "rejected untracked result must remain in the worktree");
  fs.unlinkSync(path.join(worker, "new.txt"));

  const excludePath = git(worker, ["rev-parse", "--git-path", "info/exclude"]);
  fs.appendFileSync(path.resolve(worker, excludePath), "ignored.txt\n");
  fs.writeFileSync(path.join(worker, "ignored.txt"), "ignored result\n");
  assert.equal(applyPatch(main, worker).success, false, "ignored files must fail closed");
  assert.ok(fs.existsSync(path.join(worker, "ignored.txt")), "rejected ignored result must remain in the worktree");
  fs.unlinkSync(path.join(worker, "ignored.txt"));

  fs.writeFileSync(path.join(worker, "tracked.txt"), "worker text\n");
  assert.equal(applyPatch(main, worker, ["tracked.txt"]).success, false, "partial file apply must be disabled");
  assert.equal(fs.readFileSync(path.join(worker, "tracked.txt"), "utf8"), "worker text\n");
  git(worker, ["checkout", "--", "tracked.txt"]);

  fs.writeFileSync(path.join(worker, "binary.bin"), Buffer.from([3, 0, 4, 0]));
  const beforeStatus = git(main, ["status", "--porcelain"]);
  const beforeBytes = fs.readFileSync(path.join(main, "binary.bin"));
  const binaryResult = applyPatch(main, worker);
  assert.equal(binaryResult.success, false, "binary patch must be rejected");
  assert.match(binaryResult.error ?? "", /atomic artifact apply/i);
  assert.deepEqual(fs.readFileSync(path.join(main, "binary.bin")), beforeBytes);
  assert.equal(git(main, ["status", "--porcelain"]), beforeStatus);
  git(worker, ["checkout", "--", "binary.bin"]);

  fs.writeFileSync(path.join(main, "local.txt"), "dirty\n");
  fs.writeFileSync(path.join(worker, "tracked.txt"), "worker text\n");
  assert.match(applyPatch(main, worker).error ?? "", /atomic artifact apply/i, "dirty target must fail closed");
  assert.equal(fs.readFileSync(path.join(main, "tracked.txt"), "utf8"), "base\n");
  assert.ok(fs.existsSync(worker), "failed apply must preserve the worker worktree");
  fs.unlinkSync(path.join(main, "local.txt"));
  git(worker, ["add", "tracked.txt"]);
  git(worker, ["commit", "-m", "worker commit"]);
  assert.match(applyPatch(main, worker).error ?? "", /atomic artifact apply/i, "worker commits must fail closed without base capture");
  assert.ok(fs.existsSync(worker), "committed worker result must remain in the worktree");

  const worktreeSource = fs.readFileSync(new URL("../lib/parallel-agent/worktree.ts", import.meta.url), "utf8");
  const inspectionBody = worktreeSource.slice(worktreeSource.indexOf("export function inspectOrphanedRuns"));
  assert.doesNotMatch(inspectionBody, /rmSync|worktree prune/, "startup inspection must not delete worktrees");
  assert.equal(typeof inspectOrphanedRuns().pendingDirs, "number");

  const routeSource = fs.readFileSync(new URL("../app/api/agent-runs/[runId]/apply/route.ts", import.meta.url), "utf8");
  const orchestratorSource = fs.readFileSync(new URL("../lib/parallel-agent/collaboration-orchestrator.ts", import.meta.url), "utf8");
  assert.match(routeSource, /applyCollaborationPatches\(runId, workerIds/, "API multi-worker requests must enter the atomic apply boundary");
  assert.match(orchestratorSource, /await atomicApply\(/, "orchestrator must use atomic artifact apply");
  assert.match(worktreeSource, /Legacy patch apply is disabled; atomic artifact apply is required/, "legacy per-worktree apply must remain disabled");
  assert.match(orchestratorSource, /new Set\(workerNames\)\.size !== workerNames\.length/, "duplicate worker names must be rejected centrally");
  assert.doesNotMatch(orchestratorSource.slice(orchestratorSource.indexOf("setCollaborationAbort"), orchestratorSource.indexOf("setCollaborationCleanup")), /cleanupAll|removeCollaborationRun/, "abort must preserve worktrees");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("subagent worktree WP0 tests passed");
