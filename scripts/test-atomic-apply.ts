import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicApply, type AtomicApplyFaults, type AtomicApplyResult } from "../lib/parallel-agent/atomic-apply.ts";
import { MAX_WORKTREE_PATCH_BYTES } from "../lib/parallel-agent/worktree-manifest.ts";

interface TestWorker {
  id: string;
  path: string;
  patchPath: string;
  changedFiles: string[];
}

interface Fixture {
  root: string;
  repo: string;
  runDir: string;
  manifestPath: string;
  base: string;
  workers: TestWorker[];
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim();
}

function gitBuffer(cwd: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 });
}

function write(root: string, relative: string, contents: string | Buffer): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function status(repo: string): string {
  return git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function manifest(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>;
}

function writeManifest(fixture: Fixture, workers: TestWorker[]): void {
  const now = new Date().toISOString();
  fs.writeFileSync(fixture.manifestPath, `${JSON.stringify({
    version: 1,
    runId: `run-${randomUUID()}`,
    instanceId: "atomic-apply-test",
    ownerPid: process.pid,
    processStartIdentity: "atomic-process",
    heartbeatAt: now,
    activeOperation: "running",
    repoRoot: fs.realpathSync(fixture.repo),
    gitCommonDir: fs.realpathSync(git(fixture.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    sourceCwdRelative: ".",
    baseCommit: fixture.base,
    state: "captured",
    workers: workers.map((worker, index) => {
      const patch = fs.readFileSync(worker.patchPath);
      return {
        workerId: worker.id,
        displayName: worker.id,
        index,
        worktreePath: worker.path,
        agentCwd: worker.path,
        branch: `test-${index}`,
        provider: "test",
        state: "captured",
        capture: {
          changed: patch.length > 0,
          workerBranch: `test-${index}`,
          workerHead: git(worker.path, ["rev-parse", "HEAD"]),
          patchPath: worker.patchPath,
          patchSha256: createHash("sha256").update(patch).digest("hex"),
          patchBytes: patch.length,
          changedFiles: worker.changedFiles,
          binaryFiles: [],
          capturedAt: now,
          captureError: null,
        },
        cleanup: null,
      };
    }),
    apply: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }, null, 2)}\n`);
}

function createFixture(changes: Array<(worker: string) => void>, names?: string[][]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-atomic-test-"));
  const repo = path.join(root, "main repo");
  const runDir = path.join(root, "run");
  fs.mkdirSync(repo);
  fs.mkdirSync(runDir);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Atomic Apply Test"]);
  git(repo, ["config", "user.email", "atomic@example.invalid"]);
  write(repo, "one.txt", "one base\nshared base\n");
  write(repo, "two.txt", "two base\n");
  write(repo, "rename.txt", "rename base\n");
  write(repo, "delete.txt", "delete base\n");
  write(repo, "hunks.txt", Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join(""));
  write(repo, "binary.bin", Buffer.from([0, 1, 2, 3, 255]));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const workers = changes.map((change, index) => {
    const worker = path.join(root, `worker ${index}`);
    git(repo, ["worktree", "add", "-q", "--detach", worker, base]);
    change(worker);
    git(worker, ["add", "-A"]);
    const patchPath = path.join(runDir, `worker-${index}.patch`);
    fs.writeFileSync(patchPath, gitBuffer(worker, ["diff", "--cached", "--binary", "--full-index", base]));
    const changedFiles = names?.[index] ?? gitBuffer(worker, ["diff", "--cached", "--name-only", "-z", base])
      .toString("utf8").split("\0").filter(Boolean);
    return { id: `worker-${index}`, path: worker, patchPath, changedFiles };
  });
  const fixture = { root, repo, runDir, manifestPath: path.join(runDir, "worktree-manifest.json"), base, workers };
  writeManifest(fixture, workers);
  return fixture;
}

function dispose(fixture: Fixture): void {
  for (const worker of fixture.workers) {
    try { git(fixture.repo, ["worktree", "remove", "--force", worker.path]); } catch { /* test cleanup */ }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

async function apply(fixture: Fixture, workerIds = fixture.workers.map((worker) => worker.id), options: {
  files?: string[];
  transactionId?: string;
  idempotencyKey?: string;
  faults?: AtomicApplyFaults;
} = {}): Promise<AtomicApplyResult> {
  return atomicApply({
    manifestPath: fixture.manifestPath,
    targetCwd: fixture.repo,
    workerIds,
    ...options,
  });
}

async function withFixture(changes: Array<(worker: string) => void>, test: (fixture: Fixture) => Promise<void>, names?: string[][]): Promise<void> {
  const fixture = createFixture(changes, names);
  try { await test(fixture); } finally { dispose(fixture); }
}

await withFixture([
  (worker) => write(worker, "one.txt", "one from worker zero\nshared base\n"),
  (worker) => write(worker, "two.txt", "two from worker one\n"),
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "applied", result.error ?? undefined);
  assert.equal(result.success, true);
  assert.deepEqual(result.workerIds, ["worker-0", "worker-1"]);
  assert.deepEqual(result.files, ["one.txt", "two.txt"]);
  assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "one from worker zero\nshared base\n");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "two.txt"), "utf8"), "two from worker one\n");
  assert.equal((manifest(fixture).apply as { outcome: string }).outcome, "applied");

  const repeated = await apply(fixture, undefined, { transactionId: result.transactionId });
  assert.equal(repeated.outcome, "applied");
  assert.deepEqual(repeated.files, result.files);

  // Historical replay must remain valid after the user commits and keeps editing.
  git(fixture.repo, ["commit", "-qm", "accept applied artifacts"]);
  write(fixture.repo, "one.txt", "later user edit\n");
  const historical = await apply(fixture, undefined, { transactionId: result.transactionId });
  assert.equal(historical.outcome, "applied");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "later user edit\n");
});

