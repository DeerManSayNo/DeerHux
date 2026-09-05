import assert from "node:assert/strict";
import {
  ClientRequestError, DISCARD_CONFIRMATION, commitDiscard, createPendingApply, diffDownloadUrl,
  fetchDiffPatch, fetchDiffSummary, fetchRun, getRunCapabilities, previewDiscard, resumeWorker,
  runSelectionKey, submitApply, verifyPendingApply,
  type ApplyRequest, type ReviewFetch, type ReviewRun,
} from "../lib/subagent-review-client.ts";

const run: ReviewRun = {
  worktreeCapabilities: { implementation: "v2", review: true, apply: true, continue: true, discard: true },
  runId: "run/with spaces", version: 3, mode: "isolated_coding", status: "complete", captureState: "captured",
  message: "test", createdAt: "2026-01-01", updatedAt: "2026-01-01", canContinue: true,
  workers: [
    { workerId: "worker/one", name: "Duplicate", task: "test", status: "complete", patchSha256: "a".repeat(64), changedFiles: [" a.txt", "shared.txt"], canContinue: true },
    { workerId: "worker_two", name: "Duplicate", task: "test", status: "complete", patchSha256: "b".repeat(64), changedFiles: ["b.txt", "shared.txt"], canContinue: true },
  ],
};
type Call = { url: string; init?: RequestInit };
function mock(...responses: Array<Response | Error>): { fetcher: ReviewFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    }) as ReviewFetch,
  };
}
const response = (data: unknown, status = 200) => Response.json(data, { status });
const pending = createPendingApply(run, ["worker_two", "worker/one"], ["b.txt", " a.txt"], "original-key");
const payload: ApplyRequest = pending.payload;
const applied = { outcome: "applied", success: true, transactionId: payload.idempotencyKey, workerIds: ["worker/one"], files: [" a.txt"], runVersion: 5 };

assert.equal(getRunCapabilities(run).canApply, true);
assert.equal(getRunCapabilities(run).canReview, true);
assert.equal(getRunCapabilities(run).canContinue, true);
for (const status of ["setting_up", "running", "applying"] as const) {
  const capabilities = getRunCapabilities({ ...run, status });
  assert.equal(capabilities.busy, true);
  assert.equal(capabilities.canApply, false);
  assert.equal(capabilities.canContinue, false);
  assert.equal(capabilities.canDiscard, false);
}
for (const recoveryState of ["legacy_recovery_required", "manual_recovery_required"] as const) {
  const blocked = { ...run, recoveryState };
  assert.equal(getRunCapabilities(blocked).canApply, false);
  assert.equal(getRunCapabilities(blocked).canContinue, false);
  assert.equal(getRunCapabilities(blocked).canReview, true, "recovery keeps artifact review available");
  assert.throws(() => createPendingApply(blocked, ["worker/one"], [" a.txt"]), ClientRequestError);
}
assert.equal(getRunCapabilities({ ...run, mode: "analysis" }).canReview, false);
assert.equal(getRunCapabilities({ ...run, status: "applied" }).canApply, false);
assert.equal(getRunCapabilities({ ...run, applyState: "applied" }).canApply, false);
assert.equal(getRunCapabilities({ ...run, status: "aborted" }).canApply, false);
assert.equal(getRunCapabilities({ ...run, captureState: "failed" }).canApply, false);
assert.equal(getRunCapabilities({ ...run, continueExpiresAt: "2026-01-01" }, Date.parse("2026-02-01")).canContinue, false);
assert.equal(getRunCapabilities({ ...run, workers: run.workers.map((worker) => ({ ...worker, canContinue: false })) }).canContinue, false);
assert.throws(() => createPendingApply(run, [], [" a.txt"]), ClientRequestError);
assert.throws(() => createPendingApply(run, ["worker/one"], []), ClientRequestError);
assert.throws(() => createPendingApply(run, ["Duplicate"], [" a.txt"]), ClientRequestError);
assert.throws(() => createPendingApply(run, ["worker/one", "worker/one"], [" a.txt"]), ClientRequestError);
assert.throws(() => createPendingApply(run, ["worker/one"], [" a.txt", " a.txt"]), ClientRequestError);
assert.throws(() => createPendingApply(run, ["worker/one"], ["b.txt"]), ClientRequestError, "files must belong to selected workers");
const reverseIdsRun = { ...run, workers: [{ ...run.workers[0], workerId: "z-first" }, { ...run.workers[1], workerId: "a-second" }] };
assert.deepEqual(createPendingApply(reverseIdsRun, ["a-second", "z-first"], ["shared.txt"]).payload.workerIds, ["z-first", "a-second"], "worker ordering follows manifest projection, not IDs");
assert.equal(Object.isFrozen(pending), true);
assert.equal(Object.isFrozen(payload.files), true);
{
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalCrypto = globalThis.crypto;
  let randomValuesCalls = 0;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    getRandomValues: (bytes: Uint8Array) => { randomValuesCalls += 1; return originalCrypto.getRandomValues(bytes); },
  } });
  try {
    const lanRequest = createPendingApply(run, ["worker/one"], [" a.txt"]);
    assert.match(lanRequest.payload.idempotencyKey, /^[a-f0-9]{32}$/, "LAN HTTP fallback retains 128 random bits without randomUUID");
    assert.equal(randomValuesCalls, 1);
  } finally {
    if (originalCryptoDescriptor) Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
}
assert.notEqual(runSelectionKey(run), runSelectionKey({ ...run, version: 4 }));
assert.notEqual(runSelectionKey(run), runSelectionKey({ ...run, captureState: "preserved" }));
assert.notEqual(runSelectionKey(run), runSelectionKey({ ...run, workers: run.workers.map((worker) => ({ ...worker, patchSha256: "c".repeat(64) })) }));
assert.equal(runSelectionKey(run), runSelectionKey({ ...run, updatedAt: "2026-09-05", workers: [...run.workers].reverse() }));

