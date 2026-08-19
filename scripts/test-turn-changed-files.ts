import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { diffGitStatusSnapshots, readGitStatusSnapshot } from "../lib/rpc-manager.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-changed-files-"));
const runGit = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

try {
  runGit(["init"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "DeerHux Test"]);
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(root, "sub", "nested.txt"), "base\n");
  runGit(["add", "."]);
  runGit(["commit", "-m", "initial"]);

  const baseline = await readGitStatusSnapshot(root);
  assert.ok(baseline, "clean Git repository must return an empty snapshot");
  assert.equal(baseline.size, 0);

  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "generated file.txt"), "generated\n");
  const current = await readGitStatusSnapshot(root);
  assert.ok(current, "Git status must be readable after modifications");
  const changed = new Set(diffGitStatusSnapshots(baseline, current, root));
  assert.ok(changed.has(path.join(root, "tracked.txt")), "modified tracked file must be detected");
  assert.ok(changed.has(path.join(root, "generated file.txt")), "untracked file with spaces must be detected");

  fs.unlinkSync(path.join(root, "tracked.txt"));
  const deleted = await readGitStatusSnapshot(root);
  assert.ok(deleted);
  const deletionPaths = diffGitStatusSnapshots(baseline, deleted, root);
  assert.ok(deletionPaths.includes(path.join(root, "tracked.txt")), "deleted tracked file must be detected");

  const nestedBaseline = await readGitStatusSnapshot(path.join(root, "sub"));
  assert.ok(nestedBaseline);
  fs.writeFileSync(path.join(root, "sub", "nested.txt"), "changed\n");
  const nestedCurrent = await readGitStatusSnapshot(path.join(root, "sub"));
  assert.ok(nestedCurrent);
  assert.ok(
    diffGitStatusSnapshots(nestedBaseline, nestedCurrent, path.join(root, "sub")).includes(path.join(root, "sub", "nested.txt")),
    "nested session cwd must resolve porcelain paths from repository root",
  );

  const preexisting = new Map([[path.join(root, "already-dirty.txt"), " M"]]);
  const unchanged = new Map([[path.join(root, "already-dirty.txt"), " M"]]);
  assert.deepEqual(diffGitStatusSnapshots(preexisting, unchanged, root), [], "unchanged pre-existing dirty state must not be attributed to the turn");
  assert.deepEqual(diffGitStatusSnapshots(null, current, root), [], "Git read failure must degrade without throwing");

  console.log("turn changed files tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
