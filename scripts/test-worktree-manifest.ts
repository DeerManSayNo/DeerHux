import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  manifestDeletionEligibility,
  MAX_WORKTREE_MANIFEST_BYTES,
  readWorktreeManifestDigest,
  readWorktreeManifest,
  transitionWorktreeManifest,
  validateWorktreeManifest,
  worktreeDeletionEligibility,
  writeWorktreeManifestAtomic,
  type ManifestWriteFaults,
  type WorktreeManifestV1,
} from "../lib/parallel-agent/worktree-manifest.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";

function makeManifest(root: string): WorktreeManifestV1 {
  const workerRoot = path.join(root, "worker-0");
  return {
    version: 1,
    runId: "run-1",
    instanceId: "instance-1",
    ownerPid: process.pid,
    processStartIdentity: "process-start-1",
    heartbeatAt: T0,
    activeOperation: "setup",
    repoRoot: path.join(root, "repo"),
    gitCommonDir: path.join(root, "repo", ".git"),
    sourceCwdRelative: "packages/app",
    baseCommit: "a".repeat(40),
    state: "planning",
    workers: [{
      workerId: "worker-1",
      displayName: "Worker One",
      index: 0,
      worktreePath: workerRoot,
      agentCwd: path.join(workerRoot, "packages", "app"),
      branch: "deerhux/run-1/0-worker-1",
      provider: "openai",
      state: "planned",
      capture: null,
      cleanup: null,
    }],
    apply: null,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: EXPIRES,
  };
}

function clone(value: WorktreeManifestV1): WorktreeManifestV1 {
  return structuredClone(value);
}

