import type { CollaborationRunSnapshot } from "./parallel-agent/collaboration-types";
import { isWorktreeFileChange, type WorktreeFileChange } from "./parallel-agent/worktree-file-metadata.ts";

// Browser-only contract: do not import server runtime, filesystem, or orchestration.
export type ReviewRun = CollaborationRunSnapshot;
export type ReviewFetch = typeof fetch;
export const DISCARD_CONFIRMATION = "DISCARD_UNCAPTURED_CHANGES";

export interface DiffSummary {
  runId: string;
  workerId: string;
  changed: boolean;
  capturedAt: string | null;
  files: Array<Partial<Omit<WorktreeFileChange, "binary">> & { path: string; type: "text" | "binary"; bytes: number | null }>;
  artifact: { available: boolean; bytes: number; sha256: string; inlineAvailable: boolean; containsBinary: boolean } | null;
}

export interface ApplyRequest {
  readonly workerIds: readonly string[];
  readonly files: readonly string[];
  readonly idempotencyKey: string;
}

export interface PendingApply {
  readonly runId: string;
  readonly selectionKey: string;
  readonly payload: ApplyRequest;
}

export type ApplyOutcome = "applied" | "no_changes" | "conflict" | "precondition_failed" | "recovery_required" | "error" | "pending" | "unknown";
export interface ApplyResponse {
  httpStatus: number;
  outcome: ApplyOutcome;
  success: boolean;
  transactionId?: string;
  workerIds: string[];
  files: string[];
  conflicts: string[];
  errorCode?: string;
  requestId?: string;
  runVersion?: number;
}

export interface DiscardWorkerPreview {
  workerId: string;
  worktree: boolean;
  branch: boolean;
  patch: boolean;
  sessionCapability: "unavailable" | "continue_will_be_lost" | "history_only";
  risks: string[];
  blockedBy: string[];
  retainedResources: string[];
}
export interface DiscardPreview {
  httpStatus: number;
  ok: boolean;
  mode: "preview";
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  workerIds: string[];
  workers: DiscardWorkerPreview[];
  riskCodes: string[];
  unappliedFileCount: number | null;
  requiresStrongConfirmation: boolean;
  confirmationToken?: string;
  tokenExpiresAt?: string;
  errorCode?: string;
}
export interface DiscardResult {
  httpStatus: number;
  ok: boolean;
  complete: boolean;
  mode: "commit";
  runId: string;
  workers: Array<{ workerId: string; success: boolean; worktreeRemoved: boolean; branchRemoved: boolean; patchRemoved: boolean; retainedResources: string[]; reason: string }>;
  errorCode?: string;
}

