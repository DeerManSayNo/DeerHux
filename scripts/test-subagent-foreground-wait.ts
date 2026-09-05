import assert from "node:assert/strict";
import { waitForForegroundRun } from "../lib/parallel-agent/foreground-run-wait.ts";
import type { CollaborationRunEvent, CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";

function makeRun(status: CollaborationRunState["status"]): CollaborationRunState {
  return {
    runId: "run-test",
    version: 0,
    cwd: process.cwd(),
    title: "test",
    message: "test",
    mode: "analysis",
    taskMode: "ask",
    runPlacement: "foreground",
    workflow: "parallel",
    status,
    isGit: false,
    workers: [],
    events: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

async function testSignalAbortJoinsWorkers(): Promise<void> {
  let state = makeRun("running");
  let listener: ((event: CollaborationRunEvent) => void) | undefined;
  let abortFinished = false;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);

  const result = await waitForForegroundRun({
    runId: state.runId,
    signal: controller.signal,
    getRun: () => state,
    subscribe: (_runId, next) => {
      listener = next;
      return () => { listener = undefined; };
    },
    abortRun: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = makeRun("aborted");
      abortFinished = true;
      listener?.({ type: "run_aborted", runId: state.runId });
      return true;
    },
  });

  assert.equal(abortFinished, true, "foreground wait must join worker abort before settling");
  assert.equal(result.status, "aborted", "abort must never return a running snapshot");
}

async function testAlreadyCompleteSubscriptionRace(): Promise<void> {
  const state = makeRun("complete");
  let unsubscribed = false;
  const result = await waitForForegroundRun({
    runId: state.runId,
    getRun: () => state,
    subscribe: () => () => { unsubscribed = true; },
    abortRun: async () => false,
  });
  assert.equal(result.status, "complete");
  assert.equal(unsubscribed, true, "already-terminal race path must release its listener");
}

async function testRejectsNonTerminalTerminalEvent(): Promise<void> {
  const state = makeRun("running");
  await assert.rejects(
    waitForForegroundRun({
      runId: state.runId,
      getRun: () => state,
      subscribe: (_runId, listener) => {
        queueMicrotask(() => listener({ type: "run_complete", runId: state.runId, summary: "invalid" }));
        return () => {};
      },
      abortRun: async () => false,
    }),
    /non-terminal status running/,
  );
}

async function testSynchronousReplayUnsubscribes(): Promise<void> {
  const state = makeRun("complete");
  let unsubscribed = false;
  const result = await waitForForegroundRun({
    runId: state.runId,
    getRun: () => state,
    subscribe: (_runId, listener) => {
      listener({ type: "run_complete", runId: state.runId, summary: "done" });
      return () => { unsubscribed = true; };
    },
    abortRun: async () => false,
  });
  assert.equal(result.status, "complete");
  assert.equal(unsubscribed, true, "synchronous terminal replay must release the installed listener");
}

async function testRecoveryIsStoppedWork(): Promise<void> {
  const state = makeRun("recoverable");
  const result = await waitForForegroundRun({
    runId: state.runId,
    getRun: () => state,
    subscribe: () => () => {},
    abortRun: async () => false,
  });
  assert.equal(result.status, "recoverable", "manual recovery must release the parent wait without claiming success");
}

await testSignalAbortJoinsWorkers();
await testAlreadyCompleteSubscriptionRace();
await testRejectsNonTerminalTerminalEvent();
await testSynchronousReplayUnsubscribes();
await testRecoveryIsStoppedWork();
console.log("subagent foreground wait tests passed");
