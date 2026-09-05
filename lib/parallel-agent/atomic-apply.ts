import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { acquireGitLock } from "./git-lock.ts";
import { MAX_WORKTREE_PATCH_BYTES } from "./worktree-manifest.ts";
import { beginWorktreeOperation, hashWorktreeRepository, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";

const execFileAsync = promisify(execFile);

export const ATOMIC_APPLY_OUTCOMES = [
  "applied",
  "no_changes",
  "conflict",
  "precondition_failed",
  "error",
  "recovery_required",
] as const;

export type AtomicApplyOutcome = (typeof ATOMIC_APPLY_OUTCOMES)[number];
export type AtomicApplyPhase = "prepared" | "checked" | "applied" | "persisted";

export interface AtomicApplyFaults {
  afterPrepared?: () => void | Promise<void>;
  afterChecked?: () => void | Promise<void>;
  afterApplied?: () => void | Promise<void>;
  afterPersisted?: () => void | Promise<void>;
}

export interface AtomicApplyOptions {
  manifestPath: string;
  targetCwd: string;
  workerIds: readonly string[];
  files?: readonly string[];
  transactionId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  faults?: AtomicApplyFaults;
}

export interface AtomicApplyResult {
  success: boolean;
  outcome: AtomicApplyOutcome;
  transactionId: string;
  phase: AtomicApplyPhase | null;
  workerIds: string[];
  files: string[];
  errorCode: string | null;
  error: string | null;
  journalPath: string | null;
}

interface Capture {
  changed: boolean;
  patchPath: string | null;
  patchSha256: string | null;
  patchBytes: number | null;
  changedFiles: string[];
  captureError: string | null;
}

interface Worker {
  workerId: string;
  index: number;
  state: string;
  capture: Capture | null;
}

interface ApplyRecord {
  transactionId: string;
  requestedWorkerIds: string[];
  requestedFiles: string[] | null;
  appliedFiles: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  errorCode: string | null;
}

interface Manifest {
  runId: string;
  instanceId: string;
  repoRoot: string;
  gitCommonDir: string;
  baseCommit: string;
  state: string;
  workers: Worker[];
  apply: ApplyRecord | null;
  updatedAt: string;
  [key: string]: unknown;
}

interface Journal {
  version: 1;
  transactionId: string;
  idempotencyKey: string;
  runId: string;
  phase: AtomicApplyPhase;
  targetHead: string;
  workerIds: string[];
  files: string[];
  requestedFiles: string[] | null;
  patchSha256: string;
  patchPath: string;
  startedAt: string;
  updatedAt: string;
}

class ApplyFailure extends Error {
  readonly outcome: AtomicApplyOutcome;
  readonly code: string;

  constructor(
    outcome: AtomicApplyOutcome,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApplyFailure";
    this.outcome = outcome;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertManifest(value: unknown): asserts value is Manifest {
  if (!isRecord(value) || typeof value.runId !== "string" || typeof value.instanceId !== "string"
    || typeof value.repoRoot !== "string" || typeof value.gitCommonDir !== "string"
    || typeof value.baseCommit !== "string" || typeof value.state !== "string"
    || !Array.isArray(value.workers) || !(value.apply === null || isRecord(value.apply))) {
    throw new ApplyFailure("precondition_failed", "APPLY_MANIFEST_INVALID", "Apply manifest is invalid");
  }
  for (const worker of value.workers) {
    if (!isRecord(worker) || typeof worker.workerId !== "string" || !Number.isSafeInteger(worker.index)
      || typeof worker.state !== "string" || !(worker.capture === null || isRecord(worker.capture))) {
      throw new ApplyFailure("precondition_failed", "APPLY_MANIFEST_INVALID", "Apply manifest worker is invalid");
    }
  }
}

async function git(cwd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...options.env },
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 5 * 60_000,
      signal: options.signal,
    });
    return result.stdout as Buffer;
  } catch (error) {
    const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
      ? ((error as { stderr: Buffer }).stderr).toString("utf8")
      : String((error as { stderr?: unknown }).stderr ?? "");
    throw Object.assign(error as Error, { gitStderr: stderr });
  }
}

function normalizePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || path.isAbsolute(input)
    || /^[a-zA-Z]:[\\/]/.test(input) || /^[\\/]{2}/.test(input)) {
    throw new ApplyFailure("precondition_failed", "APPLY_FILE_INVALID", "Selected file path is invalid");
  }
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new ApplyFailure("precondition_failed", "APPLY_FILE_OUTSIDE_REPOSITORY", "Selected file escapes the repository");
  }
  return normalized;
}

function literalApplyPattern(file: string): string {
  return file.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("?", "\\?").replaceAll("[", "\\[");
}

function unique<T>(values: readonly T[], code: string, label: string): T[] {
  const result = [...values];
  if (new Set(result).size !== result.length) {
    throw new ApplyFailure("precondition_failed", code, `${label} contains duplicate values`);
  }
  return result;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function journalPathFor(manifestPath: string): string {
  return path.join(path.dirname(manifestPath), "atomic-apply-transaction.json");
}

function durableWrite(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function expectedTransactionPatchPath(manifestPath: string, transactionId: string): string {
  return path.join(path.dirname(manifestPath), `atomic-apply-${digest(Buffer.from(transactionId)).slice(0, 24)}.patch`);
}

function readJournal(filePath: string, manifest: Manifest): Journal | null {
  try {
    const value = readJson(filePath);
    if (!isRecord(value) || value.version !== 1 || typeof value.transactionId !== "string"
      || typeof value.idempotencyKey !== "string" || !["prepared", "checked", "applied", "persisted"].includes(String(value.phase))
      || value.runId !== manifest.runId || typeof value.targetHead !== "string"
      || !Array.isArray(value.workerIds) || value.workerIds.some((item) => typeof item !== "string")
      || !Array.isArray(value.files) || value.files.some((item) => typeof item !== "string")
      || !(value.requestedFiles === null || Array.isArray(value.requestedFiles) && value.requestedFiles.every((item) => typeof item === "string"))
      || typeof value.patchSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.patchSha256)
      || value.patchPath !== expectedTransactionPatchPath(path.join(path.dirname(filePath), "worktree-manifest.json"), value.transactionId)
      || path.dirname(value.patchPath as string) !== path.dirname(filePath)
      || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error("invalid transaction journal");
    }
    return value as unknown as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ApplyFailure("recovery_required", "APPLY_JOURNAL_INVALID", "Apply transaction journal requires recovery");
  }
}

function result(
  outcome: AtomicApplyOutcome,
  transactionId: string,
  phase: AtomicApplyPhase | null,
  workerIds: string[],
  files: string[],
  errorCode: string | null,
  error: string | null,
  journalPath: string | null,
): AtomicApplyResult {
  return { success: outcome === "applied", outcome, transactionId, phase, workerIds, files, errorCode, error, journalPath };
}

function publicApplyError(code: string): string {
  return `Apply failed (${code})`;
}

function requestMatches(journal: Journal, workerIds: readonly string[], files: readonly string[] | undefined): boolean {
  return JSON.stringify(journal.workerIds) === JSON.stringify(workerIds)
    && JSON.stringify(journal.requestedFiles) === JSON.stringify(files === undefined ? null : [...files].sort());
}

async function verifyRepository(manifest: Manifest, targetCwd: string, signal?: AbortSignal): Promise<{ root: string; commonDir: string; head: string }> {
  const [rootRaw, commonRaw, headRaw, status] = await Promise.all([
    git(targetCwd, ["rev-parse", "--show-toplevel"], { signal }),
    git(targetCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
    git(targetCwd, ["rev-parse", "--verify", "HEAD^{commit}"], { signal }),
    git(targetCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal }),
  ]);
  const root = fs.realpathSync(rootRaw.toString("utf8").trim());
  const commonDir = fs.realpathSync(commonRaw.toString("utf8").trim());
  const head = headRaw.toString("utf8").trim();
  if (root !== fs.realpathSync(manifest.repoRoot) || commonDir !== fs.realpathSync(manifest.gitCommonDir)) {
    throw new ApplyFailure("precondition_failed", "APPLY_REPOSITORY_MISMATCH", "Repository identity does not match the manifest");
  }
  if (head !== manifest.baseCommit) throw new ApplyFailure("precondition_failed", "APPLY_HEAD_CHANGED", "Repository HEAD changed since capture");
  if (status.length !== 0) throw new ApplyFailure("precondition_failed", "APPLY_REPOSITORY_DIRTY", "Repository index or worktree is not clean");
  return { root, commonDir, head };
}

async function verifyRepositoryIdentity(manifest: Manifest, targetCwd: string, signal?: AbortSignal): Promise<void> {
  try {
    const [rootRaw, commonRaw] = await Promise.all([
      git(targetCwd, ["rev-parse", "--show-toplevel"], { signal }),
      git(targetCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
    ]);
    const root = fs.realpathSync(rootRaw.toString("utf8").trim());
    const commonDir = fs.realpathSync(commonRaw.toString("utf8").trim());
    if (root === fs.realpathSync(manifest.repoRoot) && commonDir === fs.realpathSync(manifest.gitCommonDir)) return;
  } catch {
    // A missing/non-Git target is an identity mismatch, not an internal failure.
  }
  throw new ApplyFailure("precondition_failed", "APPLY_REPOSITORY_MISMATCH", "Repository identity does not match the manifest");
}

async function selectedWorkers(manifest: Manifest, requested: readonly string[]): Promise<Worker[]> {
  if (requested.length === 0) throw new ApplyFailure("precondition_failed", "APPLY_WORKERS_EMPTY", "At least one worker must be selected");
  const ids = unique(requested, "APPLY_WORKER_DUPLICATE", "workerIds");
  const workers = ids.map((id) => manifest.workers.find((worker) => worker.workerId === id));
  if (workers.some((worker) => worker === undefined)) throw new ApplyFailure("precondition_failed", "APPLY_WORKER_UNKNOWN", "Selected worker is unknown");
  const selected = workers as Worker[];
  if (selected.some((worker, index) => index > 0 && worker.index <= selected[index - 1].index)) {
    throw new ApplyFailure("precondition_failed", "APPLY_WORKER_ORDER_INVALID", "Workers must follow manifest order");
  }
  for (const worker of selected) {
    if (worker.state !== "captured" || !worker.capture || worker.capture.captureError
      || worker.capture.patchPath === null || worker.capture.patchSha256 === null || worker.capture.patchBytes === null) {
      throw new ApplyFailure("precondition_failed", "APPLY_WORKER_NOT_CAPTURED", `Worker ${worker.workerId} has no completed capture`);
    }
  }
  return selected;
}

function selectFiles(workers: Worker[], requested: readonly string[] | undefined): string[] {
  const available = new Set(workers.flatMap((worker) => worker.capture!.changedFiles.map(normalizePath)));
  if (requested === undefined) return [...available].sort();
  if (requested.length === 0) throw new ApplyFailure("no_changes", "APPLY_NO_CHANGES_SELECTED", "No files were selected");
  const files = unique(requested.map(normalizePath), "APPLY_FILE_DUPLICATE", "files");
  if (files.some((file) => !available.has(file))) {
    throw new ApplyFailure("precondition_failed", "APPLY_FILE_UNKNOWN", "Selected files are not a subset of worker changes");
  }
  return files.sort();
}

async function readVerifiedPatch(filePath: string, sha256: string, expectedBytes?: number, budget = MAX_WORKTREE_PATCH_BYTES): Promise<Buffer> {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0
      || before.size > Math.min(MAX_WORKTREE_PATCH_BYTES, budget)
      || expectedBytes !== undefined && before.size !== expectedBytes) {
      throw new ApplyFailure("precondition_failed", "APPLY_ARTIFACT_DIGEST_MISMATCH", "Artifact size is invalid or exceeds its bounded budget");
    }
    const bytes = Buffer.allocUnsafe(before.size);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, before.size - offset), offset);
      if (bytesRead <= 0) throw new ApplyFailure("precondition_failed", "APPLY_ARTIFACT_DIGEST_MISMATCH", "Artifact changed while reading");
      hash.update(bytes.subarray(offset, offset + bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || hash.digest("hex") !== sha256) {
      throw new ApplyFailure("precondition_failed", "APPLY_ARTIFACT_DIGEST_MISMATCH", "Artifact changed while reading");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyArtifacts(workers: Worker[]): Promise<Map<string, Buffer>> {
  const verified = new Map<string, Buffer>();
  let remainingBudget = MAX_WORKTREE_PATCH_BYTES;
  for (const worker of workers) {
    const capture = worker.capture!;
    let bytes: Buffer;
    try { bytes = await readVerifiedPatch(capture.patchPath!, capture.patchSha256!, capture.patchBytes!, remainingBudget); }
    catch (error) {
      if (error instanceof ApplyFailure) throw error;
      throw new ApplyFailure("precondition_failed", "APPLY_ARTIFACT_MISSING", `Artifact for ${worker.workerId} is unavailable`);
    }
    remainingBudget -= bytes.length;
    verified.set(worker.workerId, bytes);
  }
  return verified;
}

async function composePatch(root: string, head: string, patchPaths: string[], files: string[], temporaryIndex: string, signal?: AbortSignal): Promise<{ patch: Buffer; actualFiles: string[] }> {
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  await git(root, ["read-tree", head], { env, signal });
  const includes = files.map((file) => `--include=${literalApplyPattern(file)}`);
  for (const patchPath of patchPaths) {
    try {
      await git(root, ["apply", "--cached", "--index", "--binary", "--whitespace=nowarn", ...includes, patchPath], { env, signal });
    } catch (error) {
      throw new ApplyFailure("conflict", "APPLY_WORKER_CONFLICT", (error as { gitStderr?: string }).gitStderr || "Worker patches conflict");
    }
  }
  const patch = await git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", head], { env, signal });
  const names = await git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", head], { env, signal });
  return { patch, actualFiles: names.toString("utf8").split("\0").filter(Boolean).sort() };
}

function persistManifest(manifestPath: string, manifest: Manifest, apply: ApplyRecord, state: string, now: string): void {
  durableWrite(manifestPath, {
    ...manifest,
    state,
    apply,
    updatedAt: now,
    heartbeatAt: now,
    activeOperation: state === "applying" ? "apply" : null,
  });
}

async function recoverJournal(
  manifestPath: string,
  manifest: Manifest,
  journalPath: string,
  journal: Journal,
  transactionId: string,
  idempotencyKey: string,
  targetCwd: string,
  requestedWorkerIds: readonly string[],
  requestedFiles: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<{ kind: "manifest"; manifest: Manifest } | { kind: "result"; result: AtomicApplyResult }> {
  if ((journal.transactionId !== transactionId && journal.idempotencyKey !== idempotencyKey)
    || !requestMatches(journal, requestedWorkerIds, requestedFiles)) {
    throw new ApplyFailure("recovery_required", "APPLY_TRANSACTION_INCOMPLETE", `Another Apply transaction stopped at ${journal.phase}`);
  }
  if (journal.phase === "prepared") {
    await verifyRepository(manifest, targetCwd, signal);
    const recovered = { ...manifest, state: "captured", apply: null, updatedAt: new Date().toISOString() };
    durableWrite(manifestPath, recovered);
    fs.rmSync(journal.patchPath, { force: true });
    fs.rmSync(journalPath, { force: true });
    return { kind: "manifest", manifest: recovered };
  }
  if (journal.phase === "checked") {
    try {
      await verifyRepository(manifest, targetCwd, signal);
      const recovered = { ...manifest, state: "captured", apply: null, updatedAt: new Date().toISOString() };
      durableWrite(manifestPath, recovered);
      fs.rmSync(journal.patchPath, { force: true });
      fs.rmSync(journalPath, { force: true });
      return { kind: "manifest", manifest: recovered };
    } catch (error) {
      if (!(error instanceof ApplyFailure) || error.code !== "APPLY_REPOSITORY_DIRTY") {
        throw new ApplyFailure("recovery_required", "APPLY_MANUAL_RECOVERY_REQUIRED", "Checked transaction cannot be classified safely");
      }
    }
  }
  if (journal.phase === "checked" || journal.phase === "applied") {
    try { await readVerifiedPatch(journal.patchPath, journal.patchSha256); }
    catch { throw new ApplyFailure("recovery_required", "APPLY_HISTORY_UNVERIFIED", "Apply transaction artifact requires recovery"); }
    const root = fs.realpathSync((await git(targetCwd, ["rev-parse", "--show-toplevel"], { signal })).toString("utf8").trim());
    const commonDir = fs.realpathSync((await git(targetCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal })).toString("utf8").trim());
    const head = (await git(targetCwd, ["rev-parse", "--verify", "HEAD^{commit}"], { signal })).toString("utf8").trim();
    const [staged, unstaged, untracked, namesRaw] = await Promise.all([
      git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", head], { signal }),
      git(root, ["diff", "--binary", "--no-ext-diff"], { signal }),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { signal }),
      git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", head], { signal }),
    ]);
    const names = namesRaw.toString("utf8").split("\0").filter(Boolean).sort();
    const identityMatches = root === fs.realpathSync(manifest.repoRoot)
      && commonDir === fs.realpathSync(manifest.gitCommonDir)
      && head === journal.targetHead;
    if (!identityMatches || unstaged.length !== 0 || untracked.length !== 0
      || digest(staged) !== journal.patchSha256 || JSON.stringify(names) !== JSON.stringify(journal.files)) {
      throw new ApplyFailure("recovery_required", "APPLY_MANUAL_RECOVERY_REQUIRED", "Applied transaction cannot be verified safely");
    }
    const now = new Date().toISOString();
    const apply: ApplyRecord = {
      transactionId: journal.transactionId,
      requestedWorkerIds: journal.workerIds,
      requestedFiles: journal.requestedFiles,
      appliedFiles: names,
      startedAt: journal.startedAt,
      finishedAt: now,
      outcome: "applied",
      errorCode: null,
    };
    persistManifest(manifestPath, manifest, apply, "applied", now);
    durableWrite(journalPath, { ...journal, phase: "persisted", files: names, updatedAt: now });
    return { kind: "result", result: result("applied", journal.transactionId, "persisted", journal.workerIds, names, null, null, journalPath) };
  }
  throw new ApplyFailure("recovery_required", "APPLY_TRANSACTION_INCOMPLETE", `Apply transaction stopped at ${journal.phase}`);
}

/** Atomically applies captured worker artifacts to a clean target repository. */
export async function atomicApply(options: AtomicApplyOptions): Promise<AtomicApplyResult> {
  const operation = beginWorktreeOperation("apply", {
    transactionId: options.transactionId ?? options.idempotencyKey,
    repoHash: hashWorktreeRepository(options.targetCwd),
  });
  try {
    const result = await atomicApplyInternal(options, operation);
    operation.finish(result.outcome === "error" ? "failed" : result.outcome === "no_changes" ? "empty" : result.outcome, {
      reason: result.errorCode ? worktreeDiagnosticReason(result.errorCode) : "none",
      fileCount: result.files.length,
    });
    return result;
  } catch (error) {
    operation.finish(options.signal?.aborted ? "aborted" : "failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

async function atomicApplyInternal(options: AtomicApplyOptions, operation: ReturnType<typeof beginWorktreeOperation>): Promise<AtomicApplyResult> {
  const transactionId = options.transactionId ?? randomUUID();
  const idempotencyKey = options.idempotencyKey ?? transactionId;
  let phase: AtomicApplyPhase | null = null;
  let appliedWorkers: string[] = [];
  let appliedFiles: string[] = [];
  let journalPath: string | null = null;
  let release: (() => Promise<void>) | null = null;
  let temporaryDirectory: string | null = null;
  let mainChanged = false;
  let recoveringExistingJournal = false;
  let activeManifest: Manifest | null = null;

  try {
    if (!path.isAbsolute(options.manifestPath)) throw new ApplyFailure("precondition_failed", "APPLY_MANIFEST_PATH_INVALID", "manifestPath must be absolute");
    if (!transactionId || !idempotencyKey) throw new ApplyFailure("precondition_failed", "APPLY_TRANSACTION_INVALID", "A transaction or idempotency key is required");
    const initial = readJson(options.manifestPath);
    assertManifest(initial);
    const commonDir = fs.realpathSync(initial.gitCommonDir);
    const lock = await acquireGitLock({
      commonDir,
      operation: `atomic_apply:${transactionId}`,
      signal: options.signal,
      timeoutMs: options.lockTimeoutMs ?? 30_000,
      staleMs: options.staleLockMs,
      instanceId: initial.instanceId,
    });
    release = async () => {
      if (!(await lock.release())) throw new Error("Apply lock ownership changed before release");
    };

    const value = readJson(options.manifestPath);
    assertManifest(value);
    let manifest = value;
    activeManifest = manifest;
    journalPath = journalPathFor(options.manifestPath);
    const existingJournal = readJournal(journalPath, manifest);
    if (manifest.state === "applied" && manifest.apply?.outcome === "applied") {
      await verifyRepositoryIdentity(manifest, options.targetCwd, options.signal);
      if (!existingJournal || !["applied", "persisted"].includes(existingJournal.phase)
        || existingJournal.transactionId !== manifest.apply.transactionId
        || existingJournal.targetHead !== manifest.baseCommit
        || existingJournal.startedAt !== manifest.apply.startedAt) {
        throw new ApplyFailure("recovery_required", "APPLY_HISTORY_UNVERIFIED", "Applied transaction history requires recovery");
      }
      if (existingJournal.transactionId !== transactionId && existingJournal.idempotencyKey !== idempotencyKey) {
        throw new ApplyFailure("precondition_failed", "APPLY_ALREADY_APPLIED", "Run was already applied by another transaction");
      }
      if (!requestMatches(existingJournal, options.workerIds, options.files)
        || JSON.stringify(manifest.apply.requestedWorkerIds) !== JSON.stringify(existingJournal.workerIds)
        || JSON.stringify(manifest.apply.requestedFiles) !== JSON.stringify(existingJournal.requestedFiles)
        || JSON.stringify(manifest.apply.appliedFiles) !== JSON.stringify(existingJournal.files)) {
        throw new ApplyFailure("precondition_failed", "APPLY_IDEMPOTENCY_MISMATCH", "Idempotency key was used for a different request");
      }
      if (existingJournal.phase !== "persisted") {
        // The manifest and journal are separate durable writes. A crash between them
        // must verify the actual index/worktree before completing the historical record.
        recoveringExistingJournal = true;
        const recovered = await recoverJournal(
          options.manifestPath, manifest, journalPath, existingJournal,
          transactionId, idempotencyKey, options.targetCwd,
          options.workerIds, options.files, options.signal,
        );
        if (recovered.kind === "result") return recovered.result;
        throw new ApplyFailure("recovery_required", "APPLY_HISTORY_UNVERIFIED", "Applied transaction history requires recovery");
      }
      try { await readVerifiedPatch(existingJournal.patchPath, existingJournal.patchSha256); }
      catch { throw new ApplyFailure("recovery_required", "APPLY_HISTORY_UNVERIFIED", "Applied transaction history requires recovery"); }
      return result("applied", manifest.apply.transactionId, "persisted", manifest.apply.requestedWorkerIds, manifest.apply.appliedFiles, null, null, journalPath);
    }
    if (existingJournal) {
      recoveringExistingJournal = true;
      const recovered = await recoverJournal(
        options.manifestPath,
        manifest,
        journalPath,
        existingJournal,
        transactionId,
        idempotencyKey,
        options.targetCwd,
        options.workerIds,
        options.files,
        options.signal,
      );
      if (recovered.kind === "result") return recovered.result;
      recoveringExistingJournal = false;
      manifest = recovered.manifest;
      activeManifest = manifest;
    }
    if (manifest.state !== "captured") throw new ApplyFailure("precondition_failed", "APPLY_MANIFEST_NOT_CAPTURED", "Manifest is not captured");

    const repository = await verifyRepository(manifest, options.targetCwd, options.signal);
    const workers = await selectedWorkers(manifest, options.workerIds);
    const files = selectFiles(workers, options.files);
    appliedFiles = files;
    const verifiedArtifacts = await verifyArtifacts(workers);
    appliedWorkers = workers.map((worker) => worker.workerId);
    if (files.length === 0) throw new ApplyFailure("no_changes", "APPLY_NO_CHANGES", "Selected workers contain no changes");

    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-atomic-apply-"));
    const temporaryIndex = path.join(temporaryDirectory, "index");
    const mergedPatchPath = path.join(temporaryDirectory, "merged.patch");
    const verifiedPatchPaths = workers.map((worker, index) => {
      const verifiedPath = path.join(temporaryDirectory!, `worker-${index}.patch`);
      fs.writeFileSync(verifiedPath, verifiedArtifacts.get(worker.workerId)!, { mode: 0o600 });
      return verifiedPath;
    });
    const composed = await composePatch(repository.root, repository.head, verifiedPatchPaths, files, temporaryIndex, options.signal);
    if (composed.patch.length > MAX_WORKTREE_PATCH_BYTES) throw new ApplyFailure("precondition_failed", "APPLY_ARTIFACT_DIGEST_MISMATCH", "Combined artifact exceeds its bounded budget");
    appliedFiles = composed.actualFiles;
    if (composed.patch.length === 0 || appliedFiles.length === 0) throw new ApplyFailure("no_changes", "APPLY_NO_CHANGES", "Combined patch contains no changes");
    fs.writeFileSync(mergedPatchPath, composed.patch, { mode: 0o600 });

    const startedAt = new Date().toISOString();
    const pending: ApplyRecord = {
      transactionId,
      requestedWorkerIds: appliedWorkers,
      requestedFiles: options.files === undefined ? null : [...options.files].sort(),
      appliedFiles: [],
      startedAt,
      finishedAt: null,
      outcome: "pending",
      errorCode: null,
    };
    const journal: Journal = {
      version: 1,
      transactionId,
      idempotencyKey,
      runId: manifest.runId,
      phase: "prepared",
      targetHead: repository.head,
      workerIds: appliedWorkers,
      files: appliedFiles,
      requestedFiles: options.files === undefined ? null : [...options.files].sort(),
      patchSha256: digest(composed.patch),
      patchPath: expectedTransactionPatchPath(options.manifestPath, transactionId),
      startedAt,
      updatedAt: startedAt,
    };
    fs.copyFileSync(mergedPatchPath, journal.patchPath, fs.constants.COPYFILE_EXCL);
    durableWrite(journalPath, journal);
    phase = "prepared";
    persistManifest(options.manifestPath, manifest, pending, "applying", startedAt);
    await options.faults?.afterPrepared?.();

    try { await git(repository.root, ["apply", "--check", "--index", "--binary", journal.patchPath], { signal: options.signal }); }
    catch (error) { throw new ApplyFailure("conflict", "APPLY_FINAL_CHECK_FAILED", (error as { gitStderr?: string }).gitStderr || "Final patch check failed"); }
    phase = "checked";
    operation.checkpoint("checked", { fileCount: appliedFiles.length, patchBytes: composed.patch.length });
    durableWrite(journalPath, { ...journal, phase, updatedAt: new Date().toISOString() });
    await options.faults?.afterChecked?.();

    await git(repository.root, ["apply", "--index", "--binary", journal.patchPath], { signal: options.signal });
    mainChanged = true;
    phase = "applied";
    durableWrite(journalPath, { ...journal, phase, updatedAt: new Date().toISOString() });
    await options.faults?.afterApplied?.();

    const actualRaw = await git(repository.root, ["diff", "--cached", "--name-only", "-z", "--no-renames", repository.head], { signal: options.signal });
    const actualFiles = actualRaw.toString("utf8").split("\0").filter(Boolean).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(appliedFiles)) {
      throw new ApplyFailure("recovery_required", "APPLY_FILES_MISMATCH", "Applied files differ from the prepared transaction");
    }
    const finishedAt = new Date().toISOString();
    persistManifest(options.manifestPath, manifest, { ...pending, appliedFiles: actualFiles, finishedAt, outcome: "applied" }, "applied", finishedAt);
    phase = "persisted";
    durableWrite(journalPath, { ...journal, phase, files: actualFiles, updatedAt: finishedAt });
    appliedFiles = actualFiles;
    await options.faults?.afterPersisted?.();
    return result("applied", transactionId, phase, appliedWorkers, appliedFiles, null, null, journalPath);
  } catch (error) {
    const failure = error instanceof ApplyFailure
      ? error
      : new ApplyFailure(mainChanged || recoveringExistingJournal ? "recovery_required" : "error", mainChanged || recoveringExistingJournal ? "APPLY_MANUAL_RECOVERY_REQUIRED" : "APPLY_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
    const checkedRepositoryUncertain = phase === "checked" && (() => {
      try { return execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: options.targetCwd, encoding: "buffer" }); }
      catch { return null; }
    })();
    if (checkedRepositoryUncertain) {
      try { mainChanged = ((await checkedRepositoryUncertain).stdout as Buffer).length > 0; } catch { mainChanged = true; }
    }
    let cleanupUncertain = false;
    if (!mainChanged && activeManifest && journalPath && (phase === "prepared" || phase === "checked")) {
      try {
        const status = await git(options.targetCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal: options.signal });
        if (status.length !== 0) cleanupUncertain = true;
        else {
          const journal = readJournal(journalPath, activeManifest);
          if (!journal) cleanupUncertain = true;
          else {
            durableWrite(options.manifestPath, { ...activeManifest, state: "captured", apply: null, updatedAt: new Date().toISOString() });
            fs.rmSync(journal.patchPath, { force: true });
            fs.rmSync(journalPath, { force: true });
          }
        }
      } catch {
        cleanupUncertain = true;
      }
    }
    const outcome = (mainChanged || cleanupUncertain) && failure.outcome !== "applied" ? "recovery_required" : failure.outcome;
    const code = mainChanged && outcome === "recovery_required" && failure.code !== "APPLY_FILES_MISMATCH"
      ? "APPLY_MANUAL_RECOVERY_REQUIRED"
      : failure.code;
    return result(outcome, transactionId, phase, appliedWorkers, appliedFiles, code, publicApplyError(code), journalPath);
  } finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    if (release) {
      try { await release(); } catch { /* The completed transaction remains journaled. */ }
    }
  }
}

export const applyCapturedArtifactsAtomically = atomicApply;

export async function recoverPendingAtomicApply(
  manifestPath: string,
  targetCwd: string,
  signal?: AbortSignal,
): Promise<AtomicApplyResult | null> {
  const value = readJson(manifestPath);
  assertManifest(value);
  const journal = readJournal(journalPathFor(manifestPath), value);
  if (!journal) return null;
  return atomicApply({
    manifestPath,
    targetCwd,
    workerIds: journal.workerIds,
    files: journal.requestedFiles ?? undefined,
    transactionId: journal.transactionId,
    idempotencyKey: journal.idempotencyKey,
    signal,
  });
}
