import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}
export function makeRepository(root: string, name: string): string {
  const repo = path.join(root, name); fs.mkdirSync(repo, { mode: 0o700 });
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "e2e@example.invalid"]); git(repo, ["config", "user.name", "E2E"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  fs.mkdirSync(path.join(repo, "nested")); fs.writeFileSync(path.join(repo, "nested", "base.txt"), "nested\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]); return repo;
}
/** Includes HEAD, index tree, porcelain and working-file bytes; ignored Git metadata is not a user tree change. */
export function treeDigest(repo: string): string {
  const hash = createHash("sha256");
  for (const args of [["rev-parse", "HEAD"], ["write-tree"], ["status", "--porcelain=v1", "-z", "--untracked-files=all"]]) hash.update(git(repo, args));
  const names = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  for (const name of [...new Set(names)]) {
    hash.update(name); const target = path.join(repo, name);
    if (!fs.existsSync(target)) { hash.update("missing"); continue; }
    const stat = fs.lstatSync(target); hash.update(String(stat.mode));
    hash.update(stat.isSymbolicLink() ? fs.readlinkSync(target) : fs.readFileSync(target));
  }
  return hash.digest("hex");
}
export function assertPublic(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertPublic(item); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["sessionId", "worktreePath", "patchPath", "worktreeManifestPath", "gitCommonDir", "agentCwd"].includes(key), `private outbound field: ${key}`);
    assertPublic(child);
  }
}
