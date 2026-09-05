import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { buildLegacyWorktreeRecoveryReport, LEGACY_REPORT_LIMITS } from "../lib/parallel-agent/worktree-legacy-report.ts";
import type { CollaborationRunState } from "../lib/parallel-agent/collaboration-types.ts";

function legacy(overrides: Partial<CollaborationRunState> = {}): CollaborationRunState {
  return { runId: "legacy_secret_token", version: 0, cwd: "/private/user/repository", message: "credential=private-value", mode: "isolated_coding", status: "complete",
    workers: [{ workerId: "worker_secret_token", name: "/private/name", task: "private prompt", status: "complete", sessionId: "private-session-id",
      worktreePath: "/private/worktree", diff: "diff --git /private/a /private/b\n+API_KEY=private-value", result: "private tool output" }],
    events: [], createdAt: "untrusted-date", updatedAt: "untrusted-date", ...overrides };
}
const input = legacy(); const before = structuredClone(input);
const report = buildLegacyWorktreeRecoveryReport(input)!;
assert.equal(report.kind, "legacy_read_only"); assert.equal(report.workerCount, 1); assert.equal(report.inspectedWorkerCount, 1);
assert.equal(report.workers[0].storedDiffPresent, true); assert.equal(report.baseline, "unverified"); assert.equal(report.resources, "not_inspected");
assert.equal(report.diffExport.available, false); assert.equal(report.capabilities.diffDownload, false);
for (const key of ["apply", "continue", "discard", "automaticMigration"] as const) assert.equal(report.capabilities[key], false);
assert.equal(report.capabilities.metadataExport, true); assert.deepEqual(input, before);
const text = JSON.stringify(report);
for (const secret of ["private", "secret_token", "API_KEY", "sessionId", "worktreePath", "patchPath", "baseCommit", "credential", "prompt", "tool output"]) assert.equal(text.includes(secret), false, secret);
assert.match(report.runRef!, /^legacy-[a-f0-9]{16}$/); assert.match(report.workers[0].workerRef!, /^worker-[a-f0-9]{16}$/);
assert.equal(buildLegacyWorktreeRecoveryReport(input)!.runRef, report.runRef);
assert.notEqual(buildLegacyWorktreeRecoveryReport(legacy({ runId: "different" }))!.runRef, report.runRef);

for (const reference of ["/private/missing-manifest.json", " ", "/../unsafe", "v2-manifest"]) {
  assert.equal(buildLegacyWorktreeRecoveryReport(legacy({ worktreeManifestPath: reference })), null, "invalid v2 references must not fall back to legacy");
}
assert.equal(buildLegacyWorktreeRecoveryReport(legacy({ mode: "analysis" })), null);
assert.equal(buildLegacyWorktreeRecoveryReport({ ...input, worktreeImplementation: 2 }), null, "a v2 run with missing manifest metadata must not become legacy");
assert.equal(buildLegacyWorktreeRecoveryReport(legacy({ worktreeManifestPath: "" }))?.kind, "legacy_read_only");
assert.equal(buildLegacyWorktreeRecoveryReport(legacy({ baseCommit: "a".repeat(40) }))?.baseline, "unverified", "legacy baseline claims are not proof");

for (const historical of [legacy({ status: "applied" }), legacy({ applyState: "applied" })]) {
  const value = buildLegacyWorktreeRecoveryReport(historical)!;
  assert.equal(value.historicalApplied, true); assert.equal(value.reason, "legacy_applied_history_only");
  assert.equal(value.historyEvidence, "store_only_not_git_verified"); assert.equal(value.capabilities.discard, false);
  assert.ok(value.instructions.some((instruction) => instruction.code === "history_only"));
}
assert.equal(buildLegacyWorktreeRecoveryReport(legacy({ status: "aborted" }))?.historicalStatus, "aborted");

// A sparse billion-worker array proves the report neither clones nor enumerates all entries.
const hugeWorkers = new Array(1_000_000_000); hugeWorkers[0] = input.workers[0];
Object.defineProperty(hugeWorkers, "32", { get() { throw new Error("must not inspect beyond the cap"); } });
const bounded = buildLegacyWorktreeRecoveryReport(legacy({ workers: hugeWorkers }))!;
assert.equal(bounded.workerCount, 1_000_000_000); assert.equal(bounded.workers.length, LEGACY_REPORT_LIMITS.maxWorkers);
assert.equal(bounded.workersTruncated, true); assert.ok(JSON.stringify(bounded).length < 12_000);
const hugeDiff = "sensitive".repeat(1_000_000);
const huge = legacy({ runId: "x".repeat(1_000_000), workers: [{ ...input.workers[0], workerId: "x".repeat(1_000_000), diff: hugeDiff }] });
const hugeReport = buildLegacyWorktreeRecoveryReport(huge)!;
assert.equal(hugeReport.runRef, null); assert.equal(hugeReport.workers[0].workerRef, null); assert.equal(hugeReport.workers[0].storedDiffPresent, true);
assert.ok(JSON.stringify(hugeReport).length < 4_000);

const untrusted = legacy();
for (const key of ["cwd", "message", "events", "baseCommit", "createdAt", "updatedAt"] as const) Object.defineProperty(untrusted, key, { get() { throw new Error("must not inspect internal provenance"); } });
Object.defineProperty(untrusted.workers[0], "diff", { get() { throw new Error("must not invoke a diff getter"); } });
assert.equal(buildLegacyWorktreeRecoveryReport(untrusted)!.workers[0].storedDiffPresent, false);
assert.equal(buildLegacyWorktreeRecoveryReport({ ...input, status: "/private/status" } as unknown as CollaborationRunState)!.historicalStatus, "unknown");
assert.equal(buildLegacyWorktreeRecoveryReport({ ...input, workers: null } as unknown as CollaborationRunState)!.workerCount, null);

// Runtime tripwires supplement the pure type-only dependency boundary: no old path
// inspection, session scan, Git command or file mutation is needed for a report.
const read = fs.readFileSync, write = fs.writeFileSync, stat = fs.statSync, exec = childProcess.execFileSync;
const forbidden = () => { throw new Error("LEGACY_REPORT_IO_FORBIDDEN"); };
try {
  fs.readFileSync = forbidden as typeof fs.readFileSync; fs.writeFileSync = forbidden as typeof fs.writeFileSync;
  Reflect.set(fs, "statSync", forbidden); childProcess.execFileSync = forbidden as typeof childProcess.execFileSync;
  for (let index = 0; index < 1000; index += 1) assert.equal(buildLegacyWorktreeRecoveryReport(input)?.workerCount, 1);
} finally { fs.readFileSync = read; fs.writeFileSync = write; Reflect.set(fs, "statSync", stat); childProcess.execFileSync = exec; }
report.workers.length = 0; Reflect.set(report.limits, "maxWorkers", 0);
assert.equal(buildLegacyWorktreeRecoveryReport(input)?.workers.length, 1);
assert.equal(LEGACY_REPORT_LIMITS.maxWorkers, 32);
console.log("legacy worktree metadata-only recovery report tests passed");
