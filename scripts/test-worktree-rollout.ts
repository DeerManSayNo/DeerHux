import assert from "node:assert/strict";
import { getWorktreeRollout, getWorktreeRunCapabilities } from "../lib/parallel-agent/worktree-rollout.ts";
import { sanitizeCollaborationRun } from "../lib/parallel-agent/collaboration-sanitize.ts";
import { toCollaborationMuxSnapshot } from "../lib/parallel-agent/collaboration-mux.ts";
import { mergeCollaborationMuxSnapshot } from "../lib/collaboration-ui-state.ts";
import { getRunCapabilities } from "../lib/subagent-review-client.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";

assert.deepEqual(getWorktreeRollout({}), { implementationVersion: 2, newRunsEnabled: false, newApplyEnabled: true, legacyMutationEnabled: false });
for (const value of ["", "0", "false", "TRUE", "yes", "garbage"]) assert.equal(getWorktreeRollout({ SUBAGENT_WORKTREE_V2: value }).newRunsEnabled, false);
for (const value of ["1", "true"]) assert.equal(getWorktreeRollout({ SUBAGENT_WORKTREE_V2: value }).newRunsEnabled, true);
for (const value of ["0", "false", "garbage"]) assert.equal(getWorktreeRollout({ SUBAGENT_WORKTREE_V2_APPLY: value }).newApplyEnabled, false);
const run: CollaborationRunState = { runId: "run_rollout", version: 1, cwd: "/private/repo", mode: "isolated_coding", status: "complete",
  worktreeImplementation: 2, worktreeManifestPath: "/private/worktree-manifest.json", captureState: "captured", canContinue: true,
  message: "test", createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", events: [],
  workers: [{ workerId: "worker_1", name: "Worker", task: "test", status: "complete", patchSha256: "a".repeat(64), changedFiles: ["source.txt"], canContinue: true }] };
const oldCreation = process.env.SUBAGENT_WORKTREE_V2;
const oldApply = process.env.SUBAGENT_WORKTREE_V2_APPLY;
try {
  delete process.env.SUBAGENT_WORKTREE_V2;
  delete process.env.SUBAGENT_WORKTREE_V2_APPLY;
  const snapshot = sanitizeCollaborationRun(run);
  assert.equal(getRunCapabilities(snapshot).canApply, true, "admission disabled does not change an existing v2 lifecycle");
  assert.equal(getRunCapabilities(snapshot).canContinue, true);
  assert.equal(JSON.stringify(snapshot).includes("/private/"), false);
  assert.equal(getWorktreeRunCapabilities({ ...run, worktreeImplementation: undefined }).implementation, "v2", "pre-flag manifests remain v2");
  const legacy = { ...run, worktreeImplementation: undefined, worktreeManifestPath: undefined };
  assert.equal(getWorktreeRunCapabilities(legacy).implementation, "legacy");
  assert.equal(getWorktreeRunCapabilities({ ...legacy, worktreeManifestPath: "" }).implementation, "legacy", "an empty legacy path does not grant v2 capabilities");
  assert.equal(getRunCapabilities(sanitizeCollaborationRun(legacy)).canApply, false);
  assert.equal(getRunCapabilities(sanitizeCollaborationRun(legacy)).canDiscard, false);
  assert.equal(getRunCapabilities({ ...snapshot, worktreeCapabilities: undefined }).canApply, false, "old server snapshots do not grant mutation capabilities");
  process.env.SUBAGENT_WORKTREE_V2_APPLY = "0";
  const disabled = sanitizeCollaborationRun(run);
  assert.equal(getRunCapabilities(disabled).canApply, false);
  assert.equal(getRunCapabilities(disabled).canReview, true);
  assert.equal(getRunCapabilities(disabled).canContinue, true);
  assert.equal(getRunCapabilities(disabled).canDiscard, true);
  const merged = mergeCollaborationMuxSnapshot(snapshot, toCollaborationMuxSnapshot(run));
  assert.equal(getRunCapabilities(merged).canApply, false, "same-revision Mux propagates the emergency brake");
} finally {
  if (oldCreation === undefined) delete process.env.SUBAGENT_WORKTREE_V2; else process.env.SUBAGENT_WORKTREE_V2 = oldCreation;
  if (oldApply === undefined) delete process.env.SUBAGENT_WORKTREE_V2_APPLY; else process.env.SUBAGENT_WORKTREE_V2_APPLY = oldApply;
}
console.log("worktree rollout policy and server/client capabilities passed");
