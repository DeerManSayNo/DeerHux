import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubagentRunCard } from "../../components/SubagentRunCard";
import type { CollaborationRunSnapshot } from "../../lib/parallel-agent/collaboration-types";
import { summarizeFileChanges, type WorktreeFileChange } from "../../lib/parallel-agent/worktree-file-metadata";

type ApplyOutcome = "applied" | "conflict" | "precondition_failed" | "error" | "no_changes" | "recovery_required" | "offline" | "offline_applied";
type LoggedRequest = { path: string; method: string; body: Record<string, unknown> };
const fixtureRunId = "browser_review_run";
const workerIds = ["browser_review_worker_1", "browser_review_worker_2"];
let metadataMode: "full" | "legacy" | "typechange" = "full";
const workerFiles = [["src/alpha.ts", "assets/logo.png"], ["src/beta.ts", "src/very-long-path/" + "nested-folder/".repeat(8) + "long-name.ts"]];
const patches = [
  "diff --git a/src/alpha.ts b/src/alpha.ts\nindex abc1234..def1234 100644\n--- a/src/alpha.ts\n+++ b/src/alpha.ts\n@@ -1 +1 @@\n-old\n+new\n",
  "diff --git a/src/beta.ts b/src/beta.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/beta.ts\n@@ -0,0 +1 @@\n+beta\n",
];
const patchDigests = ["9af98732817f84278e59902b58b2bc7f58e3f8a5bcc5a47f6ae9fcc1a2cc72a3", "f4d758504b78f4c48e035b73aa2934e58d4dca24f642c24af902cf76c8760350"];
function fileMetadata(file: string): WorktreeFileChange {
  const binary = file.endsWith(".png");
  const changeKind = binary ? "deleted" : file.includes("very-long-path") ? "renamed" : file.includes("beta") ? "new" : metadataMode === "typechange" ? "typechange" : "modified";
  return { path: file, previousPath: changeKind === "renamed" ? "src/old-name.ts" : null, changeKind, binary,
    oldBytes: changeKind === "new" ? null : binary ? 4096 : 12, newBytes: binary ? null : 16,
    addedLines: binary ? null : 1, deletedLines: binary ? null : changeKind === "new" ? 0 : 1 };
}
function initialRun(): CollaborationRunSnapshot {
  return {
    runId: fixtureRunId, version: 1, title: "真实组件浏览器验收", message: "Review isolated artifacts", mode: "isolated_coding", status: "complete", captureState: "captured", canContinue: true,
    worktreeCapabilities: { implementation: "v2", review: true, apply: true, continue: true, discard: true },
    createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:01Z", continueExpiresAt: "2099-01-01T00:00:00Z",
    workers: workerIds.map((workerId, index) => ({ workerId, name: "同名 Worker", task: "检查并审阅可靠性改动", status: "complete", canContinue: true, workerSessionState: "reopenable_from_jsonl", continueExpiresAt: "2099-01-01T00:00:00Z", patchSha256: patchDigests[index], patchBytes: patches[index].length, changedFiles: workerFiles[index], binaryFiles: index === 0 ? ["assets/logo.png"] : [], changeStats: summarizeFileChanges(workerFiles[index].map(fileMetadata)), result: "Worker 已完成；可审阅独立成果。" })),
  };
}
let serverRun = initialRun();
let refreshView: (run: CollaborationRunSnapshot) => void = () => {};
let outcome: ApplyOutcome = "applied";
let delayMs = 0;
let discardStrong = false;
let discardPartial = true;
let largePatch = false;
let sharedPath = false;
const requests: LoggedRequest[] = [];
const updateSnapshots: CollaborationRunSnapshot[] = [];
function json(body: unknown, status = 200) { return Response.json(body, { status }); }
function serverApplied(body: Record<string, unknown>) {
  const selected = body.workerIds as string[];
  const files = body.files as string[] ?? selected.flatMap((id) => workerFiles[workerIds.indexOf(id)]);
  serverRun = { ...serverRun, version: serverRun.version + 1, status: "applied", applyState: "applied", applyTransactionId: String(body.idempotencyKey), canContinue: false,
    workers: serverRun.workers.map((worker) => ({ ...worker, canContinue: false, appliedFiles: selected.includes(worker.workerId) ? worker.changedFiles?.filter((file) => files.includes(file)) : undefined })) };
  return { requestId: "fixture-apply", success: true, outcome: "applied", transactionId: String(body.idempotencyKey), phase: "persisted", workerIds: selected, files, runVersion: serverRun.version, errorCode: null, error: null };
}

