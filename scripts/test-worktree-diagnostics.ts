import assert from "node:assert/strict";
import {
  beginWorktreeOperation, getWorktreeDiagnostics, hashWorktreeRepository, recordWorktreeDecision, resetWorktreeDiagnosticsForTests,
  worktreeDiagnosticReason, WORKTREE_OPERATION_KINDS, WORKTREE_DIAGNOSTIC_REASONS,
  type WorktreeDiagnosticReason, type WorktreeOperationContext, type WorktreeOperationDetails,
} from "../lib/parallel-agent/worktree-diagnostics.ts";

const environment = process.env as Record<string, string | undefined>;
const savedEnvironment = environment.NODE_ENV;
const savedTestContext = environment.NODE_TEST_CONTEXT;
try {
  environment.NODE_ENV = "production";
  environment.NODE_TEST_CONTEXT = "child-v8";
  assert.throws(resetWorktreeDiagnosticsForTests, /WORKTREE_DIAGNOSTICS_TEST_ONLY/);
  environment.NODE_ENV = "development";
  delete environment.NODE_TEST_CONTEXT;
  assert.throws(resetWorktreeDiagnosticsForTests, /WORKTREE_DIAGNOSTICS_TEST_ONLY/);
  environment.NODE_ENV = "test";
  resetWorktreeDiagnosticsForTests();
  const repoHash = hashWorktreeRepository("/private/repository/must-not-leak");
  assert.match(repoHash, /^[a-f0-9]{16}$/);
  assert.equal(repoHash, hashWorktreeRepository("/private/repository/must-not-leak"));
  assert.notEqual(repoHash, hashWorktreeRepository("/different/repository"));
  const operation = beginWorktreeOperation("capture", { runId: "run-1", workerId: "worker-1", repoHash });
  operation.finish("completed", { patchBytes: 2048, fileCount: 3, binaryFileCount: 1 });
  operation.finish("failed", { patchBytes: 99 });
  let snapshot = getWorktreeDiagnostics();
  assert.equal(snapshot.operations.capture.started, 1);
  assert.equal(snapshot.operations.capture.terminal, 1);
  assert.equal(snapshot.operations.capture.outcomes.completed, 1);
  assert.equal(snapshot.operations.capture.failed, 0);
  assert.equal(snapshot.operations.capture.binaryPatches, 1);
  assert.equal(snapshot.operations.capture.successRate, 1);
  assert.ok(snapshot.operations.capture.durationP95Ms >= 0);
  assert.deepEqual(snapshot.operations.capture.patchBytes, { count: 1, total: 2048, max: 2048 });
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[0].operationId, snapshot.events[1].operationId);
  assert.equal(snapshot.events[1].repoHash, repoHash);
  const applying = beginWorktreeOperation("apply", { transactionId: "tx-1" });
  applying.checkpoint("checked", { patchBytes: 400, fileCount: 2 });
  applying.checkpoint("checked", { patchBytes: 400 });
  assert.equal(getWorktreeDiagnostics().operations.apply.terminal, 0);
  applying.finish("applied", { patchBytes: 400 });
  applying.checkpoint("checked");
  snapshot = getWorktreeDiagnostics();
  assert.equal(snapshot.operations.apply.outcomes.checked, 1);
  assert.equal(snapshot.operations.apply.outcomes.applied, 1);
  assert.deepEqual(snapshot.operations.apply.patchBytes, { count: 1, total: 400, max: 400 });
  const cleanup = beginWorktreeOperation("cleanup");
  cleanup.checkpoint("planned");
  cleanup.finish("partial", { reason: "dirty_uncaptured", preservedCount: 3, removedWorktreeCount: 2, removedBranchCount: 1 });
  const failedCapture = beginWorktreeOperation("capture");
  failedCapture.finish("failed", { preservedCount: 1, reason: worktreeDiagnosticReason("ARTIFACT_DIGEST_MISMATCH") });
  snapshot = getWorktreeDiagnostics();
  assert.equal(snapshot.operations.cleanup.preserved, 3);
  assert.equal(snapshot.operations.cleanup.worktreesRemoved, 2);
  assert.equal(snapshot.operations.cleanup.branchesRemoved, 1);
  assert.equal(snapshot.operations.capture.preserved, 1);
  assert.equal(snapshot.reasons.digest_mismatch, 1);
  const unexpected = beginWorktreeOperation("setup", {
    runId: "/private/path", workerId: "worker\nsecret", transactionId: "token with spaces", repoHash: "/raw/repo",
    cwd: "/another/private/path", prompt: "secret-prompt",
  } as WorktreeOperationContext);
  unexpected.finish("applied", { reason: "GIT_LEAK_SECRET" as WorktreeDiagnosticReason, patchBytes: Number.POSITIVE_INFINITY,
    fileCount: Number.NaN, binaryFileCount: -5, stderr: "raw-secret-stderr" } as WorktreeOperationDetails);
  snapshot = getWorktreeDiagnostics();
  assert.equal(snapshot.operations.setup.outcomes.failed, 1, "kind rejects impossible outcomes");
  assert.equal(snapshot.operations.setup.successRate, 0);
  assert.equal(snapshot.operations.setup.patchBytes.total, 0);
  assert.equal(snapshot.events.at(-1)?.reason, "unknown");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(worktreeDiagnosticReason("GIT_UNKNOWN_SECRET_PAYLOAD"), "unknown");
  assert.equal(worktreeDiagnosticReason({ code: "ENV_ABORTED", message: "private reason" }), "cancelled");
  assert.equal(worktreeDiagnosticReason(new Proxy({}, { has() { throw new Error("getter fault"); } })), "unknown");
  recordWorktreeDecision({ runId: "run-decision", workerId: "worker-decision", repoHash }, "artifact_invalid", {
    repoMatches: true, pathSafe: true, worktreeExists: true, worktreeRegistered: true, dirty: null,
    artifactExists: true, artifactDigestMatches: false, captureMatchesWorktree: null,
  });
  snapshot = getWorktreeDiagnostics();
  const decision = snapshot.events.findLast((event) => event.phase === "decision");
  assert.equal(decision?.reason, "digest_mismatch");
  assert.deepEqual(decision?.facts, { repoMatches: true, pathSafe: true, worktreeExists: true, worktreeRegistered: true,
    dirty: null, artifactExists: true, artifactDigestMatches: false, captureMatchesWorktree: null });
  const hostile = new Proxy({}, { get() { throw new Error("telemetry must not throw"); } });
  assert.doesNotThrow(() => beginWorktreeOperation("setup", hostile).finish("failed", hostile));
  assert.doesNotThrow(() => beginWorktreeOperation("setup").finish("failed", hostile));
  for (let index = 0; index < 1000; index += 1) {
    beginWorktreeOperation("continue", { runId: `run-${index}`, workerId: `worker-${index}` }).finish("completed", { patchBytes: Number.MAX_SAFE_INTEGER });
  }
  snapshot = getWorktreeDiagnostics();
  assert.equal(snapshot.events.length, 200);
  assert.deepEqual(Object.keys(snapshot.operations), [...WORKTREE_OPERATION_KINDS]);
  assert.deepEqual(Object.keys(snapshot.reasons), [...WORKTREE_DIAGNOSTIC_REASONS]);
  assert.equal(snapshot.operations.continue.patchBytes.total, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.operations.continue.patchBytes.max, Number.MAX_SAFE_INTEGER);
  snapshot.operations.continue.started = -999;
  snapshot.events[0].runId = "mutated-return-value";
  assert.equal(getWorktreeDiagnostics().operations.continue.started, 1000);
  assert.equal(getWorktreeDiagnostics().events[0].runId?.includes("mutated"), false);
  assert.equal(JSON.stringify(getWorktreeDiagnostics()).includes("/private/repository"), false);
  resetWorktreeDiagnosticsForTests();
  assert.equal(getWorktreeDiagnostics().events.length, 0);
} finally {
  if (savedEnvironment === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = savedEnvironment;
  if (savedTestContext === undefined) delete environment.NODE_TEST_CONTEXT; else environment.NODE_TEST_CONTEXT = savedTestContext;
}
console.log("worktree diagnostics tests passed");
