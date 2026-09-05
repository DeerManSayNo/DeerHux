import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareWorktreeEnvironment, validateSyntheticPaths, WorktreeEnvironmentError } from "../lib/parallel-agent/worktree-environment.ts";

// Independent regression: all files and Git state below belong to this fixture.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-env-redteam-"));
const repo = path.join(sandbox, "repo");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const childPids: number[] = [];
try {
  fs.mkdirSync(repo);
  git("init", "-q"); git("config", "user.email", "environment-redteam@test.invalid"); git("config", "user.name", "Environment Redteam");
  fs.writeFileSync(path.join(repo, "source.txt"), "tracked baseline\n");
  const descendant = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('descendant-ready.txt','ready');setInterval(()=>fs.appendFileSync('heartbeat.txt','x'),20);";
  fs.writeFileSync(path.join(repo, "timeout.cjs"), `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('descendant-pid.txt',String(child.pid));setInterval(()=>{},20);`);
  git("add", "."); git("commit", "-qm", "base");
  const baseCommit = git("rev-parse", "HEAD");
  if (process.platform !== "win32") {
    await assert.rejects(prepareWorktreeEnvironment({ repoRoot: repo, worktreePath: repo, agentCwd: repo, baseCommit, workerId: "group-timeout-test", config: { mode: "hook", script: "timeout.cjs", timeoutMs: 300 } }),
      (error) => error instanceof WorktreeEnvironmentError && error.code === "ENV_HOOK_TIMEOUT");
    const pid = Number(fs.readFileSync(path.join(repo, "descendant-pid.txt"), "utf8"));
    childPids.push(pid);
    assert.ok(fs.existsSync(path.join(repo, "descendant-ready.txt")), "descendant installed its SIGTERM handler before timeout");
    await new Promise((resolve) => setTimeout(resolve, 220));
    const bytes = fs.statSync(path.join(repo, "heartbeat.txt")).size;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(fs.statSync(path.join(repo, "heartbeat.txt")).size, bytes,
      "timeout must terminate the whole original process group even when the parent exits before the force-kill timer");
  }
  const syntheticPath = path.join(repo, "cache.txt");
  fs.writeFileSync(syntheticPath, "synthetic must not become patch payload\n");
  const expectedIdentities = await validateSyntheticPaths({ worktreePath: repo, baseCommit, paths: ["cache.txt"] });
  git("add", "cache.txt"); git("commit", "-qm", "worker promotes cache into tracked source");
  git("rm", "--cached", "cache.txt");
  assert.equal(git("ls-files", "cache.txt"), "", "fixture stages removal while preserving HEAD entry");
  assert.equal(git("ls-tree", "--name-only", "HEAD", "--", "cache.txt"), "cache.txt");
  await assert.rejects(validateSyntheticPaths({ worktreePath: repo, baseCommit, paths: ["cache.txt"], expectedIdentities }),
    (error) => error instanceof WorktreeEnvironmentError && error.code === "ENV_SYNTHETIC_INVALID",
    "synthetic paths tracked in Worker HEAD must fail closed even when removed from the current index");
  assert.equal(fs.readFileSync(syntheticPath, "utf8"), "synthetic must not become patch payload\n", "validation never deletes data");
  console.log("worktree environment redteam tests passed (process-group timeout and HEAD/index staged-removal boundary)");
} finally {
  for (const pid of childPids) { try { process.kill(pid, "SIGKILL"); } catch { /* fixture child already terminated */ } }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