await withFixture([
  (worker) => write(worker, "one.txt", "conflicting zero\nshared base\n"),
  (worker) => write(worker, "one.txt", "conflicting one\nshared base\n"),
], async (fixture) => {
  const before = status(fixture.repo);
  const result = await apply(fixture);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.errorCode, "APPLY_WORKER_CONFLICT");
  assert.equal(status(fixture.repo), before);
  assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "one base\nshared base\n");
});

await withFixture([
  (worker) => write(worker, "hunks.txt", Array.from({ length: 20 }, (_, index) => `${index === 0 ? "first hunk" : `line ${index}`}\n`).join("")),
  (worker) => write(worker, "hunks.txt", Array.from({ length: 20 }, (_, index) => `${index === 19 ? "second hunk" : `line ${index}`}\n`).join("")),
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "applied", result.error ?? undefined);
  const merged = fs.readFileSync(path.join(fixture.repo, "hunks.txt"), "utf8");
  assert.equal(merged.startsWith("first hunk\n"), true);
  assert.equal(merged.endsWith("second hunk\n"), true);
});

await withFixture([
  (worker) => fs.renameSync(path.join(worker, "rename.txt"), path.join(worker, "renamed.txt")),
  (worker) => write(worker, "rename.txt", "worker modifies renamed source\n"),
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "conflict");
  assert.equal(status(fixture.repo), "");
});

await withFixture([
  (worker) => fs.unlinkSync(path.join(worker, "delete.txt")),
  (worker) => write(worker, "delete.txt", "worker modifies deleted file\n"),
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "conflict");
  assert.equal(status(fixture.repo), "");
});

await withFixture([
  (worker) => {
    fs.renameSync(path.join(worker, "rename.txt"), path.join(worker, "renamed.txt"));
    fs.unlinkSync(path.join(worker, "delete.txt"));
  },
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "applied", result.error ?? undefined);
  assert.equal(fs.existsSync(path.join(fixture.repo, "rename.txt")), false);
  assert.equal(fs.readFileSync(path.join(fixture.repo, "renamed.txt"), "utf8"), "rename base\n");
  assert.equal(fs.existsSync(path.join(fixture.repo, "delete.txt")), false);
});

const binary = randomBytes(16 * 1024);
await withFixture([
  (worker) => write(worker, "binary.bin", binary),
  (worker) => write(worker, "two.txt", "binary companion text\n"),
], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "applied", result.error ?? undefined);
  assert.deepEqual(fs.readFileSync(path.join(fixture.repo, "binary.bin")), binary);
  assert.equal(fs.readFileSync(path.join(fixture.repo, "two.txt"), "utf8"), "binary companion text\n");
});

await withFixture([
  (worker) => {
    write(worker, "one.txt", "selected file\n");
    write(worker, "two.txt", "unselected file\n");
  },
], async (fixture) => {
  const result = await apply(fixture, undefined, { files: ["one.txt"] });
  assert.equal(result.outcome, "applied", result.error ?? undefined);
  assert.deepEqual(result.files, ["one.txt"]);
  assert.equal(fs.readFileSync(path.join(fixture.repo, "two.txt"), "utf8"), "two base\n");
});