// Mock only HTTP boundaries. All component state, rendering and event handlers are real.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), location.href);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  requests.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body });
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (url.pathname.endsWith("/diff")) {
    const index = workerIds.indexOf(url.searchParams.get("workerId") ?? "");
    if (index < 0) return json({ error: "DIFF_WORKER_NOT_FOUND" }, 404);
    if (url.searchParams.get("format") === "patch") return largePatch ? json({ error: "DIFF_TOO_LARGE" }, 413) : new Response(patches[index], { headers: { "Content-Type": "text/x-diff" } });
    return json({ runId: fixtureRunId, workerId: workerIds[index], changed: true, capturedAt: "2026-09-05T00:00:00Z", files: (sharedPath ? ["src/shared.ts"] : workerFiles[index]).map((path) => { const { binary, ...metadata } = fileMetadata(path); return metadataMode === "legacy" ? { path, type: binary ? "binary" : "text", bytes: null } : { ...metadata, type: binary ? "binary" : "text", bytes: metadata.newBytes }; }), artifact: { available: true, bytes: largePatch ? 2_000_000 : patches[index].length, sha256: patchDigests[index], inlineAvailable: !largePatch, containsBinary: index === 0 } });
  }
  if (url.pathname.endsWith("/apply")) {
    if (outcome === "offline" || outcome === "offline_applied") {
      if (outcome === "offline_applied") serverApplied(body);
      throw new TypeError("Failed to fetch");
    }
    if (outcome === "applied") return json(serverApplied(body));
    if (outcome === "recovery_required") serverRun = { ...serverRun, version: serverRun.version + 1, status: "recoverable", applyState: "recovery_required", recoveryState: "manual_recovery_required", canContinue: false };
    const codes = { conflict: "APPLY_WORKER_CONFLICT", precondition_failed: "APPLY_HEAD_CHANGED", error: "APPLY_INTERNAL_ERROR", no_changes: "APPLY_NO_CHANGES", recovery_required: "APPLY_MANUAL_RECOVERY_REQUIRED" };
    return json({ requestId: "fixture-failure", success: false, outcome, transactionId: body.idempotencyKey, phase: null, workerIds: body.workerIds, files: body.files ?? [], errorCode: codes[outcome], error: `Apply failed (${codes[outcome]})`, runVersion: serverRun.version }, outcome === "precondition_failed" ? 412 : outcome === "error" ? 500 : 409);
  }
  if (url.pathname.endsWith("/discard")) {
    const selected = (body.workerIds as string[] | undefined) ?? workerIds;
    if (body.mode === "preview") {
      const acknowledged = body.strongConfirmation === "DISCARD_UNCAPTURED_CHANGES";
      return json({ ok: true, mode: "preview", runId: fixtureRunId, manifestVersion: 1, manifestDigest: "a".repeat(64), workerIds: selected,
        workers: selected.map((workerId) => ({ workerId, worktree: true, branch: true, patch: true, sessionCapability: "continue_will_be_lost", risks: discardStrong ? ["UNCAPTURED_DIRTY_WORKTREE"] : [], blockedBy: [], retainedResources: discardPartial ? ["worktree", "branch", "patch"] : [] })), riskCodes: discardStrong ? ["UNCAPTURED_DIRTY_WORKTREE"] : [], unappliedFileCount: discardStrong ? null : 4, requiresStrongConfirmation: discardStrong,
        ...(!discardStrong || acknowledged ? { confirmationToken: "fixture-confirmation-token-with-sufficient-length", tokenExpiresAt: "2099-01-01T00:00:00Z" } : {}),
      });
    }
    serverRun = { ...serverRun, version: serverRun.version + 1, canContinue: false, status: discardPartial ? "recoverable" : "complete", recoveryState: discardPartial ? "manual_recovery_required" : undefined, workers: serverRun.workers.map((worker) => ({ ...worker, canContinue: false })) };
    return json({ ok: !discardPartial, complete: !discardPartial, mode: "commit", runId: fixtureRunId, workers: selected.map((workerId) => ({ workerId, success: !discardPartial, worktreeRemoved: !discardPartial, branchRemoved: !discardPartial, patchRemoved: !discardPartial, retainedResources: discardPartial ? ["worktree", "branch", "patch"] : [], reason: discardPartial ? "PRESERVED_FOR_RECOVERY" : "DISCARDED" })) }, discardPartial ? 207 : 200);
  }
  if (url.pathname.endsWith("/resume")) {
    serverRun = { ...serverRun, version: serverRun.version + 1, updatedAt: new Date().toISOString() };
    return json({ run: serverRun });
  }
  if (url.pathname === `/api/agent-runs/${fixtureRunId}`) {
    if (serverRun.canContinue && serverRun.continueExpiresAt && Date.parse(serverRun.continueExpiresAt) <= Date.now()) {
      serverRun = { ...serverRun, version: serverRun.version + 1, canContinue: false, workers: serverRun.workers.map((worker) => ({ ...worker, canContinue: false })) };
    }
    return json(serverRun);
  }
  return json({ error: "UNEXPECTED_FIXTURE_REQUEST", path: url.pathname }, 404);
};

