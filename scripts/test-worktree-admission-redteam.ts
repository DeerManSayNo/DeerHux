import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupIsolatedWorkspace, getIsolatedRunDir } from "../lib/parallel-agent/worktree.ts";

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-admission-redteam-")));
const ownedRuns: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  for (const dirtyKind of ["tracked", "staged", "untracked"] as const) {
    const repo = path.join(sandbox, dirtyKind); fs.mkdirSync(repo);
    git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "Admission"]); git(repo, ["config", "user.email", "admission@example.invalid"]);
    fs.writeFileSync(path.join(repo, "source.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repo, dirtyKind === "untracked" ? "untracked.txt" : "source.txt"), "local user changes\n");
    if (dirtyKind === "staged") git(repo, ["add", "source.txt"]);
    const runId = `admission_${dirtyKind}_${process.pid}_${Date.now()}`;
    const runDir = getIsolatedRunDir(runId); assert.equal(fs.existsSync(runDir), false); ownedRuns.push(runDir);
    const before = { worktrees: git(repo, ["worktree", "list", "--porcelain"]), refs: git(repo, ["show-ref"]),
      status: git(repo, ["status", "--porcelain=v1", "-z"]), index: fs.readFileSync(path.join(repo, ".git", "index")),
      source: fs.readFileSync(path.join(repo, "source.txt")) };
    await assert.rejects(setupIsolatedWorkspace(repo, runId, "admission-test", [{ workerId: "worker_1", displayName: "Worker" }]),
      /clean|uncommitted|dirty/i, `${dirtyKind}: dirty source must be rejected before resource allocation`);
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]), before.worktrees, dirtyKind);
    assert.equal(git(repo, ["show-ref"]), before.refs, dirtyKind);
    assert.equal(git(repo, ["status", "--porcelain=v1", "-z"]), before.status, dirtyKind);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), before.index, dirtyKind);
    assert.deepEqual(fs.readFileSync(path.join(repo, "source.txt")), before.source, dirtyKind);
    assert.equal(fs.existsSync(runDir), false, `${dirtyKind}: no managed Run directory may leak`);
  }
  console.log("worktree admission redteam passed (dirty tracked/staged/untracked rejected with zero resource changes)");
} finally {
  for (const runDir of ownedRuns) fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(sandbox, { recursive: true, force: true });
}
