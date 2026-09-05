import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { POST } from "../app/api/agent-runs/[runId]/apply/route.ts";
import { applyCollaborationPatches } from "../lib/parallel-agent/collaboration-orchestrator.ts";
import { atomicApply } from "../lib/parallel-agent/atomic-apply.ts";
import {
  createCollaborationRun,
  getCollaborationRun,
  removeCollaborationRun,
} from "../lib/parallel-agent/collaboration-store.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import { writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";
import { getIsolatedRunDir } from "../lib/parallel-agent/worktree.ts";

const now = "2026-01-01T00:00:00.000Z";

function runState(runId: string, overrides: Partial<CollaborationRunState> = {}): CollaborationRunState {
  return {
    runId,
    version: 0,
    cwd: process.cwd(),
    message: "apply contract test",
    mode: "isolated_coding",
    status: "complete",
    workers: [{
      workerId: `${runId}_worker_1`,
      name: "worker",
      task: "task",
      status: "complete",
    }],
    events: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function post(runId: string, body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ runId }) });
}

const routeRunId = `apply_route_${randomUUID()}`;
createCollaborationRun(runState(routeRunId, { status: "running" }));
try {
  const precondition = await post(routeRunId, { workerIds: [`${routeRunId}_worker_1`] });
  assert.equal(precondition.status, 412);
  assert.equal((await precondition.json()).code, "APPLY_RUN_NOT_READY");

  const nullKey = await post(routeRunId, { workerIds: [`${routeRunId}_worker_1`], idempotencyKey: null });
  assert.equal(nullKey.status, 400);
  assert.equal((await nullKey.json()).code, "APPLY_IDEMPOTENCY_INVALID");

  // Git permits repository-relative names with leading/trailing spaces. Schema validation
  // must let atomicApply classify the path instead of rejecting it as malformed JSON input.
  const whitespaceFile = await post(routeRunId, {
    workerIds: [`${routeRunId}_worker_1`],
    files: [" leading-and-trailing.txt "],
  });
  assert.equal(whitespaceFile.status, 412);
  assert.equal((await whitespaceFile.json()).code, "APPLY_RUN_NOT_READY");
} finally {
  await removeCollaborationRun(routeRunId);
}

const replayRunId = `apply_replay_${randomUUID()}`;
const replayRoot = getIsolatedRunDir(replayRunId);
fs.mkdirSync(replayRoot, { recursive: true, mode: 0o700 });
const replayRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-apply-api-")));
execFileSync("git", ["init", "-q"], { cwd: replayRepo });
execFileSync("git", ["config", "user.email", "apply-test@example.com"], { cwd: replayRepo });
execFileSync("git", ["config", "user.name", "Apply Test"], { cwd: replayRepo });
fs.writeFileSync(path.join(replayRepo, "result.txt"), "base\n");
execFileSync("git", ["add", "result.txt"], { cwd: replayRepo });
execFileSync("git", ["commit", "-qm", "base fixture"], { cwd: replayRepo });
const replayWorkerId = `${replayRunId}_worker_1`;
const transactionId = `tx_${randomUUID()}`;
const manifestPath = path.join(replayRoot, "worktree-manifest.json");
const replayHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: replayRepo, encoding: "utf8" }).trim();
fs.writeFileSync(path.join(replayRepo, "result.txt"), "applied\n");
const workerPatch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD"], { cwd: replayRepo });
fs.writeFileSync(path.join(replayRoot, "worker.patch"), workerPatch);
fs.writeFileSync(path.join(replayRepo, "result.txt"), "base\n");
const capturedManifest: WorktreeManifestV1 = {
  version: 1,
  runId: replayRunId,
  instanceId: "apply-contract-test",
  ownerPid: process.pid,
  processStartIdentity: "apply-contract-test",
  heartbeatAt: now,
  activeOperation: null,
  repoRoot: replayRepo,
  gitCommonDir: path.join(replayRepo, ".git"),
  sourceCwdRelative: ".",
  baseCommit: replayHead,
  state: "captured",
  workers: [{
    workerId: replayWorkerId,
    displayName: "worker",
    index: 0,
    worktreePath: replayRepo,
    agentCwd: replayRepo,
    branch: "codex/test",
    provider: "test",
    state: "captured",
    capture: {
      changed: true,
      workerBranch: "codex/test",
      workerHead: replayHead,
      patchPath: path.join(replayRoot, "worker.patch"),
      patchSha256: createHash("sha256").update(workerPatch).digest("hex"),
      patchBytes: workerPatch.length,
      changedFiles: ["result.txt"],
      binaryFiles: [],
      capturedAt: now,
      captureError: null,
    },
    cleanup: null,
  }],
  apply: null,
  createdAt: now,
  updatedAt: now,
  expiresAt: "2026-01-02T00:00:00.000Z",
};
writeWorktreeManifestAtomic(manifestPath, capturedManifest);

createCollaborationRun(runState(replayRunId, {
  cwd: replayRepo,
  worktreeManifestPath: manifestPath,
  workers: [{ workerId: replayWorkerId, name: "worker", task: "task", status: "complete" }],
}));
// A real Git apply succeeds, but its final journal write fails. HTTP must not report
// success just because the independently persisted manifest already says applied.
const originalRename = fs.renameSync;
fs.renameSync = (...args: Parameters<typeof fs.renameSync>) => {
  if (String(args[1]) === path.join(replayRoot, "atomic-apply-transaction.json")
    && JSON.parse(fs.readFileSync(args[0], "utf8")).phase === "persisted") {
    throw new Error("injected final journal persistence failure");
  }
  return originalRename(...args);
};
try {
  const response = await post(replayRunId, { workerIds: [replayWorkerId], idempotencyKey: transactionId });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).outcome, "recovery_required");
  assert.equal(getCollaborationRun(replayRunId)?.status, "recoverable");
  assert.equal(fs.readFileSync(path.join(replayRepo, "result.txt"), "utf8"), "applied\n");
} finally {
  fs.renameSync = originalRename;
}