const invalidCases: Array<{ workerIds?: string[]; files?: string[]; code: string; outcome?: string }> = [
  { workerIds: [], code: "APPLY_WORKERS_EMPTY" },
  { workerIds: ["worker-0", "worker-0"], code: "APPLY_WORKER_DUPLICATE" },
  { workerIds: ["unknown"], code: "APPLY_WORKER_UNKNOWN" },
  { files: [], code: "APPLY_NO_CHANGES_SELECTED", outcome: "no_changes" },
  { files: ["unknown.txt"], code: "APPLY_FILE_UNKNOWN" },
  { files: ["one.txt", "one.txt"], code: "APPLY_FILE_DUPLICATE" },
  { files: ["../outside"], code: "APPLY_FILE_OUTSIDE_REPOSITORY" },
  { files: [path.resolve("outside")], code: "APPLY_FILE_INVALID" },
  { files: ["C:\\outside.txt"], code: "APPLY_FILE_INVALID" },
];
for (const testCase of invalidCases) {
  await withFixture([(worker) => write(worker, "one.txt", "changed\n")], async (fixture) => {
    const result = await apply(fixture, testCase.workerIds ?? ["worker-0"], { files: testCase.files });
    assert.equal(result.outcome, testCase.outcome ?? "precondition_failed");
    assert.equal(result.errorCode, testCase.code);
    assert.equal(status(fixture.repo), "");
  });
}

await withFixture([
  (worker) => write(worker, "one.txt", "order zero\n"),
  (worker) => write(worker, "two.txt", "order one\n"),
], async (fixture) => {
  const result = await apply(fixture, ["worker-1", "worker-0"]);
  assert.equal(result.errorCode, "APPLY_WORKER_ORDER_INVALID");
  assert.equal(status(fixture.repo), "");
});

await withFixture([(worker) => write(worker, "one.txt", "digest\n")], async (fixture) => {
  fs.appendFileSync(fixture.workers[0].patchPath, "tampered");
  const result = await apply(fixture);
  assert.equal(result.errorCode, "APPLY_ARTIFACT_DIGEST_MISMATCH");
  assert.equal(status(fixture.repo), "");
});

await withFixture([(worker) => write(worker, "one.txt", "not captured\n")], async (fixture) => {
  const value = manifest(fixture) as { workers: Array<{ state: string }> };
  value.workers[0].state = "running";
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(value));
  const result = await apply(fixture);
  assert.equal(result.errorCode, "APPLY_WORKER_NOT_CAPTURED");
  assert.equal(status(fixture.repo), "");
});

await withFixture([() => {}], async (fixture) => {
  const result = await apply(fixture);
  assert.equal(result.outcome, "no_changes");
  assert.equal(result.errorCode, "APPLY_NO_CHANGES");
  assert.equal(status(fixture.repo), "");
});

await withFixture([(worker) => write(worker, "one.txt", "dirty check\n")], async (fixture) => {
  write(fixture.repo, "local.txt", "local user data\n");
  const result = await apply(fixture);
  assert.equal(result.errorCode, "APPLY_REPOSITORY_DIRTY");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "local.txt"), "utf8"), "local user data\n");
});

await withFixture([(worker) => write(worker, "one.txt", "concurrent\n")], async (fixture) => {
  const transactionId = randomUUID();
  const idempotencyKey = randomUUID();
  const results = await Promise.all([
    apply(fixture, undefined, { transactionId, idempotencyKey }),
    apply(fixture, undefined, { transactionId, idempotencyKey }),
  ]);
  assert.equal(results.every((entry) => entry.outcome === "applied"), true, JSON.stringify(results));
  assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "concurrent\n");
});

for (const faultPhase of ["Prepared", "Checked"] as const) {
  await withFixture([(worker) => write(worker, "one.txt", `${faultPhase}\n`)], async (fixture) => {
    const transactionId = randomUUID();
    const idempotencyKey = randomUUID();
    const faults: AtomicApplyFaults = { [`after${faultPhase}`]: () => { throw new Error(`crash ${faultPhase}`); } };
    const result = await apply(fixture, undefined, { transactionId, idempotencyKey, faults });
    assert.equal(result.outcome, "error");
    assert.equal(status(fixture.repo), "");
    const retry = await apply(fixture, undefined, { transactionId, idempotencyKey });
    assert.equal(retry.outcome, "applied", retry.error ?? undefined);
  });
}

