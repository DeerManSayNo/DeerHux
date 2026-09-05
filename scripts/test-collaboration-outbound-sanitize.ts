import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../lib/rpc-manager.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";
import { snapshotRun } from "../lib/parallel-agent/collaboration-orchestrator.ts";
import { createCollaborationRun, emitCollaborationRunEvent, removeCollaborationRun } from "../lib/parallel-agent/collaboration-store.ts";
import { GET as getRun } from "../app/api/agent-runs/[runId]/route.ts";
import { GET as getRunEvents } from "../app/api/agent-runs/[runId]/events/route.ts";
import { POST as resumeWorker } from "../app/api/agent-runs/[runId]/workers/[workerId]/resume/route.ts";
import { GET as resolveWorkerSession } from "../app/api/agent-runs/[runId]/workers/[workerId]/session/route.ts";
import { sanitizeCollaborationReasonCode } from "../lib/parallel-agent/collaboration-sanitize.ts";
import { cacheSessionPath } from "../lib/session-reader.ts";

assert.equal(sanitizeCollaborationReasonCode("APPLY_HISTORY_UNVERIFIED"), "APPLY_HISTORY_UNVERIFIED");
assert.equal(sanitizeCollaborationReasonCode("RUN_SETUP_STATE_PERSISTENCE_FAILED"), "RUN_SETUP_STATE_PERSISTENCE_FAILED");
assert.equal(sanitizeCollaborationReasonCode("APPLY_HISTORY_UNVERIFIED_/private/token"), undefined);
for (const code of ["ARTIFACT_SYNTHETIC_INVALID", "ENV_HOOK_FAILED", "ENV_HOOK_TIMEOUT", "ENV_ABORTED"]) {
  assert.equal(sanitizeCollaborationReasonCode(code), code);
  assert.equal(sanitizeCollaborationReasonCode(`${code}_PRIVATE_TOKEN`), undefined);
}

const runId = `sanitize_${randomUUID().replaceAll("-", "")}`;
const workerId = "worker-1";
const secrets = [
  "/Users/private/repository/.deerhux/worktrees/worker-1",
  "/Users/private/repository/.git",
  "/private/worktree-manifest.json",
  "/private/artifact.patch",
  "secret-worker-session-id",
  "git stderr mentions refs/heads/private and /Users/private/repository",
  "bash -lc 'cat /Users/private/token && echo super-secret-token'",
];
const injected = {
  manifestPath: secrets[2],
  patchPath: secrets[3],
  worktreePath: secrets[0],
  gitCommonDir: secrets[1],
  sessionId: secrets[4],
};
const now = new Date().toISOString();
const state = {
  runId,
  version: 7,
  parentSessionId: secrets[4],
  parentEntryId: "entry-1",
  cwd: secrets[0],
  worktreeManifestPath: secrets[2],
  ...injected,
  title: "Sanitize test",
  message: "Public task",
  mode: "analysis",
  status: "complete",
  captureState: "captured",
  applyState: "recovery_required",
  recoveryState: "manual_recovery_required",
  canContinue: true,
  continueUnavailableReason: secrets[5],
  error: secrets[5],
  workers: [{
    workerId,
    name: "Worker",
    task: "Public worker task",
    status: "error",
    sessionId: secrets[4],
    worktreePath: secrets[0],
    patchPath: secrets[3],
    gitCommonDir: secrets[1],
    manifestPath: secrets[2],
    environment: { mode: "hook", syntheticPaths: [secrets[0]], syntheticIdentities: [{ path: secrets[0], dev: 1, ino: 1 }], script: secrets[6] },
    error: secrets[5],
    captureErrorCode: "ARTIFACT_SUPER_SECRET_TOKEN",
    continueUnavailableReason: secrets[5],
    canContinue: true,
    changedFiles: ["src/safe.ts", secrets[0], "../escape.txt"],
    binaryFiles: ["public/safe.bin", secrets[0]],
    activeTool: { toolName: "bash", summary: secrets[6], status: "running", ts: now },
    recentTools: [{ toolName: "read", summary: secrets[0], status: "done", ts: now }],
  }],
  events: [{
    type: "worker_event",
    runId,
    workerId,
    error: secrets[5],
    errorCode: "ARTIFACT_SUPER_SECRET_TOKEN",
    summary: secrets[6],
    result: secrets[0],
    diff: secrets[3],
    event: {
      type: "tool_execution_start",
      toolName: "bash",
      input: { command: secrets[6], sessionId: secrets[4] },
      errorMessage: secrets[5],
    } as unknown as AgentEvent,
  }],
  createdAt: now,
  updatedAt: now,
} as unknown as CollaborationRunState;

