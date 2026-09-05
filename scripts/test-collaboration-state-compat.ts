import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import { normalizePersistedState } from "../lib/parallel-agent/subagent-persistence.ts";
import { snapshotRun } from "../lib/parallel-agent/collaboration-orchestrator.ts";
import { sanitizeCollaborationRun } from "../lib/parallel-agent/collaboration-sanitize.ts";
import { writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const legacy = {
  runId: "legacy_run",
  cwd: "/tmp/repo",
  message: "legacy",
  mode: "isolated_coding",
  status: "complete",
  workers: [
    { name: "first", task: "one", status: "complete" },
    { name: "second", task: "two", status: "complete", dependsOn: ["first"] },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as CollaborationRunState;

const normalized = normalizePersistedState(legacy);
assert.deepEqual(normalized.events, []);
assert.equal(normalized.workflow, "parallel");
assert.equal(normalized.workers[0]?.workerId, "legacy_run_legacy_worker_1");
assert.deepEqual(normalized.workers[1]?.dependsOn, ["legacy_run_legacy_worker_1"]);
assert.equal(normalized.recoveryState, "legacy_recovery_required");
assert.equal(normalized.canContinue, false);

normalized.baseCommit = "a".repeat(40);
normalized.captureState = "preserved";
normalized.applyState = "idle";
normalized.workers[0].sessionId = "secret-session";
normalized.workers[0].worktreePath = "/secret/worktree";
const snapshot = snapshotRun(normalized);
assert.equal(snapshot.baseCommit, normalized.baseCommit);
assert.equal(snapshot.captureState, "preserved");
assert.equal(snapshot.applyState, "idle");
assert.equal(snapshot.recoveryState, "legacy_recovery_required");
assert.equal(snapshot.workers[0]?.sessionId, undefined);
assert.equal(snapshot.workers[0]?.worktreePath, undefined);
normalized.events = [{ type: "worker_diff_ready", runId: normalized.runId, diff: "secret patch" }];
(normalized.workers[0] as typeof normalized.workers[0] & { patchPath?: string }).patchPath = "/secret/patch";
const sanitized = sanitizeCollaborationRun(normalized);
assert.equal(sanitized.workers[0]?.sessionId, undefined);
assert.equal(sanitized.workers[0]?.worktreePath, undefined);
assert.equal(sanitized.workers[0]?.diff, undefined);
assert.equal(sanitized.events?.[0]?.diff, undefined);
assert.equal("patchPath" in sanitized.workers[0], false);

const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-capture-recovery-"));
try {
  const manifestPath = path.join(recoveryRoot, "manifest.json");
  const capturedManifest: WorktreeManifestV1 = {
    version: 1,
    runId: "captured_run",
    instanceId: "instance",
    ownerPid: process.pid,
    processStartIdentity: "capture-process",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    activeOperation: null,
    repoRoot: path.join(recoveryRoot, "repo"),
    gitCommonDir: path.join(recoveryRoot, "repo", ".git"),
    sourceCwdRelative: ".",
    baseCommit: "a".repeat(40),
    state: "captured",
    workers: [{
      workerId: "captured_worker",
      displayName: "Captured Worker",
      index: 0,
      worktreePath: path.join(recoveryRoot, "worker"),
      agentCwd: path.join(recoveryRoot, "worker"),
      branch: "deerhux/captured/worker",
      provider: "test",
      state: "captured",
      capture: {
        changed: true,
        workerBranch: "deerhux/captured/worker",
        workerHead: "b".repeat(40),
        patchPath: path.join(recoveryRoot, "artifact.patch"),
        patchSha256: "c".repeat(64),
        patchBytes: 42,
        changedFiles: ["file.txt"],
        binaryFiles: [],
        capturedAt: "2026-01-01T00:01:00.000Z",
        captureError: null,
      },
      cleanup: null,
    }],
    apply: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
  };
  writeWorktreeManifestAtomic(manifestPath, capturedManifest);
  const recovered = normalizePersistedState({
    ...structuredClone(legacy),
    runId: "captured_run",
    status: "running",
    worktreeManifestPath: manifestPath,
    recoveryState: undefined,
    workers: [{ name: "Captured Worker", task: "task", workerId: "captured_worker", status: "complete" }],
  });
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.baseCommit, capturedManifest.baseCommit);
  assert.equal(recovered.captureState, "captured");
  assert.equal(recovered.workers[0].patchSha256, "c".repeat(64));
  assert.equal(recovered.workers[0].patchBytes, 42);
  assert.deepEqual(recovered.workers[0].changedFiles, ["file.txt"]);
  assert.deepEqual(recovered.workers[0].binaryFiles, []);
} finally {
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
}

console.log("collaboration state compatibility tests passed");