export class ClientRequestError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly uncertain: boolean;
  constructor(code: string, httpStatus = 0, uncertain = false) {
    super(uncertain ? "请求结果暂不确定，请保留原请求并核验结果。" : "请求未完成，请刷新状态后重试。");
    this.name = "ClientRequestError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.uncertain = uncertain;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}
function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
}
function urlFor(runId: string): string {
  if (!runId || /[\0\r\n]/.test(runId)) throw new ClientRequestError("INVALID_RUN_ID", 400);
  return `/api/agent-runs/${encodeURIComponent(runId)}`;
}
function validSelection(values: readonly string[], maxItems: number, maxLength: number, trim: boolean): boolean {
  return values.length > 0 && values.length <= maxItems && new Set(values).size === values.length
    && values.every((value) => typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0") && (!trim || value === value.trim()));
}
function validateApply(payload: ApplyRequest): void {
  if (!validSelection(payload.workerIds, 5, 160, true) || !validSelection(payload.files, 10_000, 4_096, false)
    || !payload.idempotencyKey || payload.idempotencyKey.length > 160 || payload.idempotencyKey !== payload.idempotencyKey.trim()) {
    throw new ClientRequestError("APPLY_INVALID_SELECTION", 400);
  }
}
async function request(fetcher: ReviewFetch, url: string, body?: unknown): Promise<Response> {
  try {
    return await fetcher(url, body === undefined
      ? { cache: "no-store" }
      : { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ClientRequestError("NETWORK_UNAVAILABLE", 0, body !== undefined);
  }
}
async function json(response: Response, uncertain = false): Promise<Record<string, unknown>> {
  try { return record(await response.json()); }
  catch { throw new ClientRequestError("INVALID_RESPONSE", response.status, uncertain); }
}
function requireOk(response: Response, data: Record<string, unknown>): void {
  if (!response.ok) throw new ClientRequestError(safeCode(data.errorCode ?? data.code ?? data.error) ?? "REQUEST_FAILED", response.status);
}
function readRun(data: Record<string, unknown>, expectedRunId: string): ReviewRun {
  if (data.runId !== expectedRunId || !Number.isSafeInteger(data.version) || !Array.isArray(data.workers)
    || !data.workers.every((value) => { const worker = record(value); return typeof worker.workerId === "string" && typeof worker.name === "string" && typeof worker.task === "string"
      && ["pending", "running", "complete", "aborted", "error"].includes(String(worker.status)); })
    || !["setting_up", "running", "complete", "aborted", "error", "applying", "applied", "recoverable"].includes(String(data.status))
    || !["analysis", "isolated_coding"].includes(String(data.mode))) {
    throw new ClientRequestError("INVALID_RUN_RESPONSE");
  }
  return data as unknown as ReviewRun;
}

/** Selection is tied to durable facts, never telemetry timestamps or display names. */
export function runSelectionKey(run: ReviewRun): string {
  return JSON.stringify([run.runId, run.version, run.captureState ?? null,
    run.workers.map((worker) => [worker.workerId, worker.patchSha256 ?? null, worker.captureErrorCode ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

export function getRunCapabilities(run: ReviewRun, now = Date.now()) {
  const isolated = run.mode === "isolated_coding";
  const busy = ["setting_up", "running", "applying"].includes(run.status) || run.applyState === "applying";
  const recoveryRequired = Boolean(run.recoveryState) || run.applyState === "recovery_required";
  const alreadyApplied = run.status === "applied" || run.applyState === "applied";
  const expires = (value: string | undefined) => value !== undefined && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= now);
  const expired = expires(run.continueExpiresAt);
  const continueWorkerIds = isolated && run.worktreeCapabilities?.continue === true && !busy && !recoveryRequired && !expired && run.canContinue === true
    && !alreadyApplied && run.status !== "aborted"
    ? run.workers.filter((worker) => worker.canContinue === true && !expires(worker.continueExpiresAt) && !worker.appliedFiles?.length).map((worker) => worker.workerId)
    : [];
  const canReview = isolated && run.worktreeCapabilities?.review === true && run.workers.some((worker) => Boolean(worker.patchSha256));
  return {
    canReview,
    canApply: canReview && run.worktreeCapabilities?.apply === true && !busy && !recoveryRequired && !alreadyApplied && run.status !== "aborted"
      && run.captureState === "captured" && run.workers.some((worker) => Boolean(worker.patchSha256) && !worker.captureErrorCode && Boolean(worker.changedFiles?.length)),
    canDiscard: isolated && run.worktreeCapabilities?.discard === true && !busy,
    canContinue: continueWorkerIds.length > 0,
    continueWorkerIds, recoveryRequired, busy, expired,
  };
}

export async function fetchRun(runId: string, fetcher: ReviewFetch = fetch): Promise<ReviewRun> {
  const response = await request(fetcher, urlFor(runId));
  const data = await json(response);
  requireOk(response, data);
  return readRun(data, runId);
}
export function diffDownloadUrl(runId: string, workerId: string): string {
  return `${urlFor(runId)}/diff?workerId=${encodeURIComponent(workerId)}&format=download`;
}
export async function fetchDiffSummary(runId: string, workerId: string, fetcher: ReviewFetch = fetch): Promise<DiffSummary> {
  const response = await request(fetcher, `${urlFor(runId)}/diff?workerId=${encodeURIComponent(workerId)}`);
  const data = await json(response);
  requireOk(response, data);
  if (data.runId !== runId || data.workerId !== workerId || !Array.isArray(data.files)
    || !data.files.every((value) => { const file = record(value); return typeof file.path === "string" && file.path.length > 0 && file.path.length <= 4_096
      && ["text", "binary"].includes(String(file.type)) && (file.bytes === null || (Number.isSafeInteger(file.bytes) && Number(file.bytes) >= 0))
      && (file.changeKind === undefined || isWorktreeFileChange({ path: file.path, previousPath: file.previousPath, changeKind: file.changeKind,
        binary: file.type === "binary", oldBytes: file.oldBytes, newBytes: file.newBytes, addedLines: file.addedLines, deletedLines: file.deletedLines }) && file.bytes === file.newBytes); })) {
    throw new ClientRequestError("INVALID_DIFF_RESPONSE");
  }
  if (data.artifact !== null) {
    const artifact = record(data.artifact);
    if (typeof artifact.available !== "boolean" || typeof artifact.inlineAvailable !== "boolean" || typeof artifact.containsBinary !== "boolean"
      || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 0 || Number(artifact.bytes) > 256 * 1024 * 1024
      || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new ClientRequestError("INVALID_DIFF_RESPONSE");
  }
  return data as unknown as DiffSummary;
}
export async function fetchDiffPatch(runId: string, workerId: string, fetcher: ReviewFetch = fetch): Promise<string> {
  const response = await request(fetcher, `${urlFor(runId)}/diff?workerId=${encodeURIComponent(workerId)}&format=patch`);
  if (!response.ok) requireOk(response, await json(response));
  const limit = 1024 * 1024;
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel();
    throw new ClientRequestError("DIFF_TOO_LARGE", 413);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ClientRequestError("DIFF_TOO_LARGE", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof ClientRequestError) throw error;
    throw new ClientRequestError("DIFF_READ_FAILED", response.status);
  } finally { reader.releaseLock(); }
}

function createIdempotencyKey(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
  // LAN HTTP is not a secure context, so randomUUID may be absent even though
  // cryptographically secure getRandomValues remains available in the browser.
  if (typeof browserCrypto?.getRandomValues !== "function") throw new ClientRequestError("SECURE_RANDOM_UNAVAILABLE");
  return Array.from(browserCrypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPendingApply(run: ReviewRun, workerIds: readonly string[], files: readonly string[], idempotencyKey = createIdempotencyKey()): PendingApply {
  if (!getRunCapabilities(run).canApply) throw new ClientRequestError("APPLY_UNAVAILABLE", 409);
  if (!validSelection(workerIds, 5, 160, true) || !validSelection(files, 10_000, 4_096, false)) throw new ClientRequestError("APPLY_INVALID_SELECTION", 400);
  if (workerIds.some((id) => !run.workers.some((worker) => worker.workerId === id))) throw new ClientRequestError("APPLY_UNKNOWN_WORKER", 400);
  const selectedWorkers = run.workers.filter((worker) => workerIds.includes(worker.workerId));
  if (selectedWorkers.some((worker) => !worker.patchSha256 || worker.captureErrorCode)) throw new ClientRequestError("APPLY_CAPTURE_UNAVAILABLE", 409);
  const capturedFiles = new Set(selectedWorkers.flatMap((worker) => worker.changedFiles ?? []));
  if (files.some((file) => !capturedFiles.has(file))) throw new ClientRequestError("APPLY_UNKNOWN_FILE", 400);
  const payload = Object.freeze({ workerIds: Object.freeze(selectedWorkers.map((worker) => worker.workerId)), files: Object.freeze([...files].sort()), idempotencyKey });
  validateApply(payload);
  return Object.freeze({ runId: run.runId, selectionKey: runSelectionKey(run), payload });
}

/** Non-2xx business outcomes are data. Only an actual server applied outcome is success. */
export async function submitApply(runId: string, payload: ApplyRequest, fetcher: ReviewFetch = fetch): Promise<ApplyResponse> {
  validateApply(payload);
  const response = await request(fetcher, `${urlFor(runId)}/apply`, payload);
  const data = await json(response, true);
  const known: ApplyOutcome[] = ["applied", "no_changes", "conflict", "precondition_failed", "recovery_required", "error"];
  let outcome: ApplyOutcome = known.includes(data.outcome as ApplyOutcome) ? data.outcome as ApplyOutcome
    : response.ok || response.status >= 500 ? "unknown" : response.status === 412 ? "precondition_failed" : response.status === 409 ? "conflict" : "error";
  if (outcome === "applied" && (!response.ok || data.success !== true || data.transactionId !== payload.idempotencyKey
    || !Array.isArray(data.files) || strings(data.files).length !== data.files.length)) outcome = "unknown";
  const success = outcome === "applied";
  return {
    httpStatus: response.status, outcome, success,
    transactionId: typeof data.transactionId === "string" ? data.transactionId : undefined,
    workerIds: strings(data.workerIds), files: success ? strings(data.files) : [],
    conflicts: strings(data.conflicts ?? data.conflictFiles),
    errorCode: safeCode(data.errorCode ?? data.code), requestId: typeof data.requestId === "string" ? data.requestId : undefined,
    runVersion: Number.isSafeInteger(data.runVersion) ? data.runVersion as number : undefined,
  };
}

/** Never mint a replacement key after a possibly committed request. */
export async function verifyPendingApply(pending: PendingApply, fetcher: ReviewFetch = fetch): Promise<{ run: ReviewRun; result: ApplyResponse }> {
  validateApply(pending.payload);
  const run = await fetchRun(pending.runId, fetcher);
  const base = { httpStatus: 200, success: false, transactionId: pending.payload.idempotencyKey, workerIds: [] as string[], files: [] as string[], conflicts: [] as string[] };
  if (getRunCapabilities(run).recoveryRequired) return { run, result: { ...base, outcome: "recovery_required" } };
  if (run.status === "applying" || run.applyState === "applying") return { run, result: { ...base, outcome: "pending" } };
  if (run.status === "applied" || run.applyState === "applied") {
    if (run.applyTransactionId !== pending.payload.idempotencyKey) return { run, result: { ...base, outcome: "precondition_failed" } };
    const workers = run.workers.filter((worker) => pending.payload.workerIds.includes(worker.workerId));
    return { run, result: { ...base, outcome: "applied", success: true, workerIds: workers.map((worker) => worker.workerId), files: [...new Set(workers.flatMap((worker) => worker.appliedFiles ?? []))], runVersion: run.version } };
  }
  if (runSelectionKey(run) !== pending.selectionKey) {
    let sameCapturedSelection = false;
    try {
      const before = JSON.parse(pending.selectionKey) as unknown[];
      const after = JSON.parse(runSelectionKey(run)) as unknown[];
      sameCapturedSelection = JSON.stringify([before[0], before[2], before[3]]) === JSON.stringify([after[0], after[2], after[3]]);
    } catch { /* Invalid saved binding is never replayed. */ }
    if (run.applyTransactionId !== pending.payload.idempotencyKey || !sameCapturedSelection) {
      return { run, result: { ...base, outcome: "precondition_failed" } };
    }
  }
  return { run, result: await submitApply(pending.runId, pending.payload, fetcher) };
}

export async function resumeWorker(runId: string, workerId: string, prompt?: string, fetcher: ReviewFetch = fetch): Promise<ReviewRun> {
  const response = await request(fetcher, `${urlFor(runId)}/workers/${encodeURIComponent(workerId)}/resume`, prompt === undefined ? {} : { prompt });
  const data = await json(response, true);
  requireOk(response, data);
  return readRun(record(data.run), runId);
}
export async function previewDiscard(runId: string, workerIds: readonly string[], strongConfirmation?: string, fetcher: ReviewFetch = fetch): Promise<DiscardPreview> {
  if (!validSelection(workerIds, 32, 200, true) || (strongConfirmation !== undefined && strongConfirmation !== DISCARD_CONFIRMATION)) throw new ClientRequestError("DISCARD_INVALID_SELECTION", 400);
  const response = await request(fetcher, `${urlFor(runId)}/discard`, { mode: "preview", workerIds, ...(strongConfirmation === undefined ? {} : { strongConfirmation }) });
  const data = await json(response);
  return {
    httpStatus: response.status, ok: response.ok && data.ok === true,
    mode: "preview", runId, manifestVersion: typeof data.manifestVersion === "number" ? data.manifestVersion : 0,
    manifestDigest: typeof data.manifestDigest === "string" ? data.manifestDigest : "",
    workerIds: strings(data.workerIds), workers: Array.isArray(data.workers) ? data.workers as DiscardWorkerPreview[] : [],
    riskCodes: strings(data.riskCodes), unappliedFileCount: typeof data.unappliedFileCount === "number" ? data.unappliedFileCount : null,
    requiresStrongConfirmation: data.requiresStrongConfirmation === true,
    confirmationToken: typeof data.confirmationToken === "string" ? data.confirmationToken : undefined,
    tokenExpiresAt: typeof data.tokenExpiresAt === "string" ? data.tokenExpiresAt : undefined,
    errorCode: safeCode(data.errorCode),
  };
}
export async function commitDiscard(runId: string, confirmationToken: string, fetcher: ReviewFetch = fetch): Promise<DiscardResult> {
  if (confirmationToken.length < 20 || confirmationToken.length > 200) throw new ClientRequestError("DISCARD_TOKEN_INVALID", 400);
  const response = await request(fetcher, `${urlFor(runId)}/discard`, { mode: "commit", confirmationToken });
  const data = await json(response, true);
  const workers = Array.isArray(data.workers) ? data.workers as DiscardResult["workers"] : [];
  const complete = response.status === 200 && data.ok === true && data.complete === true && workers.length > 0
    && workers.every((worker) => worker.success === true && Array.isArray(worker.retainedResources) && worker.retainedResources.length === 0);
  return { ...data, runId, mode: "commit", workers, httpStatus: response.status, ok: complete, complete } as DiscardResult;
}