const control = {
  requests, updateSnapshots,
  reset(options: { outcome?: ApplyOutcome; delayMs?: number; discardStrong?: boolean; discardPartial?: boolean; largePatch?: boolean; sharedPath?: boolean; status?: CollaborationRunSnapshot["status"]; ttlMs?: number; metadataMode?: "full" | "legacy" | "typechange" } = {}) {
    sessionStorage.removeItem(`deerhux:pending-apply:${fixtureRunId}`);
    metadataMode = options.metadataMode ?? "full";
    serverRun = initialRun();
    if (metadataMode === "legacy") serverRun.workers = serverRun.workers.map((worker) => ({ ...worker, changeStats: undefined }));
    outcome = options.outcome ?? "applied"; delayMs = options.delayMs ?? 0; discardStrong = options.discardStrong ?? false; discardPartial = options.discardPartial ?? true; largePatch = options.largePatch ?? false; sharedPath = options.sharedPath ?? false;
    if (options.status) serverRun.status = options.status;
    if (options.ttlMs !== undefined) {
      const expiresAt = new Date(Date.now() + options.ttlMs).toISOString();
      serverRun.continueExpiresAt = expiresAt;
      serverRun.workers = serverRun.workers.map((worker) => ({ ...worker, continueExpiresAt: expiresAt }));
    }
    if (sharedPath) serverRun.workers = serverRun.workers.map((worker) => ({ ...worker, changedFiles: ["src/shared.ts"], binaryFiles: [] }));
    requests.splice(0); updateSnapshots.splice(0); refreshView(serverRun);
  },
  configure(options: { outcome?: ApplyOutcome; delayMs?: number }) { if (options.outcome) outcome = options.outcome; if (options.delayMs !== undefined) delayMs = options.delayMs; },
  advanceVersion() { serverRun = { ...serverRun, version: serverRun.version + 1 }; refreshView(serverRun); },
  replaceCaptureSameVersion() { serverRun = { ...serverRun, workers: serverRun.workers.map((worker) => ({ ...worker, patchSha256: "e".repeat(64) })) }; refreshView(serverRun); },
  snapshot() { return serverRun; },
};
(window as unknown as { uiFixture: typeof control }).uiFixture = control;
function Fixture() {
  const [run, setRun] = useState(serverRun);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    refreshView = (next) => { setRun(structuredClone(next)); if (next.version === 1 && requests.length === 0) setGeneration((value) => value + 1); };
    return () => { refreshView = () => {}; };
  }, []);
  return <main data-fixture-generation={generation} style={{ maxWidth: 1000, margin: "24px auto", padding: 16 }}><h1 style={{ fontSize: 18 }}>Subagent review fixture</h1><SubagentRunCard key={generation} run={run} onRunUpdate={(next) => { updateSnapshots.push(next); setRun(next); }} /></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
