import assert from "node:assert/strict";
import { SessionEventBuffer } from "../lib/agent-runtime/session-event-buffer.ts";
import {
  removedCollaborationMuxSnapshot,
  toCollaborationMuxSnapshot,
} from "../lib/parallel-agent/collaboration-mux.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import type { SubagentRunUpdate } from "../lib/host-event-bus.ts";

const buffer = new SessionEventBuffer<{ sessionId: string; epoch: string; globalSeq: number; type: string }>(3);
assert.equal(buffer.push({ sessionId: "background", epoch: "e", globalSeq: 2, type: "message_update" }), true);
assert.equal(buffer.push({ sessionId: "foreground", epoch: "e", globalSeq: 3, type: "agent_end" }), true);
assert.equal(buffer.push({ sessionId: "background", epoch: "e", globalSeq: 1, type: "message_start" }), true);
assert.equal(buffer.push({ sessionId: "overflow", epoch: "e", globalSeq: 4, type: "lost" }), false);
assert.deepEqual(buffer.diagnostics(), {
  size: 3,
  maximum: 3,
  sessionCount: 2,
  largestSessionSize: 2,
  peakSize: 3,
  pushedTotal: 3,
  drainedTotal: 0,
  overflowsTotal: 1,
});
assert.deepEqual(buffer.clear().sort(), ["background", "foreground"]);
assert.equal(buffer.length, 0);
assert.equal(buffer.push({ sessionId: "background", epoch: "e", globalSeq: 5, type: "recovered" }), true);
assert.deepEqual(buffer.drain("background").map((event) => event.globalSeq), [5]);
assert.equal(buffer.length, 0);
assert.deepEqual(buffer.diagnostics(), {
  size: 0,
  maximum: 3,
  sessionCount: 0,
  largestSessionSize: 0,
  peakSize: 3,
  pushedTotal: 4,
  drainedTotal: 1,
  overflowsTotal: 1,
});

const state: CollaborationRunState = {
  runId: "run-1",
  version: 0,
  parentSessionId: "secret-parent",
  cwd: "/secret/worktree",
  title: "Review",
  message: "private prompt",
  mode: "analysis",
  workflow: "parallel",
  status: "running",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:01.000Z",
  events: [{ type: "worker_event", runId: "run-1", result: "private output" }],
  workers: [{
    workerId: "worker-1",
    name: "Reviewer",
    task: "private task",
    sessionId: "secret-session",
    worktreePath: "/secret/worktree/worker",
    result: "private result",
    status: "running",
    activeTool: { toolName: "read", summary: "src/a.ts", status: "running", ts: "now" },
  }],
};
const snapshot = toCollaborationMuxSnapshot(state);
assert.equal(snapshot.authoritative, true);
assert.deepEqual(snapshot.workers.map((worker) => worker.name), ["Reviewer"]);
const serialized = JSON.stringify(snapshot);
for (const secret of ["secret-parent", "/secret/worktree", "private prompt", "private task", "secret-session", "private result", "private output"]) {
  assert.equal(serialized.includes(secret), false, `Mux whitelist leaked: ${secret}`);
}
assert.deepEqual(toCollaborationMuxSnapshot({ ...state, workers: [] }).workers, [], "empty workers is authoritative");
const productionFrame: SubagentRunUpdate = {
  type: "subagent_run_update",
  parentSessionId: state.parentSessionId!,
  run: snapshot,
  updatedAt: Date.now(),
};
assert.equal(JSON.stringify(productionFrame).includes("private prompt"), false);
const removed = removedCollaborationMuxSnapshot("run-1");
assert.equal(removed.authoritative, true);
assert.equal(removed.runId, "run-1");
assert.equal(removed.status, "removed");
assert.deepEqual(removed.workers, []);
assert.ok(Number.isFinite(Date.parse(removed.updatedAt)));
const tombstoneFrame: SubagentRunUpdate = {
  type: "subagent_run_update",
  parentSessionId: state.parentSessionId!,
  run: removed,
  updatedAt: Date.now(),
};
assert.equal(tombstoneFrame.run.status, "removed");

console.log("mux red-team tests passed");