const verifiedHistory = await atomicApply({
  manifestPath,
  targetCwd: replayRepo,
  workerIds: [replayWorkerId],
  transactionId,
  idempotencyKey: transactionId,
});
assert.equal(verifiedHistory.outcome, "applied");
execFileSync("git", ["commit", "-qm", "accept worker changes"], { cwd: replayRepo });
fs.writeFileSync(path.join(replayRepo, "result.txt"), "later user edit\n");

const differentKey = await atomicApply({
  manifestPath,
  targetCwd: replayRepo,
  workerIds: [replayWorkerId],
  transactionId: `different_${randomUUID()}`,
  idempotencyKey: `different_${randomUUID()}`,
});
assert.equal(differentKey.errorCode, "APPLY_ALREADY_APPLIED");
const differentPayload = await atomicApply({
  manifestPath,
  targetCwd: replayRepo,
  workerIds: [replayWorkerId],
  files: ["result.txt"],
  transactionId,
  idempotencyKey: transactionId,
});
assert.equal(differentPayload.errorCode, "APPLY_IDEMPOTENCY_MISMATCH");

const journalPath = path.join(replayRoot, "atomic-apply-transaction.json");
const savedJournal = fs.readFileSync(journalPath);
fs.rmSync(journalPath);
const missingHistory = await atomicApply({
  manifestPath,
  targetCwd: replayRepo,
  workerIds: [replayWorkerId],
  transactionId,
  idempotencyKey: transactionId,
});
assert.equal(missingHistory.outcome, "recovery_required");
assert.equal(missingHistory.errorCode, "APPLY_HISTORY_UNVERIFIED");
fs.writeFileSync(journalPath, savedJournal);

const nonGitTarget = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-non-git-"));
try {
  const nonGitIdentity = await atomicApply({
    manifestPath,
    targetCwd: nonGitTarget,
    workerIds: [replayWorkerId],
    transactionId,
    idempotencyKey: transactionId,
  });
  assert.equal(nonGitIdentity.errorCode, "APPLY_REPOSITORY_MISMATCH");
} finally {
  fs.rmSync(nonGitTarget, { recursive: true, force: true });
}

const foreignRepo = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-foreign-repo-"));
execFileSync("git", ["init", "-q"], { cwd: foreignRepo });
try {
  const foreignIdentity = await atomicApply({
    manifestPath,
    targetCwd: foreignRepo,
    workerIds: [replayWorkerId],
    transactionId,
    idempotencyKey: transactionId,
  });
  assert.equal(foreignIdentity.errorCode, "APPLY_REPOSITORY_MISMATCH");
  const savedManifest = fs.readFileSync(manifestPath, "utf8");
  try {
    writeWorktreeManifestAtomic(manifestPath, {
      ...JSON.parse(savedManifest),
      gitCommonDir: path.join(foreignRepo, ".git"),
    });
    const wrongCommonDir = await atomicApply({
      manifestPath,
      targetCwd: replayRepo,
      workerIds: [replayWorkerId],
      transactionId,
      idempotencyKey: transactionId,
    });
    assert.equal(wrongCommonDir.errorCode, "APPLY_REPOSITORY_MISMATCH");
  } finally {
    fs.writeFileSync(manifestPath, savedManifest);
  }
} finally {
  fs.rmSync(foreignRepo, { recursive: true, force: true });
}
createCollaborationRun(runState(replayRunId, {
  cwd: replayRepo,
  status: "applying",
  applyState: "applying",
  applyTransactionId: transactionId,
  applyStartedAt: now,
  worktreeManifestPath: manifestPath,
  workers: [{ workerId: replayWorkerId, name: "worker", task: "task", status: "complete" }],
}));

const mutableFs = fs as unknown as { appendFileSync: (...args: unknown[]) => unknown };
const originalAppendFileSync = mutableFs.appendFileSync;
try {
  mutableFs.appendFileSync = (...args: unknown[]) => {
    const payload = String(args[1] ?? "");
    if (payload.includes(replayRunId)) throw new Error("injected task-state persistence failure");
    return Reflect.apply(originalAppendFileSync, fs, args);
  };
  const failedPersistence = await applyCollaborationPatches(replayRunId, [replayWorkerId], undefined, transactionId);
  assert.equal(failedPersistence.outcome, "recovery_required", JSON.stringify(failedPersistence));
  assert.equal(failedPersistence.errorCode, "APPLY_STATE_PERSISTENCE_FAILED");
  assert.equal(getCollaborationRun(replayRunId)?.status, "applying");

  mutableFs.appendFileSync = originalAppendFileSync;
  const replayed = await applyCollaborationPatches(replayRunId, [replayWorkerId], undefined, transactionId);
  assert.equal(replayed.outcome, "applied");
  assert.equal(replayed.transactionId, transactionId);
  assert.deepEqual(replayed.workerIds, [replayWorkerId]);
  assert.deepEqual(replayed.files, ["result.txt"]);
  assert.equal(getCollaborationRun(replayRunId)?.status, "applied");
  assert.equal(getCollaborationRun(replayRunId)?.applyState, "applied");
  assert.equal(fs.readFileSync(path.join(replayRepo, "result.txt"), "utf8"), "later user edit\n");
} finally {
  mutableFs.appendFileSync = originalAppendFileSync;
  await removeCollaborationRun(replayRunId);
  fs.rmSync(replayRoot, { recursive: true, force: true });
  fs.rmSync(replayRepo, { recursive: true, force: true });
}

console.log("apply store/API contract tests passed");