{
  const transport = mock(response(run));
  assert.deepEqual(await fetchRun(run.runId, transport.fetcher), run);
  assert.equal(transport.calls[0].url, "/api/agent-runs/run%2Fwith%20spaces");
  assert.equal(transport.calls[0].init?.cache, "no-store");
  await assert.rejects(fetchRun(run.runId, mock(response({ ...run, runId: "foreign" })).fetcher), ClientRequestError);
}
{
  const summary = { runId: run.runId, workerId: "worker/one", changed: true, capturedAt: null,
    files: [{ path: " a.txt", type: "text", bytes: null }, { path: "logo.bin", type: "binary", bytes: null }],
    artifact: { available: true, bytes: 32, sha256: "a".repeat(64), inlineAvailable: true, containsBinary: true } };
  const transport = mock(response(summary), new Response("diff text"));
  const loaded = await fetchDiffSummary(run.runId, "worker/one", transport.fetcher);
  assert.equal(loaded.files[1].bytes, null, "unknown bytes stay unknown, not zero");
  assert.equal(transport.calls.length, 1, "summary does not prefetch patch");
  assert.equal(await fetchDiffPatch(run.runId, "worker/one", transport.fetcher), "diff text");
  assert.match(transport.calls[0].url, /workerId=worker%2Fone$/);
  assert.match(diffDownloadUrl(run.runId, "worker/one"), /format=download$/);
  await assert.rejects(fetchDiffPatch(run.runId, "worker/one", mock(response({ error: "DIFF_TOO_LARGE" }, 413)).fetcher), (error: unknown) => error instanceof ClientRequestError && error.httpStatus === 413);
  await assert.rejects(fetchDiffPatch(run.runId, "worker/one", mock(new Response("x".repeat(1024 * 1024 + 1))).fetcher), (error: unknown) => error instanceof ClientRequestError && error.code === "DIFF_TOO_LARGE", "actual streamed byte budget must reject even without Content-Length");
  await assert.rejects(fetchDiffSummary(run.runId, "worker/one", mock(response({ ...summary, files: [null] })).fetcher), ClientRequestError);
}
{
  const transport = mock(response(applied));
  const result = await submitApply(run.runId, payload, transport.fetcher);
  assert.equal(result.success, true);
  assert.deepEqual(result.files, [" a.txt"], "result files come from server, never requested selection");
  assert.deepEqual(JSON.parse(String(transport.calls[0].init?.body)), payload);
  assert.equal(run.workers[0].appliedFiles, undefined, "helper must not optimistically mutate run");
}
for (const [status, data, expected] of [
  [409, { outcome: "no_changes", success: false }, "no_changes"],
  [409, { outcome: "conflict", success: false, conflictFiles: ["shared.txt"] }, "conflict"],
  [409, { outcome: "recovery_required", success: false }, "recovery_required"],
  [412, { code: "APPLY_BASE_CHANGED" }, "precondition_failed"],
  [500, { error: "/private/path should never become a UI message", outcome: "error" }, "error"],
  [500, { error: "unclassified upstream failure" }, "unknown"],
  [502, { error: "gateway failure after forwarding request" }, "unknown"],
  [200, { success: true, files: ["requested.txt"] }, "unknown"],
  [200, { ...applied, transactionId: "different-key" }, "unknown"],
] as const) {
  const result = await submitApply(run.runId, payload, mock(response(data, status)).fetcher);
  assert.equal(result.httpStatus, status);
  assert.equal(result.outcome, expected);
  assert.equal(result.success, false);
  assert.deepEqual(result.files, []);
  assert.equal(JSON.stringify(result).includes("/private/path"), false);
}
{
  const before = JSON.stringify(pending);
  const offline = mock(new Error("disconnected after sending"));
  await assert.rejects(submitApply(run.runId, payload, offline.fetcher), (error: unknown) => error instanceof ClientRequestError && error.uncertain);
  assert.equal(JSON.stringify(pending), before, "network uncertainty retains original key and payload");
  const recheck = mock(response(run), response(applied));
  assert.equal((await verifyPendingApply(pending, recheck.fetcher)).result.outcome, "applied");
  assert.equal(recheck.calls.length, 2);
  assert.equal(recheck.calls[0].init?.method, undefined, "GET precedes any retry");
  assert.deepEqual(JSON.parse(String(recheck.calls[1].init?.body)), payload);
}
{
  const selfChanged = { ...run, version: 9, applyTransactionId: payload.idempotencyKey, applyState: "failed" as const };
  const transport = mock(response(selfChanged), response(applied));
  assert.equal((await verifyPendingApply(pending, transport.fetcher)).result.outcome, "applied", "same operation version changes may use original key with unchanged artifact");
  assert.deepEqual(JSON.parse(String(transport.calls[1].init?.body)), payload);
}
for (const [fresh, expected] of [
  [{ ...run, version: 4 }, "precondition_failed"],
  [{ ...run, recoveryState: "manual_recovery_required" }, "recovery_required"],
  [{ ...run, applyState: "recovery_required" }, "recovery_required"],
  [{ ...run, status: "applying", applyTransactionId: payload.idempotencyKey }, "pending"],
  [{ ...run, status: "applied", applyTransactionId: "foreign-key" }, "precondition_failed"],
  [{ ...run, version: 8, applyTransactionId: payload.idempotencyKey, workers: run.workers.map((worker) => ({ ...worker, patchSha256: "new-digest" })) }, "precondition_failed"],
] as const) {
  const transport = mock(response(fresh));
  assert.equal((await verifyPendingApply(pending, transport.fetcher)).result.outcome, expected);
  assert.equal(transport.calls.length, 1, "recovery, busy or changed selection must never issue a new mutation");
}
{
  const fresh = { ...run, version: 12, status: "applied", applyTransactionId: payload.idempotencyKey,
    workers: run.workers.map((worker, index) => ({ ...worker, appliedFiles: index === 0 ? [" a.txt"] : [] })) };
  const transport = mock(response(fresh));
  const verified = await verifyPendingApply(pending, transport.fetcher);
  assert.equal(verified.result.success, true);
  assert.deepEqual(verified.result.files, [" a.txt"]);
  assert.equal(transport.calls.length, 1, "verified applied snapshot does not POST again");
  const withoutFiles = await verifyPendingApply(pending, mock(response({ ...fresh, workers: run.workers })).fetcher);
  assert.deepEqual(withoutFiles.result.files, [], "missing exact appliedFiles never falls back to requested files");
}
{
  const transport = mock(response({ run }));
  assert.deepEqual(await resumeWorker(run.runId, "worker/one", "continue", transport.fetcher), run);
  assert.match(transport.calls[0].url, /workers\/worker%2Fone\/resume$/);
  assert.deepEqual(JSON.parse(String(transport.calls[0].init?.body)), { prompt: "continue" });
  await assert.rejects(resumeWorker(run.runId, "worker/one", undefined, mock(response({ errorCode: "CONTINUE_UNAVAILABLE" }, 409)).fetcher), ClientRequestError);
}
{
  const transport = mock(response({ mode: "preview", runId: run.runId, ok: true, workers: [], requiresStrongConfirmation: true, unappliedFileCount: null }));
  const preview = await previewDiscard(run.runId, ["worker/one"], DISCARD_CONFIRMATION, transport.fetcher);
  assert.equal(preview.unappliedFileCount, null);
  assert.equal(preview.requiresStrongConfirmation, true);
  assert.equal(JSON.parse(String(transport.calls[0].init?.body)).strongConfirmation, DISCARD_CONFIRMATION);
  await assert.rejects(previewDiscard(run.runId, [], undefined, transport.fetcher), ClientRequestError);
  const failed = await previewDiscard(run.runId, ["worker/one"], undefined, mock(response({ errorCode: "MANIFEST_UNAVAILABLE" }, 409)).fetcher);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.workers, [], "HTTP error still gives renderable preview shape");
}
{
  const worker = { workerId: "worker/one", success: true, retainedResources: [], worktreeRemoved: true, branchRemoved: true, patchRemoved: true, reason: "DISCARDED" };
  const token = "token".repeat(8);
  const complete = await commitDiscard(run.runId, token, mock(response({ ok: true, complete: true, workers: [worker] })).fetcher);
  assert.equal(complete.complete, true);
  for (const [status, data] of [
    [207, { ok: false, complete: false, workers: [{ ...worker, success: false, retainedResources: ["worktree", "patch"] }] }],
    [200, { ok: true, complete: true, workers: [{ ...worker, retainedResources: ["patch"] }] }],
    [200, { ok: true, complete: true, workers: [] }],
    [412, { errorCode: "MANIFEST_CHANGED" }],
    [500, { errorCode: "INTERNAL_ERROR" }],
  ] as const) {
    const partial = await commitDiscard(run.runId, token, mock(response(data, status)).fetcher);
    assert.equal(partial.complete, false);
    assert.equal(partial.ok, false, "partial or failed cleanup is never success");
  }
}
console.log("subagent review client tests passed");
