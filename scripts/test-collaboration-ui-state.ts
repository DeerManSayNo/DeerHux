import assert from "node:assert/strict";
import { collaborationNeedsHydration, isCollaborationSnapshotOlder, mergeCollaborationMuxSnapshot } from "../lib/collaboration-ui-state.ts";
import type { CollaborationRunSnapshot } from "../lib/parallel-agent/collaboration-types.ts";
import type { CollaborationMuxSnapshot } from "../lib/parallel-agent/collaboration-mux.ts";

const digest = "a".repeat(64);
const run: CollaborationRunSnapshot = {
  runId: "run", version: 7, mode: "isolated_coding", status: "complete", message: "task",
  captureState: "captured", applyState: "idle", canContinue: true,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
  workers: [{ workerId: "worker-1", name: "Duplicate", task: "one", status: "complete", patchSha256: digest, changedFiles: ["a.txt"], sessionId: "private", worktreePath: "/private/path" },
    { workerId: "worker-2", name: "Duplicate", task: "two", status: "complete" }],
};
const mux: CollaborationMuxSnapshot = {
  authoritative: true, runId: run.runId, version: 7, status: "complete", captureState: "captured", applyState: "idle", canContinue: true,
  updatedAt: run.updatedAt,
  workers: [{ workerId: "worker-1", name: "Duplicate", status: "complete", patchSha256: digest, changedFileCount: 1, sessionReady: true },
    { workerId: "worker-2", name: "Duplicate", status: "complete", sessionReady: true }],
};
assert.equal(collaborationNeedsHydration(run, mux), false, "sessionReady never causes a hydration loop for a private Session ID");
assert.equal(isCollaborationSnapshotOlder({ version: 6, updatedAt: "2099" }, run), true, "version wins over clocks");
assert.equal(mergeCollaborationMuxSnapshot(run, { ...mux, version: 6, updatedAt: "2099" }), run);
const merged = mergeCollaborationMuxSnapshot(run, { ...mux, version: 8, status: "recoverable", recoveryState: "manual_recovery_required", canContinue: false });
assert.equal(merged.version, 8);
assert.equal(merged.recoveryState, "manual_recovery_required");
assert.equal(merged.canContinue, false);
assert.deepEqual(merged.workers.map((worker) => worker.task), ["one", "two"], "duplicate labels never merge Worker identities");
assert.equal(merged.workers[0].sessionId, undefined);
assert.equal(merged.workers[0].worktreePath, undefined);

const changed: CollaborationMuxSnapshot = { ...mux, workers: [{ ...mux.workers[0], patchSha256: "b".repeat(64) }, mux.workers[1]] };
assert.equal(collaborationNeedsHydration(run, changed), true, "cold recovery may change artifacts without increasing the stored revision");
const stale = mergeCollaborationMuxSnapshot(run, changed);
assert.equal(stale.workers[0].patchSha256, undefined);
assert.equal(stale.workers[0].changedFiles, undefined, "old files cannot be selected under the new digest");
assert.equal(collaborationNeedsHydration(stale, changed), true, "failed detail requests remain retryable on subsequent Mux events");
const refreshed = { ...run, workers: [{ ...run.workers[0], patchSha256: "b".repeat(64) }, run.workers[1]] };
assert.equal(collaborationNeedsHydration(refreshed, changed), false);
assert.deepEqual(mergeCollaborationMuxSnapshot(run, { ...mux, workers: [] }).workers, []);
const cleared = mergeCollaborationMuxSnapshot(merged, { ...mux, version: 9 });
assert.equal(cleared.recoveryState, undefined, "absent authoritative fields clear stale recovery banners");
console.log("collaboration UI state tests passed");