function throwingFault(point: keyof ManifestWriteFaults): ManifestWriteFaults {
  return { [point]: () => { throw new Error(`injected ${point}`); } };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-manifest-"));
try {
  const manifestPath = path.join(root, "manifest.json");
  const original = makeManifest(root);
  assert.equal(validateWorktreeManifest(original).ok, true, "pre-rollout format-v1 manifests remain readable without rewriting");
  assert.equal(validateWorktreeManifest({ ...original, implementationVersion: 2 }).ok, true);
  for (const unsupported of [0, 1, 3, "2", null]) {
    assert.equal(validateWorktreeManifest({ ...original, implementationVersion: unsupported }).ok, false, "unsupported implementation must not fall back to legacy");
  }

  assert.deepEqual(readWorktreeManifest(path.join(root, "missing.json")), { kind: "missing" });
  writeWorktreeManifestAtomic(manifestPath, original);
  assert.deepEqual(readWorktreeManifest(manifestPath), { kind: "ok", manifest: original });
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600, "manifest must be mode 0600");
  assert.equal(fs.readdirSync(root).filter((name) => name.includes(".tmp-")).length, 0, "temp files must be removed");

  const setup = transitionWorktreeManifest(original, "setting_up", { caller: "setup", now: T1 });
  assert.equal(setup.state, "setting_up");
  assert.equal(setup.updatedAt, T1);
  assert.throws(
    () => transitionWorktreeManifest(original, "applied", { caller: "apply", now: T1 }),
    /Illegal manifest transition/,
  );
  assert.throws(
    () => transitionWorktreeManifest({ ...original, state: "running" }, "discarded", {
      caller: "cleanup",
      now: T1,
      explicitDiscardConfirmed: true,
      workersTerminated: true,
    }),
    /Illegal manifest transition/,
  );
  const captured = clone(original);
  captured.state = "captured";
  captured.workers[0].state = "captured";
  captured.workers[0].capture = {
    changed: true,
    workerBranch: "deerhux/run-1/0-worker-1",
    workerHead: "a".repeat(40),
    patchPath: path.join(root, "captured.patch"),
    patchSha256: "c".repeat(64),
    patchBytes: 1,
    changedFiles: ["packages/app/index.ts"],
    binaryFiles: [],
    capturedAt: T1,
    captureError: null,
  };
  assert.equal(validateWorktreeManifest(captured).ok, true, "old captures without fileChanges remain valid");
  const withMetadata = clone(captured);
  withMetadata.workers[0].capture!.fileChanges = [{ path: "packages/app/index.ts", previousPath: null, changeKind: "modified", binary: false,
    oldBytes: 2, newBytes: 3, addedLines: 1, deletedLines: 1 }];
  assert.equal(validateWorktreeManifest(withMetadata).ok, true);
  for (const invalidChange of [{ oldBytes: -1 }, { newBytes: Infinity }, { path: "/private/secret" }, { previousPath: "../../secret", changeKind: "renamed" },
    { changeKind: "deleted", newBytes: 3 }, { binary: true }, { extra: "private" }]) {
    const invalid = clone(withMetadata); Object.assign(invalid.workers[0].capture!.fileChanges![0], invalidChange);
    assert.equal(validateWorktreeManifest(invalid).ok, false, JSON.stringify(invalidChange));
  }
  assert.throws(
    () => transitionWorktreeManifest(captured, "discarded", {
      caller: "cleanup",
      now: T1,
      explicitDiscardConfirmed: true,
      workersTerminated: true,
    }),
    /verified patch and persisted manifest/,
  );
  assert.equal(transitionWorktreeManifest(captured, "discarded", {
    caller: "cleanup",
    now: T1,
    explicitDiscardConfirmed: true,
    workersTerminated: true,
    patchVerified: true,
    manifestPersisted: true,
  }).state, "discarded");

  const malformedPath = path.join(root, "malformed.json");
  fs.writeFileSync(malformedPath, "{not json", { mode: 0o600 });
  assert.equal(readWorktreeManifest(malformedPath).kind, "invalid");
  const oldPath = path.join(root, "old.json");
  fs.writeFileSync(oldPath, JSON.stringify({ ...original, version: 0 }), { mode: 0o600 });
  assert.equal(readWorktreeManifest(oldPath).kind, "invalid");

  const schemaCases: Array<[string, WorktreeManifestV1]> = [];
  schemaCases.push(["relative repoRoot", { ...original, repoRoot: "repo" }]);
  schemaCases.push(["non-canonical timestamp", { ...original, updatedAt: "2026-01-01" }]);
  schemaCases.push(["unknown state", { ...original, state: "unknown" as WorktreeManifestV1["state"] }]);
  const duplicateId = clone(original);
  duplicateId.workers.push({ ...duplicateId.workers[0], index: 1 });
  schemaCases.push(["duplicate worker ID", duplicateId]);
  const duplicateIndex = clone(original);
  duplicateIndex.workers.push({ ...duplicateIndex.workers[0], workerId: "worker-2" });
  schemaCases.push(["duplicate worker index", duplicateIndex]);
  const unordered = clone(original);
  unordered.workers[0].index = 1;
  schemaCases.push(["non-contiguous worker index", unordered]);
  for (const [name, candidate] of schemaCases) {
    assert.equal(validateWorktreeManifest(candidate).ok, false, name);
  }

  const updated = { ...original, state: "setting_up" as const, updatedAt: T1 };
  const oldBytes = fs.readFileSync(manifestPath);
  for (const point of ["beforeWrite", "afterWrite", "beforeRename", "afterRename"] as const) {
    assert.throws(() => writeWorktreeManifestAtomic(manifestPath, updated, throwingFault(point)), new RegExp(point));
    assert.deepEqual(fs.readFileSync(manifestPath), oldBytes, `${point} must preserve the old manifest`);
    assert.equal(fs.readdirSync(root).filter((name) => name.includes(".tmp-") || name.includes(".rollback-")).length, 0);
  }
  writeWorktreeManifestAtomic(manifestPath, updated);
  assert.deepEqual(readWorktreeManifest(manifestPath), { kind: "ok", manifest: updated });

  const complete = clone(original);
  complete.state = "applied";
  complete.updatedAt = T2;
  complete.workers[0].state = "removed";
  complete.workers[0].capture = {
    changed: true,
    workerBranch: "deerhux/run-1/0-worker-1",
    workerHead: "a".repeat(40),
    patchPath: path.join(root, "worker-1.patch"),
    patchSha256: "b".repeat(64),
    patchBytes: 42,
    changedFiles: ["packages/app/index.ts", "assets/logo.bin"],
    binaryFiles: ["assets/logo.bin"],
    capturedAt: T1,
    captureError: null,
  };
  complete.workers[0].cleanup = {
    intent: "post_apply",
    eligibility: "eligible",
    checkedAt: T2,
    worktreeRemoved: true,
    branchRemoved: true,
    reason: "apply_settled",
  };
  complete.apply = {
    transactionId: "transaction-1",
    requestedWorkerIds: ["worker-1"],
    requestedFiles: ["packages/app/index.ts", "assets/logo.bin"],
    appliedFiles: ["packages/app/index.ts", "assets/logo.bin"],
    startedAt: T1,
    finishedAt: T2,
    outcome: "applied",
    errorCode: null,
  };
  const completePath = path.join(root, "complete.json");
  writeWorktreeManifestAtomic(completePath, complete);
  assert.deepEqual(readWorktreeManifest(completePath), { kind: "ok", manifest: complete });

  const symlinkTarget = path.join(root, "real-parent");
  const symlinkParent = path.join(root, "linked-parent");
  fs.mkdirSync(symlinkTarget);
  fs.symlinkSync(symlinkTarget, symlinkParent, "dir");
  const linkedManifest = path.join(symlinkParent, "manifest.json");
  assert.throws(() => writeWorktreeManifestAtomic(linkedManifest, original), /symlink parent/);
  assert.equal(readWorktreeManifest(linkedManifest).kind, "invalid");
  assert.equal(fs.existsSync(path.join(symlinkTarget, "manifest.json")), false);

  const targetFile = path.join(root, "target.json");
  const symlinkFile = path.join(root, "symlink.json");
  fs.writeFileSync(targetFile, "safe", { mode: 0o600 });
  fs.symlinkSync(targetFile, symlinkFile);
  assert.throws(() => writeWorktreeManifestAtomic(symlinkFile, original), /symlink manifest path/);
  assert.equal(readWorktreeManifest(symlinkFile).kind, "invalid");
  assert.equal(fs.readFileSync(targetFile, "utf8"), "safe");

  const oversized = path.join(root, "oversized.json");
  const oversizedFd = fs.openSync(oversized, "wx", 0o600);
  fs.ftruncateSync(oversizedFd, MAX_WORKTREE_MANIFEST_BYTES + 1);
  fs.closeSync(oversizedFd);
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => { reads++; return originalRead(...args); }) as typeof fs.readSync;
  try {
    assert.equal(readWorktreeManifest(oversized).kind, "invalid");
    assert.equal(readWorktreeManifestDigest(oversized), null);
    assert.equal(reads, 0, "oversized files must be rejected before reading");
  } finally { fs.readSync = originalRead; }
  const oversizedManifest = clone(original);
  oversizedManifest.workers[0].displayName = "x".repeat(MAX_WORKTREE_MANIFEST_BYTES);
  assert.throws(() => writeWorktreeManifestAtomic(manifestPath, oversizedManifest), /too large/);
  assert.deepEqual(readWorktreeManifest(manifestPath), { kind: "ok", manifest: updated });
  fs.chmodSync(manifestPath, 0o644);
  assert.equal(readWorktreeManifest(manifestPath).kind, "invalid");
  assert.equal(readWorktreeManifestDigest(manifestPath), null);
  fs.chmodSync(manifestPath, 0o600);
  const originalUid = process.getuid;
  if (originalUid) {
    process.getuid = () => originalUid() + 1;
    try { assert.equal(readWorktreeManifest(manifestPath).kind, "invalid"); }
    finally { process.getuid = originalUid; }
  }
  const ancestorTarget = path.join(root, "ancestor-target");
  fs.mkdirSync(path.join(ancestorTarget, "child"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(ancestorTarget, path.join(root, "ancestor-link"));
  assert.equal(readWorktreeManifest(path.join(root, "ancestor-link", "child", "manifest.json")).kind, "invalid");
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    if (!swapped && args[0] === manifestPath) {
      swapped = true;
      fs.renameSync(manifestPath, `${manifestPath}.previous`);
      fs.writeFileSync(manifestPath, JSON.stringify(original), { mode: 0o600 });
    }
    return fd;
  }) as typeof fs.openSync;
  try { assert.equal(readWorktreeManifest(manifestPath).kind, "invalid", "replacement after open must not be accepted"); }
  finally { fs.openSync = originalOpen; }

  const notDirectory = path.join(root, "not-a-directory");
  fs.writeFileSync(notDirectory, "file", { mode: 0o600 });
  assert.equal(readWorktreeManifest(path.join(notDirectory, "manifest.json")).kind, "io_error");

  assert.deepEqual(manifestDeletionEligibility({ kind: "missing" }), { eligible: false, reason: "manifest_missing" });
  assert.equal(manifestDeletionEligibility({ kind: "invalid", error: "bad" }).eligible, false);
  assert.equal(manifestDeletionEligibility({ kind: "ok", manifest: original }).eligible, false);
  assert.equal(worktreeDeletionEligibility({ kind: "missing" }, "worker-1").eligible, false);
  const authorized = clone(complete);
  authorized.workers[0].state = "stopped";
  authorized.workers[0].cleanup!.worktreeRemoved = false;
  authorized.workers[0].cleanup!.branchRemoved = false;
  assert.deepEqual(worktreeDeletionEligibility({ kind: "ok", manifest: authorized }, "worker-1"), {
    eligible: true,
    reason: "cleanup_authorized",
  });
  assert.equal(worktreeDeletionEligibility({ kind: "ok", manifest: authorized }, "unknown").eligible, false);
  assert.deepEqual(
    manifestDeletionEligibility({ kind: "ok", manifest: { ...complete, version: 2 } as unknown as WorktreeManifestV1 }),
    { eligible: false, reason: "manifest_invalid" },
  );
  const removable = clone(complete);
  assert.deepEqual(manifestDeletionEligibility({ kind: "ok", manifest: removable }), {
    eligible: true,
    reason: "all_resources_settled",
  });
  removable.workers[0].cleanup!.branchRemoved = false;
  assert.equal(manifestDeletionEligibility({ kind: "ok", manifest: removable }).eligible, false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("worktree manifest tests passed");
