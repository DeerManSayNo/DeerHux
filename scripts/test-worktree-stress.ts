import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitRepository } from "../lib/parallel-agent/git-repository.ts";
import { atomicApply } from "../lib/parallel-agent/atomic-apply.ts";
import { createWorktreeGitFixture, disposeWorktreeGitFixtures, fileDigest, type FixtureRun, type WorktreeGitFixture } from "./fixtures/worktree-git-fixture.ts";

const MiB = 1024 * 1024;
const options = { runs: 0, durationHours: 0, enduranceWorkers: 1, large: false, help: false };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--large") options.large = true;
  else if (arg === "--help") options.help = true;
  else if (arg === "--runs" || arg === "--duration-hours" || arg === "--endurance-workers") {
    const value = Number(process.argv[++index]);
    assert.ok(Number.isFinite(value) && value > 0 && (arg !== "--runs" || Number.isInteger(value)), "invalid bounded duration/run argument");
    if (arg === "--endurance-workers") { assert.ok(Number.isInteger(value) && value <= 5); options.enduranceWorkers = value; }
    else if (arg === "--runs") { assert.ok(value <= 1_000_000); options.runs = value; }
    else { assert.ok(value <= 168); options.durationHours = value; }
  } else throw new Error("Unknown stress option; use --help");
}
if (options.help) {
  console.log("Usage: node --experimental-strip-types --import ./scripts/register-typescript-test-loader.mjs scripts/test-worktree-stress.ts [--large] [--runs 1000] [--duration-hours 24] [--endurance-workers 1..5]\nDefault smoke: same-repository 6 Runs x 5 Workers, then six repositories x 5 Workers.\n--large adds one Run with five binary patches totaling at least 100 MiB, then atomic Apply (requires >=2 GiB free).\n--runs adds exactly N endurance Runs in batches <=6, with 1 Worker per Run by default (--endurance-workers can raise this to 5).\n--duration-hours adds endurance until deadline. If both run/time limits are set, stop at the first limit.\nNo model calls, network, automation, or global runs-directory scans. Git critical sections serialize within each repository.\nMemory metrics are this Node process only; child-Git aggregate peak is not measured. Ctrl-C stops after the active batch and exact fixture cleanup.");
} else {
  const memoryStart = process.memoryUsage().rss;
  let sampledPeakRss = memoryStart;
  const memoryTimer = setInterval(() => { sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); }, 50);
  memoryTimer.unref();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let waits = { count: 0, totalMs: 0, maxMs: 0 };
  let heldByRepository = new Map<string, number>();
  let peakConcurrentCriticalSections = 0;
  const originalLock = GitRepository.prototype.withWriteLock;
  GitRepository.prototype.withWriteLock = function<T>(lockOptions: Parameters<typeof originalLock>[0], operation: () => Promise<T>): Promise<T> {
    const requested = performance.now();
    const common = this.commonDir;
    return originalLock.call(this, lockOptions, async () => {
      const delay = performance.now() - requested;
      waits.count++; waits.totalMs += delay; waits.maxMs = Math.max(waits.maxMs, delay);
      assert.equal(heldByRepository.get(common) ?? 0, 0, "same-repository Git critical sections must not overlap");
      heldByRepository.set(common, 1); peakConcurrentCriticalSections = Math.max(peakConcurrentCriticalSections, heldByRepository.size);
      try { return await operation(); } finally { heldByRepository.delete(common); }
    }) as Promise<T>;
  };
  const summaries: object[] = [];
  let actualEnduranceRuns = 0;
  let actualEnduranceMs = 0;
  function resetMetrics() { waits = { count: 0, totalMs: 0, maxMs: 0 }; heldByRepository = new Map(); peakConcurrentCriticalSections = 0; }
  async function batch(fixtures: WorktreeGitFixture[], runCount: number, workersPerRun = 5): Promise<{ patches: number; patchBytes: number; peakExistingWorkers: number }> {
    const pending = Array.from({ length: runCount }, (_, index) => {
      const fixture = fixtures[index % fixtures.length];
      return fixture.setupRun(workersPerRun, { nested: index % 2 === 1 }).then((run) => ({ fixture, run }));
    });
    const created = await Promise.allSettled(pending);
    const failure = created.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const active = created.map((result) => (result as PromiseFulfilledResult<{ fixture: WorktreeGitFixture; run: FixtureRun }>).value);
    assert.equal(active.reduce((total, { run }) => total + run.worktrees.size, 0), runCount * workersPerRun);
    for (const fixture of fixtures) {
      const belonging = active.filter((item) => item.fixture === fixture);
      const list = fixture.worktreeList();
      assert.equal(list.split("\n").filter((line) => line.startsWith("worktree ")).length, 1 + belonging.length * workersPerRun);
      for (const { run } of belonging) for (const worker of fixture.manifest(run).workers) {
        assert.equal(fixture.git(fixture.repoRoot, ["rev-parse", worker.branch]), fixture.baseCommit);
        assert.equal(worker.environment?.mode, "none");
      }
    }
    const captures = active.flatMap(({ fixture, run }) => [...run.worktrees.entries()].map(([workerId, worktree]) => {
      fixture.untracked(worktree, `result-${workerId}.txt`, `${run.runId}:${workerId}\n`);
      return fixture.capture(run, workerId).then((result) => {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(result.capture?.patchPath); assert.equal(fs.statSync(result.capture.patchPath).size, result.capture.patchBytes);
        assert.equal(fileDigest(result.capture.patchPath), result.capture.patchSha256);
        return result.capture.patchBytes ?? 0;
      });
    }));
    const captured = await Promise.allSettled(captures);
    const captureFailure = captured.find((result) => result.status === "rejected");
    if (captureFailure?.status === "rejected") throw captureFailure.reason;
    for (const { fixture, run } of active) {
      fixture.assertNoTemporaryMetadata();
      const manifest = fixture.manifest(run);
      assert.ok(manifest.workers.every((worker) => worker.capture?.captureError === null));
      // Retained captures and worktrees are intentional production behavior.
      // Only after validating them does this private fixture reclaim its outputs.
      for (const workerPath of run.worktrees.values()) assert.equal(fs.existsSync(workerPath), true);
      fixture.cleanupRun(run.runId);
    }
    for (const fixture of fixtures) fixture.assertSettled();
    return { patches: captured.length, patchBytes: captured.reduce((total, result) => total + (result as PromiseFulfilledResult<number>).value, 0), peakExistingWorkers: runCount * workersPerRun };
  }
  async function smoke(mode: "same_repository" | "multiple_repositories") {
    const fixtures = Array.from({ length: mode === "same_repository" ? 1 : 6 }, () => createWorktreeGitFixture());
    resetMetrics(); const began = performance.now();
    try {
      const result = await batch(fixtures, 6);
      assert.equal(peakConcurrentCriticalSections >= (mode === "same_repository" ? 1 : 2), true);
      const summary = { mode, runs: 6, workersPerRun: 5, repositories: fixtures.length, ...result, durationMs: performance.now() - began,
        lockWait: { ...waits }, peakConcurrentCriticalSections, rssAfterCleanup: process.memoryUsage().rss };
      summaries.push(summary); console.log(JSON.stringify(summary));
    } finally { disposeWorktreeGitFixtures(fixtures); }
  }
  async function large() {
    const free = fs.statfsSync(os.tmpdir()); const availableBytes = free.bavail * free.bsize;
    assert.ok(availableBytes >= 2 * 1024 * MiB, "--large requires at least 2 GiB free temporary-disk space");
    const fixture = createWorktreeGitFixture(); const expected = new Map<string, string>();
    resetMetrics(); const began = performance.now();
    try {
      const run = await fixture.setupRun(5); const chunk = Buffer.allocUnsafe(MiB);
      for (const [workerId, worktree] of run.worktrees) {
        const relative = `large-${workerId}.bin`; const file = fixture.binary(worktree, relative, Buffer.alloc(0));
        const fd = fs.openSync(file, "w");
        try { for (let index = 0; index < 17; index++) { randomFillSync(chunk); fs.writeSync(fd, chunk); } }
        finally { fs.closeSync(fd); }
        expected.set(relative, fileDigest(file));
      }
      const pending = await Promise.allSettled(run.workerIds.map((workerId) => fixture.capture(run, workerId)));
      for (const result of pending) { assert.equal(result.status, "fulfilled"); if (result.status === "fulfilled") assert.equal(result.value.ok, true, JSON.stringify(result.value)); }
      const patchBytes = fixture.manifest(run).workers.reduce((sum, worker) => sum + (worker.capture?.patchBytes ?? 0), 0);
      assert.ok(patchBytes >= 100 * MiB, "large capture must actually persist at least 100 MiB of patches");
      fixture.assertNoTemporaryMetadata(); const captureMs = performance.now() - began; const applyStart = performance.now();
      const applied = await atomicApply({ manifestPath: run.manifestPath, targetCwd: fixture.repoRoot, workerIds: run.workerIds, idempotencyKey: `stress-${run.runId}` });
      assert.equal(applied.outcome, "applied", JSON.stringify(applied));
      assert.equal(applied.success, true); assert.deepEqual([...applied.files].sort(), [...expected.keys()].sort());
      for (const [relative, digest] of expected) assert.equal(fileDigest(path.join(fixture.repoRoot, relative)), digest);
      fixture.cleanupRun(run.runId); fixture.assertSettled(false);
      const summary = { mode: "large_patch_capture_apply", runs: 1, workers: 5, availableDiskBytesBefore: availableBytes, patchBytes,
        captureMs, applyMs: performance.now() - applyStart, durationMs: performance.now() - began, setupCaptureLockWait: { ...waits }, rssAfterCleanup: process.memoryUsage().rss };
      summaries.push(summary); console.log(JSON.stringify(summary));
    } finally { fixture.dispose(); }
  }
  async function endurance() {
    const fixture = createWorktreeGitFixture(); const began = performance.now(); const rssBaseline = process.memoryUsage().rss;
    const initialObjects = fixture.objectStats();
    const limit = options.runs || Number.POSITIVE_INFINITY;
    const deadline = options.durationHours ? Date.now() + options.durationHours * 3_600_000 : Number.POSITIVE_INFINITY;
    let completedRuns = 0; let completedPatches = 0; let maxPostCleanupRss = rssBaseline;
    resetMetrics();
    try {
      while (!stopped && completedRuns < limit && Date.now() < deadline) {
        const count = Math.min(6, limit - completedRuns);
        const result = await batch([fixture], count, options.enduranceWorkers); completedRuns += count; completedPatches += result.patches;
        maxPostCleanupRss = Math.max(maxPostCleanupRss, process.memoryUsage().rss);
        assert.ok(process.memoryUsage().rss <= rssBaseline + 512 * MiB, "post-cleanup Node RSS grew beyond the 512 MiB endurance safety budget");
        if (completedRuns % 60 === 0) console.log(JSON.stringify({ mode: "endurance_progress", completedRuns, elapsedMs: performance.now() - began, rss: process.memoryUsage().rss }));
      }
      fixture.assertSettled();
      actualEnduranceRuns = completedRuns;
      actualEnduranceMs = performance.now() - began;
      const summary = { mode: "endurance", completedRuns, workersPerRun: options.enduranceWorkers, completedWorkers: completedRuns * options.enduranceWorkers, completedPatches, durationMs: performance.now() - began,
        requestedRuns: options.runs || null, requestedDurationHours: options.durationHours || null, interrupted: stopped,
        lockWait: { ...waits }, rssBaseline, maxPostCleanupRss, rssGrowthBytes: process.memoryUsage().rss - rssBaseline,
        initialGitObjects: initialObjects, finalGitObjects: fixture.objectStats(), gitObjectRetentionExpected: true };
      summaries.push(summary); console.log(JSON.stringify(summary));
    } finally { fixture.dispose(); }
  }
  try {
    await smoke("same_repository"); if (!stopped) await smoke("multiple_repositories");
    if (options.large && !stopped) await large();
    if ((options.runs || options.durationHours) && !stopped) await endurance();
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
    console.log(JSON.stringify({ result: "passed", actualScenarios: summaries.length, nodeRssStart: memoryStart, nodeSampledPeakRss: sampledPeakRss,
      nodeLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024, childGitPeakMeasured: false, durability1000RunsExecuted: actualEnduranceRuns >= 1000,
      full24HoursExecuted: actualEnduranceMs >= 24 * 3_600_000, note: "Only actual summaries are evidence; supported endurance flags are not completed acceptance." }));
  } finally {
    GitRepository.prototype.withWriteLock = originalLock; clearInterval(memoryTimer); process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}