await withFixture([(worker) => write(worker, "one.txt", "applied crash\n")], async (fixture) => {
  const transactionId = randomUUID();
  const idempotencyKey = randomUUID();
  const result = await apply(fixture, undefined, { transactionId, idempotencyKey, faults: { afterApplied() { throw new Error("crash applied"); } } });
  assert.equal(result.outcome, "recovery_required");
  assert.equal(status(fixture.repo).length > 0, true);
  assert.equal(fs.existsSync(result.journalPath!), true);
  const retry = await apply(fixture, undefined, { transactionId, idempotencyKey });
  assert.equal(retry.outcome, "applied", retry.error ?? undefined);
  assert.equal(retry.phase, "persisted");
});

await withFixture([(worker) => write(worker, "one.txt", "real process crash\n")], async (fixture) => {
  const transactionId = randomUUID();
  const moduleUrl = new URL("../lib/parallel-agent/atomic-apply.ts", import.meta.url).href;
  const childSource = `
    import { atomicApply } from ${JSON.stringify(moduleUrl)};
    await atomicApply({
      manifestPath: ${JSON.stringify(fixture.manifestPath)},
      targetCwd: ${JSON.stringify(fixture.repo)},
      workerIds: ["worker-0"],
      transactionId: ${JSON.stringify(transactionId)},
      idempotencyKey: ${JSON.stringify(transactionId)},
      staleLockMs: 1,
      faults: { afterApplied() { process.exit(23); } },
    });
  `;
  // Its intentional crash bypasses Apply scratch cleanup; keep that scratch
  // inside the already registered fixture, not the caller's tmp directory.
  const childTemporary = fs.mkdtempSync(path.join(fixture.root, "crash-tmp-"));
  const crashed = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource], {
    encoding: "utf8", env: { ...process.env, TMPDIR: childTemporary, TMP: childTemporary, TEMP: childTemporary },
  });
  assert.equal(crashed.status, 23, crashed.stderr);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = await atomicApply({
    manifestPath: fixture.manifestPath,
    targetCwd: fixture.repo,
    workerIds: ["worker-0"],
    transactionId,
    idempotencyKey: transactionId,
    staleLockMs: 1,
  });
  assert.equal(recovered.outcome, "applied", recovered.error ?? undefined);
  assert.equal(recovered.phase, "persisted");
  assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "real process crash\n");
});

await withFixture([(worker) => write(worker, "one.txt", "persisted crash\n")], async (fixture) => {
  const transactionId = randomUUID();
  const idempotencyKey = randomUUID();
  const result = await apply(fixture, undefined, {
    transactionId,
    idempotencyKey,
    faults: { afterPersisted() { throw new Error("crash persisted"); } },
  });
  assert.equal(result.outcome, "recovery_required");
  const retry = await apply(fixture, undefined, { transactionId, idempotencyKey });
  assert.equal(retry.outcome, "applied");
  assert.equal(retry.phase, "persisted");
});

// Different runs share the repository lock. Exactly one can satisfy the clean-repository precondition.
const first = createFixture([(worker) => write(worker, "one.txt", "first run\n")]);
try {
  const secondRun = path.join(first.root, "second-run");
  fs.mkdirSync(secondRun);
  const second: Fixture = {
    ...first,
    runDir: secondRun,
    manifestPath: path.join(secondRun, "worktree-manifest.json"),
  };
  const secondWorkerPath = path.join(first.root, "second worker");
  git(first.repo, ["worktree", "add", "-q", "--detach", secondWorkerPath, first.base]);
  write(secondWorkerPath, "two.txt", "second run\n");
  git(secondWorkerPath, ["add", "-A"]);
  const secondPatch = path.join(secondRun, "worker.patch");
  fs.writeFileSync(secondPatch, gitBuffer(secondWorkerPath, ["diff", "--cached", "--binary", "--full-index", first.base]));
  second.workers = [{ id: "second-worker", path: secondWorkerPath, patchPath: secondPatch, changedFiles: ["two.txt"] }];
  writeManifest(second, second.workers);
  try {
    const results = await Promise.all([apply(first), apply(second)]);
    assert.equal(results.filter((entry) => entry.outcome === "applied").length, 1, JSON.stringify(results));
    assert.equal(results.filter((entry) => entry.outcome === "precondition_failed").length, 1, JSON.stringify(results));
  } finally {
    try { git(first.repo, ["worktree", "remove", "--force", secondWorkerPath]); } catch { /* test cleanup */ }
  }
} finally {
  dispose(first);
}

