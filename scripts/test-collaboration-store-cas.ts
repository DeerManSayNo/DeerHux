import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import {
  abortCollaborationRun,
  compareAndSetCollaborationRun,
  createCollaborationRun,
  emitCollaborationRunEvent,
  getCollaborationRun,
  removeCollaborationRun,
} from "../lib/parallel-agent/collaboration-store.ts";

const runId = `store_cas_${randomUUID()}`;
const now = new Date().toISOString();
const state: CollaborationRunState = {
  runId,
  version: 0,
  cwd: process.cwd(),
  message: "store CAS test",
  mode: "isolated_coding",
  status: "complete",
  workers: [],
  events: [],
  createdAt: now,
  updatedAt: now,
};

try {
  createCollaborationRun(state);

  const missingApplyFacts = compareAndSetCollaborationRun(runId, { expectedVersion: 0 }, (candidate) => {
    candidate.status = "applying";
  });
  assert.deepEqual(missingApplyFacts.ok ? null : missingApplyFacts.reason, "invalid_transition");
  assert.equal(getCollaborationRun(runId)?.status, "complete");
  assert.equal(getCollaborationRun(runId)?.version, 0);

  const applyStartedAt = new Date().toISOString();
  const acquired = compareAndSetCollaborationRun(runId, {
    expectedVersion: 0,
    allowedStatuses: ["complete"],
  }, (candidate) => {
    candidate.status = "applying";
    candidate.applyState = "applying";
    candidate.applyTransactionId = "tx-1";
    candidate.applyStartedAt = applyStartedAt;
  });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.ok && acquired.state.version, 1);
  assert.equal(await abortCollaborationRun(runId), false);
  assert.equal(getCollaborationRun(runId)?.status, "applying");

  const stale = compareAndSetCollaborationRun(runId, { expectedVersion: 0 }, (candidate) => {
    candidate.summary = "must not commit";
  });
  assert.deepEqual(stale.ok ? null : stale.reason, "version_mismatch");
  assert.equal(getCollaborationRun(runId)?.summary, undefined);

  for (let index = 0; index < 1005; index += 1) {
    emitCollaborationRunEvent({ type: "worker_event", runId, result: String(index) });
  }
  const bounded = getCollaborationRun(runId);
  assert.equal(bounded?.events.length, 1000);
  assert.equal(bounded?.events[0]?.result, "5");

  // 模拟进程内缓存丢失，确认磁盘 snapshot 也只恢复有界事件。
  globalThis.__deerhuxCollaborationRuns?.delete(runId);
  const recovered = getCollaborationRun(runId);
  assert.equal(recovered?.events.length, 1000);
  assert.equal(recovered?.events[0]?.result, "6");
  assert.equal(recovered?.events.at(-1)?.type, "run_interrupted");
  assert.equal(recovered?.applyTransactionId, "tx-1");
  assert.equal(recovered?.applyStartedAt, applyStartedAt);

  console.log("collaboration store CAS tests passed");
} finally {
  await removeCollaborationRun(runId);
}

const abortRunId = `store_abort_${randomUUID()}`;
const originalAppend = fs.appendFileSync;
try {
  createCollaborationRun({ ...structuredClone(state), runId: abortRunId, version: 0, status: "running", events: [] });
  fs.appendFileSync = ((file, ...args) => {
    if (String(file).endsWith(`${abortRunId}.jsonl`)) throw new Error("injected persistence failure");
    return originalAppend(file, ...args);
  }) as typeof fs.appendFileSync;
  assert.equal(await abortCollaborationRun(abortRunId), false);
  assert.equal(getCollaborationRun(abortRunId)?.status, "running");
  assert.equal(getCollaborationRun(abortRunId)?.events.some((event) => event.type === "run_aborted"), false);
  fs.appendFileSync = originalAppend;
  assert.equal(await abortCollaborationRun(abortRunId), true);
  assert.equal(getCollaborationRun(abortRunId)?.status, "aborted");
} finally {
  fs.appendFileSync = originalAppend;
  await removeCollaborationRun(abortRunId);
}
