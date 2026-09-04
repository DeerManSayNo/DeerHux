import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listProjectBranches, readProjectBranch, switchProjectBranch } from "../lib/project-branch.ts";

const root = await mkdtemp(path.join(tmpdir(), "deerhux-branch-test-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "fixture");
try {
  assert.equal(await readProjectBranch(root), null);
  await assert.rejects(listProjectBranches(root));
  git("init", "-b", "main");
  assert.equal(await readProjectBranch(root), "main");
  assert.deepEqual(await listProjectBranches(root), []);
  await writeFile(path.join(root, "fixture.txt"), "main\n");
  git("add", "fixture.txt");
  commit();
  git("switch", "-c", "feature/sidebar");
  await writeFile(path.join(root, "fixture.txt"), "feature\n");
  commit();
  assert.deepEqual(await listProjectBranches(root), ["feature/sidebar", "main"]);
  assert.equal(await switchProjectBranch(root, "main"), "main");
  await writeFile(path.join(root, "fixture.txt"), "local edits\n");
  await assert.rejects(switchProjectBranch(root, "feature/sidebar"));
  assert.equal(await readProjectBranch(root), "main");
  assert.equal(await readFile(path.join(root, "fixture.txt"), "utf8"), "local edits\n");
  await assert.rejects(switchProjectBranch(root, "missing"));
  await assert.rejects(switchProjectBranch(root, "--discard-changes"));
  await writeFile(path.join(root, "fixture.txt"), "main\n");
  const worktree = path.join(root, "worktree");
  git("worktree", "add", worktree, "feature/sidebar");
  assert.equal(await readProjectBranch(worktree), "feature/sidebar");
  await assert.rejects(switchProjectBranch(root, "feature/sidebar"));
  assert.equal(await readProjectBranch(root), "main");
  git("checkout", "--detach");
  assert.equal(await readProjectBranch(root), null);
  assert.equal(await switchProjectBranch(root, "main"), "main");
  console.log("PASS: branch listing, switching, dirty-file protection, invalid targets, worktree protection, detached HEAD");
} finally {
  await rm(root, { recursive: true, force: true });
}