await withFixture([(worker) => write(worker, "one.txt", "recovery write failure\n")], async (fixture) => {
  const transactionId = randomUUID();
  const first = await apply(fixture, undefined, {
    transactionId,
    faults: { afterApplied() { throw new Error("initial post-apply crash"); } },
  });
  assert.equal(first.outcome, "recovery_required");
  assert.equal(manifest(fixture).state, "applying");
  const originalRename = fs.renameSync;
  fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[1]).endsWith("atomic-apply-transaction.json")
      && JSON.parse(fs.readFileSync(args[0], "utf8")).phase === "persisted") {
      throw new Error("injected recovery journal persistence failure");
    }
    return originalRename(...args);
  };
  try {
    const failedRecovery = await apply(fixture, undefined, { transactionId });
    assert.equal(failedRecovery.outcome, "recovery_required");
    assert.equal(manifest(fixture).state, "applied");
    const failedAgain = await apply(fixture, undefined, { transactionId });
    assert.equal(failedAgain.outcome, "recovery_required");
  } finally {
    fs.renameSync = originalRename;
  }
  const finalRecovery = await apply(fixture, undefined, { transactionId });
  assert.equal(finalRecovery.outcome, "applied");
});

for (const modifyAfterFailure of [false, true]) {
  await withFixture([(worker) => write(worker, "one.txt", "journal persistence window\n")], async (fixture) => {
    const transactionId = randomUUID();
    const originalRename = fs.renameSync;
    fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]).endsWith("atomic-apply-transaction.json")
        && JSON.parse(fs.readFileSync(args[0], "utf8")).phase === "persisted") {
        throw new Error("injected final journal persistence failure");
      }
      return originalRename(...args);
    };
    let firstResult: AtomicApplyResult;
    try { firstResult = await apply(fixture, undefined, { transactionId }); }
    finally { fs.renameSync = originalRename; }
    assert.equal(firstResult.outcome, "recovery_required");
    assert.equal(manifest(fixture).state, "applied");
    assert.equal(JSON.parse(fs.readFileSync(firstResult.journalPath!, "utf8")).phase, "applied");
    if (modifyAfterFailure) write(fixture.repo, "one.txt", "unverified later user edit\n");
    const retry = await apply(fixture, undefined, { transactionId });
    if (modifyAfterFailure) {
      assert.equal(retry.outcome, "recovery_required");
      assert.equal(fs.readFileSync(path.join(fixture.repo, "one.txt"), "utf8"), "unverified later user edit\n");
      assert.equal(JSON.parse(fs.readFileSync(firstResult.journalPath!, "utf8")).phase, "applied");
    } else {
      assert.equal(retry.outcome, "applied", JSON.stringify(retry));
      assert.equal(JSON.parse(fs.readFileSync(firstResult.journalPath!, "utf8")).phase, "persisted");
    }
  });
}

await withFixture([(worker) => write(worker, "one.txt", "oversized captured artifact\n")], async (fixture) => {
  const fd = fs.openSync(fixture.workers[0].patchPath, "r+");
  try { fs.ftruncateSync(fd, MAX_WORKTREE_PATCH_BYTES + 1); } finally { fs.closeSync(fd); }
  const oversized = await apply(fixture);
  assert.equal(oversized.errorCode, "APPLY_ARTIFACT_DIGEST_MISMATCH");
  assert.equal(status(fixture.repo), "");
});

await withFixture([(worker) => write(worker, "one.txt", "asynchronous artifact\n")], async (fixture) => {
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === "string" && args[0].endsWith(".patch")) throw new Error("Synchronous patch read is forbidden");
    return Reflect.apply(originalRead, fs, args);
  }) as typeof fs.readFileSync;
  let initial: AtomicApplyResult;
  try {
    initial = await apply(fixture);
    assert.equal(initial.outcome, "applied", JSON.stringify(initial));
    const replay = await apply(fixture, undefined, { transactionId: initial.transactionId });
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
  } finally {
    fs.readFileSync = originalRead;
  }
  const journal = JSON.parse(fs.readFileSync(initial.journalPath!, "utf8"));
  const fd = fs.openSync(journal.patchPath, "r+");
  try { fs.ftruncateSync(fd, MAX_WORKTREE_PATCH_BYTES + 1); } finally { fs.closeSync(fd); }
  const oversizedHistory = await apply(fixture, undefined, { transactionId: initial.transactionId });
  assert.equal(oversizedHistory.outcome, "recovery_required");
  assert.equal(oversizedHistory.errorCode, "APPLY_HISTORY_UNVERIFIED");
});

console.log("atomic apply tests passed");
