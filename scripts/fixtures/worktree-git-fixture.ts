import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setupIsolatedWorkspace, getIsolatedRunDir, getIsolatedRunsRoot } from "../../lib/parallel-agent/worktree.ts";
import { captureWorktreeArtifact, type CaptureWorktreeArtifactOptions } from "../../lib/parallel-agent/worktree-artifacts.ts";
import { readWorktreeManifest } from "../../lib/parallel-agent/worktree-manifest.ts";

export interface FixtureFaults {
  beforeGit?: (cwd: string, args: readonly string[]) => void;
  beforeFileWrite?: (absolutePath: string) => void;
  beforeManifestWrite?: (writeIndex: number) => void;
}
export type FixtureRun = Awaited<ReturnType<typeof setupIsolatedWorkspace>> & { runId: string; workerIds: string[] };
interface RegisteredRun { runId: string; runDir: string; workers: Array<{ workerId: string; worktreePath: string; branch: string }> }

/** All destructive fixture cleanup is restricted to this mkdtemp and exact
 * random run/worktree/ref names registered before calling production setup. */
export function createWorktreeGitFixture(faults: FixtureFaults = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-git-fixture-")));
  const rootIdentity = fs.lstatSync(root);
  const repoRoot = path.join(root, "repo");
  const nestedCwd = path.join(repoRoot, "packages", "app");
  const commonDir = path.join(repoRoot, ".git");
  const runs = new Map<string, RegisteredRun>();
  fs.mkdirSync(nestedCwd, { recursive: true, mode: 0o700 });
  const git = (cwd: string, args: readonly string[]): string => {
    faults.beforeGit?.(cwd, args);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) as NodeJS.ProcessEnv;
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.name", "Worktree Fixture"]);
  git(repoRoot, ["config", "user.email", "worktree-fixture@test.invalid"]);
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "tracked baseline\n");
  fs.writeFileSync(path.join(nestedCwd, "baseline.txt"), "nested baseline\n");
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "node_modules/\n");
  git(repoRoot, ["add", "."]); git(repoRoot, ["commit", "-qm", "fixture baseline"]);
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  const baselineRefs = git(repoRoot, ["show-ref"]);
  const baselineBranchNames = git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  const baselineIndex = fs.readFileSync(path.join(commonDir, "index"));
  const baselineTree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);

  function ownedTarget(directory: string, relative: string): string {
    const allowed = directory === repoRoot || directory === nestedCwd
      || [...runs.values()].some((run) => run.workers.some((worker) => worker.worktreePath === directory));
    const target = path.resolve(directory, relative);
    const rel = path.relative(directory, target);
    if (!allowed || !rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw new Error("Fixture write outside owned directory");
    let parent = path.dirname(target);
    while (parent !== directory) {
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error("Fixture write through symlink");
      parent = path.dirname(parent);
    }
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Fixture write through leaf symlink");
    return target;
  }
  function write(directory: string, relative: string, contents: string | Buffer): string {
    const target = ownedTarget(directory, relative);
    faults.beforeFileWrite?.(target); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); return target;
  }
  function runsRoot(): string {
    const configured = getIsolatedRunsRoot();
    if (fs.existsSync(configured)) { assert.equal(fs.lstatSync(configured).isSymbolicLink(), false); return fs.realpathSync(configured); }
    return path.join(fs.realpathSync(path.dirname(configured)), path.basename(configured));
  }
  async function setupRun(workerCount = 5, options: { nested?: boolean; onStep?: NonNullable<Parameters<typeof setupIsolatedWorkspace>[4]>["onStep"] } = {}): Promise<FixtureRun> {
    assert.ok(Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= 5);
    const runId = `stress_${randomUUID().replaceAll("-", "")}`;
    const workerIds = Array.from({ length: workerCount }, (_, index) => `worker_${index + 1}`);
    const runDir = path.join(runsRoot(), runId);
    runs.set(runId, { runId, runDir, workers: workerIds.map((workerId, index) => ({ workerId,
      worktreePath: path.join(runDir, `${index + 1}-${workerId}`), branch: `deerhux/${runId}/${index + 1}-${workerId}` })) });
    const setup = await setupIsolatedWorkspace(options.nested ? nestedCwd : repoRoot, runId, "stress-fixture", workerIds.map((workerId) => ({ workerId, displayName: workerId })), {
      environmentConfig: { mode: "none" }, onStep: options.onStep, onManifestWrite: faults.beforeManifestWrite,
    });
    assert.equal(setup.baseCommit, baseCommit);
    for (const workerPath of setup.worktrees.values()) assert.equal(git(workerPath, ["rev-parse", "HEAD"]), baseCommit);
    return { ...setup, runId, workerIds };
  }
  function assertNoTemporaryMetadata(): void {
    const metadataRoots = [commonDir];
    const worktreesDirectory = path.join(commonDir, "worktrees");
    if (fs.existsSync(worktreesDirectory)) for (const entry of fs.readdirSync(worktreesDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) metadataRoots.push(path.join(worktreesDirectory, entry.name));
    }
    for (const metadata of metadataRoots) {
      const names = fs.readdirSync(metadata);
      assert.deepEqual(names.filter((name) => name.endsWith(".lock") || name.startsWith("deerhux-artifact-index-")
        || name.startsWith("deerhux-capture-index-") || name.startsWith("deerhux-operation.lock")
        || name.startsWith("deerhux-apply-index-")), [], `unexpected temporary metadata: ${metadata}`);
    }
    for (const run of runs.values()) {
      if (!fs.existsSync(run.runDir)) continue;
      assert.deepEqual(fs.readdirSync(run.runDir).filter((name) => name.includes(".tmp-") || name.includes(".rollback-")), []);
      const artifacts = path.join(run.runDir, "artifacts");
      if (fs.existsSync(artifacts)) assert.deepEqual(fs.readdirSync(artifacts).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")), []);
    }
  }
  function cleanupRun(runId: string): void {
    const run = runs.get(runId);
    if (!run) throw new Error("Unknown fixture run");
    assert.equal(path.dirname(run.runDir), runsRoot());
    assert.equal(path.basename(getIsolatedRunDir(runId)), runId);
    assertNoTemporaryMetadata();
    for (const worker of [...run.workers].reverse()) {
      const registered = git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n").includes(`worktree ${worker.worktreePath}`);
      if (registered) git(repoRoot, ["worktree", "remove", "--force", "--", worker.worktreePath]);
      const oid = git(repoRoot, ["for-each-ref", "--format=%(objectname)", `refs/heads/${worker.branch}`]);
      if (oid) git(repoRoot, ["update-ref", "-d", `refs/heads/${worker.branch}`, oid]);
      assert.equal(git(repoRoot, ["for-each-ref", "--format=%(refname)", `refs/heads/${worker.branch}`]), "");
    }
    if (fs.existsSync(run.runDir)) {
      assert.equal(fs.lstatSync(run.runDir).isSymbolicLink(), false);
      fs.rmSync(run.runDir, { recursive: true });
    }
    assert.equal(fs.existsSync(run.runDir), false);
    assert.equal(git(repoRoot, ["worktree", "list", "--porcelain"]).includes(runId), false);
    runs.delete(runId);
    assertNoTemporaryMetadata();
  }
  function assertNoUnexpectedResources(): void {
    const listed = git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "));
    assert.deepEqual(listed, [`worktree ${repoRoot}`], "unexpected fixture worktrees");
    // Callers may intentionally commit/apply on the original main branch. Its
    // OID may change, but an extra branch must never disappear in blanket rm.
    assert.equal(git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/heads"]), baselineBranchNames, "unexpected fixture branches");
    const worktreesDirectory = path.join(commonDir, "worktrees");
    if (fs.existsSync(worktreesDirectory)) assert.deepEqual(fs.readdirSync(worktreesDirectory), [], "unexpected fixture worktree metadata");
    assertNoTemporaryMetadata();
  }
  function assertSettled(expectMainUnchanged = true): void {
    assert.equal(runs.size, 0);
    assertNoUnexpectedResources();
    assert.equal(git(repoRoot, ["show-ref"]), baselineRefs);
    assert.equal(git(repoRoot, ["rev-parse", "HEAD^{tree}"]), baselineTree);
    if (expectMainUnchanged) {
      assert.deepEqual(fs.readFileSync(path.join(commonDir, "index")), baselineIndex);
      assert.equal(git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    }
  }
  function dispose(): void {
    try {
      for (const runId of [...runs.keys()]) cleanupRun(runId);
      assertNoUnexpectedResources();
    }
    finally {
      // A failed leak assertion must not leave this fixture's known run paths
      // behind. These names were registered before setup; no global scan occurs.
      for (const run of runs.values()) {
        assert.equal(path.dirname(run.runDir), runsRoot());
        if (fs.existsSync(run.runDir)) fs.rmSync(run.runDir, { recursive: true });
      }
      const identity = fs.lstatSync(root);
      assert.equal(identity.dev, rootIdentity.dev); assert.equal(identity.ino, rootIdentity.ino);
      assert.equal(identity.isSymbolicLink(), false);
      fs.rmSync(root, { recursive: true });
    }
  }
  return { root, repoRoot, nestedCwd, commonDir, baseCommit, faults, git, write, setupRun, cleanupRun, assertSettled, assertNoTemporaryMetadata, dispose,
    worktreeList: () => git(repoRoot, ["worktree", "list", "--porcelain"]),
    treeDigest: (cwd = repoRoot) => git(cwd, ["rev-parse", "HEAD^{tree}"]),
    objectStats: () => Object.fromEntries(git(repoRoot, ["count-objects", "-v"]).split("\n").filter((line) => /^(count|size|in-pack|size-pack):/.test(line))
      .map((line) => { const [key, value] = line.split(": "); return [key, Number(value)]; })),
    tracked: (cwd: string, text: string) => write(cwd, "tracked.txt", text),
    untracked: (cwd: string, name: string, text: string) => write(cwd, name, text),
    binary: (cwd: string, name: string, bytes: Buffer) => write(cwd, name, bytes),
    rename: (cwd: string, from: string, to: string) => fs.renameSync(ownedTarget(cwd, from), ownedTarget(cwd, to)),
    symlink: (cwd: string, name: string, relativeTarget: string) => { ownedTarget(cwd, relativeTarget); fs.symlinkSync(relativeTarget, ownedTarget(cwd, name)); },
    capture: (run: FixtureRun, workerId: string, options?: CaptureWorktreeArtifactOptions) => captureWorktreeArtifact(run.manifestPath, workerId, options),
    manifest: (run: FixtureRun) => { const result = readWorktreeManifest(run.manifestPath); assert.equal(result.kind, "ok"); if (result.kind !== "ok") throw new Error("Fixture manifest invalid"); return result.manifest; },
  };
}
export type WorktreeGitFixture = ReturnType<typeof createWorktreeGitFixture>;
/** Teardown every owned fixture even when an earlier leak assertion fails. */
export function disposeWorktreeGitFixtures(fixtures: readonly WorktreeGitFixture[]): void {
  const errors: unknown[] = [];
  for (const fixture of fixtures) {
    try { fixture.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Fixture resource teardown failed");
}
export function fileDigest(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try { const hash = createHash("sha256"); const chunk = Buffer.allocUnsafe(1024 * 1024); let count: number;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

// Focused TST-1205 checks only; importing the shared fixture never runs them.
if (process.argv.includes("--self-test") && process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const ordinary = createWorktreeGitFixture();
  try {
    const run = await ordinary.setupRun(1);
    ordinary.untracked(run.worktrees.get(run.workerIds[0])!, "result.txt", "fixture result\n");
    assert.equal((await ordinary.capture(run, run.workerIds[0])).ok, true);
    ordinary.tracked(ordinary.repoRoot, "intentional main branch commit\n");
    ordinary.git(ordinary.repoRoot, ["add", "tracked.txt"]);
    ordinary.git(ordinary.repoRoot, ["commit", "-qm", "intentional test action"]);
  } finally { ordinary.dispose(); }
  assert.equal(fs.existsSync(ordinary.root), false);
  for (const kind of ["branch", "worktree", "metadata", "lock", "capture-index", "worker-capture-index"] as const) {
    const fixture = createWorktreeGitFixture();
    if (kind === "branch") fixture.git(fixture.repoRoot, ["branch", "unexpected-fixture-branch"]);
    if (kind === "worktree") fixture.git(fixture.repoRoot, ["worktree", "add", "-b", "unexpected-fixture-worker", path.join(fixture.root, "extra-worker"), "HEAD"]);
    if (kind === "metadata") fs.mkdirSync(path.join(fixture.commonDir, "worktrees", "unlisted-metadata"), { recursive: true });
    if (kind === "lock") fs.mkdirSync(path.join(fixture.commonDir, "deerhux-operation.lock"));
    if (kind === "capture-index") fs.writeFileSync(path.join(fixture.commonDir, "deerhux-capture-index-unexpected"), "unfinished capture index");
    if (kind === "worker-capture-index") {
      const run = await fixture.setupRun(1);
      const worker = run.worktrees.get(run.workerIds[0])!;
      const metadata = fixture.git(worker, ["rev-parse", "--absolute-git-dir"]);
      const index = path.join(metadata, "deerhux-capture-index-unexpected");
      fs.writeFileSync(index, "unfinished worker capture index");
      assert.throws(() => fixture.cleanupRun(run.runId), /unexpected temporary metadata/i,
        "registered worker capture index must be rejected before worktree removal");
      assert.equal(fs.existsSync(index), true);
      assert.equal(fs.existsSync(worker), true);
    }
    assert.throws(() => fixture.dispose(), /unexpected/i, `${kind} leak must fail before fixture deletion hides it`);
    assert.equal(fs.existsSync(fixture.root), false, "a leak assertion still reclaims only its exact private fixture");
  }
  const first = createWorktreeGitFixture(); const second = createWorktreeGitFixture();
  first.git(first.repoRoot, ["branch", "unexpected-fixture-branch"]);
  assert.throws(() => disposeWorktreeGitFixtures([first, second]), AggregateError);
  assert.equal(fs.existsSync(first.root), false); assert.equal(fs.existsSync(second.root), false);
  console.log("TST-1205 shared fixture exit assertions passed (unexpected branch/worktree/metadata/lock, common+worker capture index, complete multi-fixture teardown)");
}