function assertNoSecrets(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `${label} leaked ${secret}`);
  for (const key of ["manifestPath", "patchPath", "worktreePath", "gitCommonDir", "sessionId", "syntheticPaths", "syntheticIdentities"]) {
    assert.equal(serialized.includes(`\"${key}\"`), false, `${label} leaked internal field ${key}`);
  }
}

type TestSseSnapshot = {
  version: number;
  captureState?: string;
  applyState?: string;
  recoveryState?: string;
  lifecycleEvent?: {
    type: string;
    eventId?: string;
    transactionId?: string;
    phase?: string;
    fileCount?: number;
    binaryFileCount?: number;
    reasonCode?: string;
    errorCode?: string;
    error?: string;
    result?: string;
    summary?: string;
    event?: unknown;
  };
  workers: Array<{
    changedFileCount?: number;
    binaryFileCount?: number;
    activeTool?: { summary: string };
  }>;
};

async function readSseSnapshot(label: string): Promise<TestSseSnapshot> {
  const abortController = new AbortController();
  const response = await getRunEvents(new Request(`http://localhost/api/agent-runs/${runId}/events`, {
    signal: abortController.signal,
  }), { params: Promise.resolve({ runId }) });
  const firstFrame = await response.body!.getReader().read();
  abortController.abort();
  const text = new TextDecoder().decode(firstFrame.value);
  assertNoSecrets(text, label);
  return JSON.parse(text.match(/^data: (.+)$/m)?.[1] ?? "null") as TestSseSnapshot;
}

