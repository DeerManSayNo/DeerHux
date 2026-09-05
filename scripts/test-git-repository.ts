import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIT_LOCK_DIRECTORY_NAME,
  GitLockError,
  acquireGitLock,
  parseLinuxProcessStartTime,
  runInGitQueue,
  withGitLock,
} from "../lib/parallel-agent/git-lock.ts";
import { GitRepository, resolveGitRepository } from "../lib/parallel-agent/git-repository.ts";

const scriptPath = fileURLToPath(import.meta.url);
assert.equal(parseLinuxProcessStartTime("123 (worker with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20"), "424242");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function lockWorker(commonDir: string, logPath: string, worker: string): Promise<void> {
  await withGitLock({ commonDir, operation: `worker-${worker}`, timeoutMs: 5_000 }, async () => {
    fs.appendFileSync(logPath, `${worker}:start:${Date.now()}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.appendFileSync(logPath, `${worker}:end:${Date.now()}\n`);
  });
}

if (process.argv[2] === "--lock-worker") {
  await lockWorker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux repo [test] "));
  const root = path.join(temp, "main repo");
  const linked = path.join(temp, "linked ; repo");
  const nested = path.join(root, "packages", "nested repo");
  try {
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    git(temp, ["init", "-q", root]);
    git(root, ["config", "user.name", "Git Test"]);
    git(root, ["config", "user.email", "git@example.invalid"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "base"]);

    const identity = await resolveGitRepository(path.join(root, "src", "deep"));
    assert.equal(identity.root, fs.realpathSync(root));
    assert.equal(identity.sourceRelativePath, "src/deep");
    assert.equal(identity.baseCommit, git(root, ["rev-parse", "HEAD"]));
    assert.equal(identity.commonDir, fs.realpathSync(path.join(root, ".git")));

    fs.mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q"]);
    git(nested, ["config", "user.name", "Git Test"]);
    git(nested, ["config", "user.email", "git@example.invalid"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "nested\n");
    git(nested, ["add", "nested.txt"]);
    git(nested, ["commit", "-qm", "nested"]);
    const nestedIdentity = await resolveGitRepository(nested);
    assert.equal(nestedIdentity.root, fs.realpathSync(nested), "nearest nested repository must win");

    git(root, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
    const linkedIdentity = await resolveGitRepository(linked);
    assert.equal(linkedIdentity.root, fs.realpathSync(linked));
    assert.equal(linkedIdentity.commonDir, identity.commonDir, "linked worktrees must share a queue/lock key");
    assert.equal(linkedIdentity.baseCommit, identity.baseCommit);

    const repository = await GitRepository.open(path.join(root, "src"), { instanceId: "repository-test" });
    const revision = await repository.run(["rev-parse", "HEAD"]);
    assert.equal(revision.stdout.trim(), identity.baseCommit);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = runInGitQueue(identity.commonDir, undefined, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const second = runInGitQueue(linkedIdentity.commonDir, undefined, async () => { order.push("second"); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);

    const held = await acquireGitLock({ commonDir: identity.commonDir, operation: "held", instanceId: "owner" });
    const waitingController = new AbortController();
    const waiting = acquireGitLock({
      commonDir: identity.commonDir,
      operation: "waiting",
      signal: waitingController.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => waitingController.abort(new Error("cancel lock wait")), 30);
    await assert.rejects(waiting, (error) => error instanceof GitLockError && error.code === "GIT_LOCK_ABORTED");
    await held.release();

    const stalePath = path.join(identity.commonDir, GIT_LOCK_DIRECTORY_NAME);
    fs.mkdirSync(stalePath);
    const staleOwnerPath = path.join(stalePath, "owner-00000000-0000-0000-0000-000000000000.json");
    fs.writeFileSync(staleOwnerPath, JSON.stringify({
      ownerToken: "00000000-0000-0000-0000-000000000000",
      instanceId: "dead-owner",
      pid: 2_147_483_647,
      startMarker: "old",
      processIdentity: "missing-process",
      createdAt: new Date(0).toISOString(),
      operation: "crashed",
    }));
    const reclaimed = await acquireGitLock({ commonDir: identity.commonDir, operation: "reclaim" });
    assert.equal(fs.existsSync(staleOwnerPath), false);
    assert.notEqual(reclaimed.metadata.instanceId, "dead-owner");
    const staleTombstone = `${stalePath}.stale-00000000-0000-0000-0000-000000000000`;
    assert.equal(fs.existsSync(staleTombstone), true, "stale generation tombstone must remain as an ABA guard");
    assert.throws(() => fs.renameSync(stalePath, staleTombstone), /exist|empty|directory/i);
    assert.equal(fs.existsSync(stalePath), true, "failed delayed reclaim must not move the new canonical owner");
    assert.equal(await reclaimed.release(), true);

    const logPath = path.join(temp, "workers.log");
    const runWorker = (name: string): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, scriptPath, "--lock-worker", identity.commonDir, logPath, name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`worker ${name} failed (${code}): ${stderr}`)));
    });
    await Promise.all([runWorker("A"), runWorker("B")]);
    const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => line.split(":"));
    assert.equal(entries.length, 4);
    assert.equal(entries[0][1], "start");
    assert.equal(entries[1][0], entries[0][0]);
    assert.equal(entries[1][1], "end");
    assert.equal(entries[2][1], "start");
    assert.equal(entries[3][0], entries[2][0]);
    assert.equal(entries[3][1], "end", "cross-process critical sections must not overlap");

    console.log("git repository tests passed");
  } finally {
    try { git(root, ["worktree", "remove", "--force", linked]); } catch { /* already absent */ }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