createCollaborationRun(state);
try {
  emitCollaborationRunEvent({
    type: "worker_capture_completed",
    runId,
    workerId,
    fileCount: 3,
    binaryFileCount: 1,
    reasonCode: "CAPTURE_FAILED",
  });
  const getResponse = await getRun(new Request(`http://localhost/api/agent-runs/${runId}`), {
    params: Promise.resolve({ runId }),
  });
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("cache-control"), "no-store");
  const getBody = await getResponse.json() as CollaborationRunState;
  assertNoSecrets(getBody, "GET Run");
  assert.equal(getBody.error, "Collaboration run failed");
  assert.equal(getBody.workers[0]?.error, "Worker operation failed");
  assert.equal(getBody.workers[0]?.captureErrorCode, undefined);
  assert.equal(getBody.workers[0]?.activeTool?.summary, "");
  assert.deepEqual(getBody.workers[0]?.changedFiles, ["src/safe.ts"]);
  assert.equal(getBody.events[0]?.event, undefined);
  assert.equal(getBody.events[0]?.summary, undefined);
  assert.equal(getBody.events[0]?.errorCode, undefined);
  assert.equal(getBody.events[0]?.error, "Collaboration event failed");
  assert.equal(getBody.events[1]?.fileCount, 3);
  assert.equal(getBody.events[1]?.binaryFileCount, 1);
  assert.equal(getBody.events[1]?.reasonCode, "CAPTURE_FAILED");

  // Session identity remains absent from ambient snapshots and is resolved only
  // through the explicit, user-triggered navigation endpoint.
  cacheSessionPath(secrets[4], process.argv[1]);
  const sessionResponse = await resolveWorkerSession(
    new Request(`http://localhost/api/agent-runs/${runId}/workers/${workerId}/session`),
    { params: Promise.resolve({ runId, workerId }) },
  );
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await sessionResponse.json(), { sessionId: secrets[4] });

  const sseBody = await readSseSnapshot("SSE capture snapshot");
  assert.equal(sseBody.version, 7);
  assert.equal(sseBody.captureState, "captured");
  assert.equal(sseBody.applyState, "recovery_required");
  assert.equal(sseBody.recoveryState, "manual_recovery_required");
  assert.equal(sseBody.lifecycleEvent?.type, "worker_capture_completed");
  assert.equal(typeof sseBody.lifecycleEvent?.eventId, "string");
  assert.equal(sseBody.lifecycleEvent?.fileCount, 3);
  assert.equal(sseBody.lifecycleEvent?.binaryFileCount, 1);
  assert.equal(sseBody.lifecycleEvent?.reasonCode, "CAPTURE_FAILED");
  assert.equal(sseBody.lifecycleEvent?.error, undefined);
  assert.equal(sseBody.lifecycleEvent?.result, undefined);
  assert.equal(sseBody.lifecycleEvent?.summary, undefined);
  assert.equal(sseBody.lifecycleEvent?.event, undefined);
  assert.equal(sseBody.workers[0]?.changedFileCount, 3);
  assert.equal(sseBody.workers[0]?.binaryFileCount, 2);
  assert.equal(sseBody.workers[0]?.activeTool?.summary, "");

  emitCollaborationRunEvent({
    type: "worktree_cleanup_error",
    runId,
    workerId,
    errorCode: "WORKTREE_CLEANUP_PARTIAL",
    reasonCode: "WORKTREE_CLEANUP_PARTIAL",
    error: secrets[5],
  });
  const cleanupSseBody = await readSseSnapshot("SSE cleanup snapshot");
  assert.equal(cleanupSseBody.lifecycleEvent?.type, "worktree_cleanup_error");
  assert.equal(cleanupSseBody.lifecycleEvent?.errorCode, "WORKTREE_CLEANUP_PARTIAL");
  assert.equal(cleanupSseBody.lifecycleEvent?.reasonCode, "WORKTREE_CLEANUP_PARTIAL");
  assert.equal(cleanupSseBody.lifecycleEvent?.error, undefined);

  emitCollaborationRunEvent({
    type: "patch_apply_error",
    runId,
    transactionId: "transaction-public-id",
    phase: "checked",
    errorCode: "APPLY_FINAL_CHECK_FAILED",
    error: secrets[5],
  });
  const legacySseBody = await readSseSnapshot("SSE legacy Apply snapshot");
  assert.equal(legacySseBody.lifecycleEvent?.type, "patch_apply_error");
  assert.equal(legacySseBody.lifecycleEvent?.transactionId, "transaction-public-id");
  assert.equal(legacySseBody.lifecycleEvent?.phase, "checked");
  assert.equal(legacySseBody.lifecycleEvent?.errorCode, "APPLY_FINAL_CHECK_FAILED");
  assert.equal(legacySseBody.lifecycleEvent?.error, undefined);

  // Exercise the Resume catch path: analysis-mode admission rejects using the
  // internal reason, while the actual HTTP response must remain stable.
  const resumeResponse = await resumeWorker(new Request(`http://localhost/api/agent-runs/${runId}/workers/${workerId}/resume`, {
    method: "POST",
    body: JSON.stringify({ prompt: "continue" }),
  }), { params: Promise.resolve({ runId, workerId }) });
  assert.equal(resumeResponse.status, 409);
  assert.equal(resumeResponse.headers.get("cache-control"), "no-store");
  const resumeBody = await resumeResponse.json();
  assertNoSecrets(resumeBody, "Resume");
  assert.deepEqual(resumeBody, {
    error: "Worker cannot be continued (CONTINUE_FAILED)",
    errorCode: "CONTINUE_FAILED",
  });

  assertNoSecrets(snapshotRun(state), "parent Session snapshot");
  console.log("collaboration outbound sanitization tests passed");
} finally {
  globalThis.__deerhuxSessionPathCache?.delete(secrets[4]);
  await removeCollaborationRun(runId);
}
