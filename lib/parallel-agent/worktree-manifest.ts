import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isWorktreeFileChange, type WorktreeFileChange } from "./worktree-file-metadata.ts";

export const WORKTREE_MANIFEST_VERSION = 1 as const;
/** Hard ceiling for a persisted/downloadable worktree patch. */
export const MAX_WORKTREE_PATCH_BYTES = 256 * 1024 * 1024;
export const MAX_WORKTREE_MANIFEST_BYTES = 8 * 1024 * 1024;

export const WORKTREE_MANIFEST_STATES = [
  "planning",
  "setting_up",
  "running",
  "captured",
  "applying",
  "applied",
  "preserved",
  "discarded",
  "cleanup_error",
] as const;

export type WorktreeManifestState = (typeof WORKTREE_MANIFEST_STATES)[number];

export const WORKTREE_WORKER_STATES = [
  "planned",
  "creating",
  "running",
  "stopped",
  "captured",
  "preserved",
  "removed",
  "cleanup_error",
] as const;

export type WorktreeWorkerState = (typeof WORKTREE_WORKER_STATES)[number];

export const APPLY_OUTCOMES = [
  "pending",
  "applied",
  "no_changes",
  "conflict",
  "precondition_failed",
  "error",
  "recovery_required",
] as const;

export type WorktreeApplyOutcome = (typeof APPLY_OUTCOMES)[number];

export const CLEANUP_INTENTS = ["automatic", "discard", "post_apply", "setup_rollback"] as const;
export type WorktreeCleanupIntent = (typeof CLEANUP_INTENTS)[number];

export const CLEANUP_ELIGIBILITIES = ["pending", "eligible", "ineligible", "manual_review"] as const;
export type WorktreeCleanupEligibility = (typeof CLEANUP_ELIGIBILITIES)[number];

export interface WorktreeCaptureV1 {
  changed: boolean;
  workerBranch: string;
  workerHead: string;
  patchPath: string | null;
  patchSha256: string | null;
  patchBytes: number | null;
  changedFiles: string[];
  binaryFiles: string[];
  /** Optional for historical captures; never infer it from old patch text. */
  fileChanges?: WorktreeFileChange[];
  capturedAt: string | null;
  captureError: string | null;
}

export interface WorktreeCleanupV1 {
  intent: WorktreeCleanupIntent;
  eligibility: WorktreeCleanupEligibility;
  checkedAt: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  reason: string;
}

export interface WorktreeEnvironmentV1 {
  mode: "none" | "hook";
  syntheticPaths: string[];
  syntheticIdentities: Array<{ path: string; kind: "file" | "directory"; dev: number; ino: number }>;
}

export interface WorktreeManifestWorkerV1 {
  workerId: string;
  displayName: string;
  index: number;
  worktreePath: string;
  agentCwd: string;
  branch: string;
  provider: string;
  state: WorktreeWorkerState;
  capture: WorktreeCaptureV1 | null;
  cleanup: WorktreeCleanupV1 | null;
  /** Optional for older manifests. Private preparation facts, never public UI data. */
  environment?: WorktreeEnvironmentV1;
}

export interface WorktreeApplyV1 {
  transactionId: string;
  requestedWorkerIds: string[];
  requestedFiles: string[] | null;
  appliedFiles: string[];
  startedAt: string;
  finishedAt: string | null;
  outcome: WorktreeApplyOutcome;
  errorCode: string | null;
}

export interface WorktreeManifestV1 {
  version: typeof WORKTREE_MANIFEST_VERSION;
  /** Format v1 manifests written before rollout metadata also use implementation v2. */
  implementationVersion?: 2;
  runId: string;
  instanceId: string;
  ownerPid: number;
  processStartIdentity: string;
  heartbeatAt: string;
  activeOperation: "setup" | "running" | "capture" | "continue" | "apply" | "cleanup" | null;
  repoRoot: string;
  gitCommonDir: string;
  sourceCwdRelative: string;
  baseCommit: string;
  state: WorktreeManifestState;
  workers: WorktreeManifestWorkerV1[];
  apply: WorktreeApplyV1 | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type ManifestReadResult =
  | { kind: "ok"; manifest: WorktreeManifestV1 }
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "io_error"; error: string; code?: string };

export type ManifestTransitionCaller = "planner" | "setup" | "runner" | "capture" | "apply" | "cleanup" | "recovery";

export interface ManifestTransitionRule {
  from: WorktreeManifestState;
  to: WorktreeManifestState;
  callers: readonly ManifestTransitionCaller[];
  persistence: "before_action" | "after_action";
}

export const WORKTREE_MANIFEST_TRANSITIONS: readonly ManifestTransitionRule[] = [
  { from: "planning", to: "setting_up", callers: ["setup"], persistence: "before_action" },
  { from: "planning", to: "preserved", callers: ["setup", "recovery"], persistence: "after_action" },
  { from: "setting_up", to: "running", callers: ["setup"], persistence: "after_action" },
  { from: "setting_up", to: "preserved", callers: ["setup", "recovery"], persistence: "after_action" },
  { from: "setting_up", to: "discarded", callers: ["cleanup"], persistence: "after_action" },
  { from: "setting_up", to: "cleanup_error", callers: ["setup", "cleanup", "recovery"], persistence: "after_action" },
  { from: "running", to: "captured", callers: ["capture"], persistence: "after_action" },
  { from: "running", to: "preserved", callers: ["setup", "runner", "capture", "recovery"], persistence: "after_action" },
  { from: "captured", to: "running", callers: ["runner"], persistence: "before_action" },
  { from: "captured", to: "applying", callers: ["apply"], persistence: "before_action" },
  { from: "captured", to: "preserved", callers: ["capture", "apply", "recovery"], persistence: "after_action" },
  { from: "captured", to: "discarded", callers: ["cleanup"], persistence: "after_action" },
  { from: "applying", to: "applied", callers: ["apply", "recovery"], persistence: "after_action" },
  { from: "applying", to: "captured", callers: ["apply", "recovery"], persistence: "after_action" },
  { from: "applying", to: "preserved", callers: ["apply", "recovery"], persistence: "after_action" },
  { from: "applied", to: "discarded", callers: ["cleanup"], persistence: "after_action" },
  { from: "preserved", to: "running", callers: ["runner", "recovery"], persistence: "before_action" },
  { from: "preserved", to: "captured", callers: ["capture", "recovery"], persistence: "after_action" },
  { from: "preserved", to: "applying", callers: ["apply", "recovery"], persistence: "before_action" },
  { from: "preserved", to: "discarded", callers: ["cleanup"], persistence: "after_action" },
  { from: "cleanup_error", to: "preserved", callers: ["cleanup", "recovery"], persistence: "after_action" },
  { from: "cleanup_error", to: "discarded", callers: ["cleanup", "recovery"], persistence: "after_action" },
] as const;

export interface ManifestTransitionOptions {
  caller: ManifestTransitionCaller;
  now: string;
  explicitDiscardConfirmed?: boolean;
  workersTerminated?: boolean;
  patchVerified?: boolean;
  manifestPersisted?: boolean;
}

export interface ManifestWriteFaults {
  beforeWrite?: () => void;
  afterWrite?: () => void;
  beforeRename?: () => void;
  afterRename?: () => void;
}

export interface ManifestDeletionDecision {
  eligible: boolean;
  reason: string;
}

export type ManifestValidationResult = { ok: true } | { ok: false; error: string };

function invalid(error: string): ManifestValidationResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): ManifestValidationResult {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? { ok: true }
    : invalid(`${field} has unexpected or missing fields`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\0")) return false;
  const normalized = path.normalize(value);
  return normalized === "." || (normalized !== ".." && !normalized.startsWith(`..${path.sep}`));
}

function validateStringArray(value: unknown, field: string, paths = false): ManifestValidationResult {
  if (!Array.isArray(value)) return invalid(`${field} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item) || (paths && !isRelativePath(item))) return invalid(`${field} contains an invalid value`);
    if (seen.has(item)) return invalid(`${field} contains a duplicate value`);
    seen.add(item);
  }
  return { ok: true };
}

function validateCapture(value: unknown, field: string): ManifestValidationResult {
  if (!isRecord(value)) return invalid(`${field} must be an object or null`);
  const keys = ["changed", "workerBranch", "workerHead", "patchPath", "patchSha256", "patchBytes", "changedFiles", "binaryFiles", "capturedAt", "captureError"];
  const shape = hasExactKeys(value, value.fileChanges === undefined ? keys : [...keys, "fileChanges"], field);
  if (!shape.ok) return shape;
  if (typeof value.changed !== "boolean") return invalid(`${field}.changed must be boolean`);
  if (!isNonEmptyString(value.workerBranch) || !isNonEmptyString(value.workerHead)) return invalid(`${field} worker audit is invalid`);
  if (value.patchPath !== null && (typeof value.patchPath !== "string" || !path.isAbsolute(value.patchPath))) return invalid(`${field}.patchPath must be absolute or null`);
  if (value.patchSha256 !== null && (typeof value.patchSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.patchSha256))) return invalid(`${field}.patchSha256 is invalid`);
  if (value.patchBytes !== null && (!Number.isSafeInteger(value.patchBytes)
    || (value.patchBytes as number) < 0
    || (value.patchBytes as number) > MAX_WORKTREE_PATCH_BYTES)) return invalid(`${field}.patchBytes is invalid`);
  const changed = validateStringArray(value.changedFiles, `${field}.changedFiles`, true);
  if (!changed.ok) return changed;
  const binary = validateStringArray(value.binaryFiles, `${field}.binaryFiles`, true);
  if (!binary.ok) return binary;
  if (value.fileChanges !== undefined) {
    const binaryPaths = new Set(value.binaryFiles as string[]);
    if (!Array.isArray(value.fileChanges) || value.fileChanges.length !== (value.changedFiles as string[]).length
      || value.fileChanges.some((file, index) => !isWorktreeFileChange(file) || file.path !== (value.changedFiles as string[])[index]
        || file.binary !== binaryPaths.has(file.path))) return invalid(`${field}.fileChanges is invalid`);
  }
  if (value.capturedAt !== null && !isIsoTime(value.capturedAt)) return invalid(`${field}.capturedAt is invalid`);
  if (value.captureError !== null && !isNonEmptyString(value.captureError)) return invalid(`${field}.captureError is invalid`);
  const artifactFields = [value.patchPath, value.patchSha256, value.patchBytes, value.capturedAt];
  const artifactCount = artifactFields.filter((item) => item !== null).length;
  if (artifactCount !== 0 && artifactCount !== artifactFields.length) return invalid(`${field} has a partial artifact`);
  if (artifactCount === 0 && value.captureError === null) return invalid(`${field} has neither an artifact nor an error`);
  return { ok: true };
}

function validateCleanup(value: unknown, field: string): ManifestValidationResult {
  if (!isRecord(value)) return invalid(`${field} must be an object or null`);
  const shape = hasExactKeys(value, ["intent", "eligibility", "checkedAt", "worktreeRemoved", "branchRemoved", "reason"], field);
  if (!shape.ok) return shape;
  if (!(CLEANUP_INTENTS as readonly unknown[]).includes(value.intent)) return invalid(`${field}.intent is invalid`);
  if (!(CLEANUP_ELIGIBILITIES as readonly unknown[]).includes(value.eligibility)) return invalid(`${field}.eligibility is invalid`);
  if (!isIsoTime(value.checkedAt)) return invalid(`${field}.checkedAt is invalid`);
  if (typeof value.worktreeRemoved !== "boolean" || typeof value.branchRemoved !== "boolean") return invalid(`${field} removal flags must be boolean`);
  if (!isNonEmptyString(value.reason)) return invalid(`${field}.reason is invalid`);
  return { ok: true };
}

function validateWorker(value: unknown, field: string): ManifestValidationResult {
  if (!isRecord(value)) return invalid(`${field} must be an object`);
  const keys = ["workerId", "displayName", "index", "worktreePath", "agentCwd", "branch", "provider", "state", "capture", "cleanup"];
  if (Object.hasOwn(value, "environment")) keys.push("environment");
  const shape = hasExactKeys(value, keys, field);
  if (!shape.ok) return shape;
  for (const key of ["workerId", "displayName", "branch", "provider"] as const) {
    if (!isNonEmptyString(value[key])) return invalid(`${field}.${key} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(value.index) || (value.index as number) < 0) return invalid(`${field}.index is invalid`);
  if (typeof value.worktreePath !== "string" || !path.isAbsolute(value.worktreePath)) return invalid(`${field}.worktreePath must be absolute`);
  if (typeof value.agentCwd !== "string" || !path.isAbsolute(value.agentCwd)) return invalid(`${field}.agentCwd must be absolute`);
  if (!(WORKTREE_WORKER_STATES as readonly unknown[]).includes(value.state)) return invalid(`${field}.state is invalid`);
  if (value.capture !== null) {
    const capture = validateCapture(value.capture, `${field}.capture`);
    if (!capture.ok) return capture;
  }
  if (value.cleanup !== null) {
    const cleanup = validateCleanup(value.cleanup, `${field}.cleanup`);
    if (!cleanup.ok) return cleanup;
  }
  if (value.environment !== undefined) {
    const environment = value.environment;
    if (!isRecord(environment)) return invalid(`${field}.environment must be an object`);
    const environmentShape = hasExactKeys(environment, ["mode", "syntheticPaths", "syntheticIdentities"], `${field}.environment`);
    if (!environmentShape.ok) return environmentShape;
    if (environment.mode !== "none" && environment.mode !== "hook") return invalid(`${field}.environment.mode is invalid`);
    if (!Array.isArray(environment.syntheticPaths) || environment.syntheticPaths.length > 256
      || !environment.syntheticPaths.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4096
        && !path.isAbsolute(item) && !item.includes("\\") && !/[\0\r\n]/.test(item)
        && item.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"))
      || new Set(environment.syntheticPaths).size !== environment.syntheticPaths.length) return invalid(`${field}.environment.syntheticPaths is invalid`);
    if (!Array.isArray(environment.syntheticIdentities) || environment.syntheticIdentities.length !== environment.syntheticPaths.length) return invalid(`${field}.environment.syntheticIdentities is invalid`);
    if (environment.mode === "none" && environment.syntheticPaths.length > 0) return invalid(`${field}.environment.none has synthetic paths`);
    for (let index = 0; index < environment.syntheticIdentities.length; index += 1) {
      const identity = environment.syntheticIdentities[index];
      if (!isRecord(identity)) return invalid(`${field}.environment identity must be an object`);
      const identityShape = hasExactKeys(identity, ["path", "kind", "dev", "ino"], `${field}.environment identity`);
      if (!identityShape.ok) return identityShape;
      if (identity.path !== environment.syntheticPaths[index] || (identity.kind !== "file" && identity.kind !== "directory")
        || !Number.isSafeInteger(identity.dev) || Number(identity.dev) < 0 || !Number.isSafeInteger(identity.ino) || Number(identity.ino) < 0) return invalid(`${field}.environment identity is invalid`);
    }
  }
  return { ok: true };
}

function validateApply(value: unknown): ManifestValidationResult {
  if (!isRecord(value)) return invalid("apply must be an object or null");
  const keys = ["transactionId", "requestedWorkerIds", "requestedFiles", "appliedFiles", "startedAt", "finishedAt", "outcome", "errorCode"];
  const shape = hasExactKeys(value, keys, "apply");
  if (!shape.ok) return shape;
  if (!isNonEmptyString(value.transactionId)) return invalid("apply.transactionId is invalid");
  const workerIds = validateStringArray(value.requestedWorkerIds, "apply.requestedWorkerIds");
  if (!workerIds.ok) return workerIds;
  if (value.requestedFiles !== null) {
    const files = validateStringArray(value.requestedFiles, "apply.requestedFiles", true);
    if (!files.ok) return files;
  }
  const appliedFiles = validateStringArray(value.appliedFiles, "apply.appliedFiles", true);
  if (!appliedFiles.ok) return appliedFiles;
  if (!isIsoTime(value.startedAt)) return invalid("apply.startedAt is invalid");
  if (value.finishedAt !== null && !isIsoTime(value.finishedAt)) return invalid("apply.finishedAt is invalid");
  if (!(APPLY_OUTCOMES as readonly unknown[]).includes(value.outcome)) return invalid("apply.outcome is invalid");
  if (value.errorCode !== null && !isNonEmptyString(value.errorCode)) return invalid("apply.errorCode is invalid");
  if (value.outcome === "pending" && value.finishedAt !== null) return invalid("pending apply cannot be finished");
  if (value.outcome !== "pending" && value.finishedAt === null) return invalid("settled apply must have finishedAt");
  return { ok: true };
}

export function validateWorktreeManifest(value: unknown): ManifestValidationResult {
  if (!isRecord(value)) return invalid("manifest must be an object");
  const keys = ["version", "runId", "instanceId", "ownerPid", "processStartIdentity", "heartbeatAt", "activeOperation", "repoRoot", "gitCommonDir", "sourceCwdRelative", "baseCommit", "state", "workers", "apply", "createdAt", "updatedAt", "expiresAt"];
  if (Object.hasOwn(value, "implementationVersion")) {
    if (value.implementationVersion !== 2) return invalid("unsupported worktree implementation version");
    keys.push("implementationVersion");
  }
  const shape = hasExactKeys(value, keys, "manifest");
  if (!shape.ok) return shape;
  if (value.version !== WORKTREE_MANIFEST_VERSION) return invalid(`unsupported manifest version: ${String(value.version)}`);
  for (const key of ["runId", "instanceId"] as const) {
    if (!isNonEmptyString(value[key])) return invalid(`${key} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) <= 0) return invalid("ownerPid is invalid");
  if (!isNonEmptyString(value.processStartIdentity)) return invalid("processStartIdentity is invalid");
  if (!isIsoTime(value.heartbeatAt)) return invalid("heartbeatAt is invalid");
  if (!(value.activeOperation === null || ["setup", "running", "capture", "continue", "apply", "cleanup"].includes(String(value.activeOperation)))) return invalid("activeOperation is invalid");
  for (const key of ["repoRoot", "gitCommonDir"] as const) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key])) return invalid(`${key} must be absolute`);
  }
  if (!isRelativePath(value.sourceCwdRelative)) return invalid("sourceCwdRelative must stay within repoRoot");
  if (typeof value.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)) return invalid("baseCommit is invalid");
  if (!(WORKTREE_MANIFEST_STATES as readonly unknown[]).includes(value.state)) return invalid("state is invalid");
  for (const key of ["createdAt", "updatedAt", "expiresAt"] as const) {
    if (!isIsoTime(value[key])) return invalid(`${key} is not a canonical ISO timestamp`);
  }
  if (Date.parse(value.createdAt as string) > Date.parse(value.updatedAt as string)) return invalid("updatedAt precedes createdAt");
  if (!Array.isArray(value.workers) || value.workers.length === 0) return invalid("workers must be a non-empty array");
  const workerIds = new Set<string>();
  const indexes = new Set<number>();
  for (let index = 0; index < value.workers.length; index += 1) {
    const result = validateWorker(value.workers[index], `workers[${index}]`);
    if (!result.ok) return result;
    const worker = value.workers[index] as unknown as WorktreeManifestWorkerV1;
    if (worker.index !== index) return invalid("workers must be ordered by contiguous index");
    if (workerIds.has(worker.workerId)) return invalid(`duplicate workerId: ${worker.workerId}`);
    if (indexes.has(worker.index)) return invalid(`duplicate worker index: ${worker.index}`);
    workerIds.add(worker.workerId);
    indexes.add(worker.index);
  }
  if (value.apply !== null) {
    const apply = validateApply(value.apply);
    if (!apply.ok) return apply;
    for (const workerId of (value.apply as unknown as WorktreeApplyV1).requestedWorkerIds) {
      if (!workerIds.has(workerId)) return invalid(`apply references unknown workerId: ${workerId}`);
    }
  }
  if (value.state === "captured" && value.workers.some((worker) => worker.capture === null)) {
    return invalid("captured manifest requires capture facts for every worker");
  }
  if (value.state === "applied") {
    const apply = value.apply as WorktreeApplyV1 | null;
    if (apply === null || apply.outcome !== "applied" || apply.finishedAt === null) {
      return invalid("applied manifest requires a settled applied transaction");
    }
    if (value.workers.some((worker) => worker.capture === null)) return invalid("applied manifest requires captured workers");
  }
  if (value.state === "discarded") {
    if (value.workers.some((worker) => worker.cleanup === null || !["discard", "setup_rollback"].includes(worker.cleanup.intent))) {
      return invalid("discarded manifest requires persisted discard cleanup intent");
    }
  }
  return { ok: true };
}

export function transitionWorktreeManifest(
  manifest: WorktreeManifestV1,
  to: WorktreeManifestState,
  options: ManifestTransitionOptions,
): WorktreeManifestV1 {
  const current = validateWorktreeManifest(manifest);
  if (!current.ok) throw new Error(`Cannot transition invalid manifest: ${current.error}`);
  if (!isIsoTime(options.now) || Date.parse(options.now) < Date.parse(manifest.updatedAt)) throw new Error("Transition time is invalid or moves backwards");
  const rule = WORKTREE_MANIFEST_TRANSITIONS.find((candidate) => candidate.from === manifest.state && candidate.to === to);
  if (!rule || !rule.callers.includes(options.caller)) throw new Error(`Illegal manifest transition: ${manifest.state} -> ${to} by ${options.caller}`);
  const setupRollback = manifest.state === "setting_up" && options.caller === "cleanup";
  if (to === "discarded" && !setupRollback && (!options.explicitDiscardConfirmed || !options.workersTerminated)) {
    throw new Error("Discard requires explicit confirmation and proof that workers terminated");
  }
  if (manifest.state === "captured" && to === "discarded" && (!options.patchVerified || !options.manifestPersisted)) {
    throw new Error("Captured cleanup requires a verified patch and persisted manifest");
  }
  return { ...manifest, state: to, updatedAt: options.now };
}

function assertNoSymlinkParents(filePath: string): void {
  assertPrivateWorktreeDirectory(path.dirname(filePath));
}

/** Check every lexical ancestor before opening managed data. macOS system aliases
 * are root-owned OS paths, not user-controlled links inside the managed tree. */
export function assertPrivateWorktreeDirectory(directory: string, requirePrivate = true): void {
  if (!path.isAbsolute(directory)) throw new Error("Unsafe managed directory");
  let cursor = path.resolve(directory);
  while (true) {
    const stat = fs.lstatSync(cursor);
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp"].includes(cursor)
      && stat.uid === 0 && stat.isSymbolicLink();
    if (stat.isSymbolicLink() && !systemAlias) throw new Error("Refusing symlink parent");
    if (!stat.isDirectory() && !systemAlias) throw new Error("Manifest parent is not a directory");
    if (!systemAlias && ((typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid())
      || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)))) {
      throw new Error("Unsafe managed directory ancestor");
    }
    if (cursor === path.resolve(directory)
      && ((typeof process.getuid === "function" && stat.uid !== process.getuid()) || (requirePrivate && (stat.mode & 0o777) !== 0o700))) {
      throw new Error("Unsafe managed directory permissions");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function sameManagedFileStat(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
    && before.mode === after.mode && before.uid === after.uid;
}

/** A fixed descriptor prevents leaf replacement from redirecting an in-progress read. */
export function openManagedWorktreeFile(filePath: string, maxBytes: number): { fd: number; stat: fs.Stats } {
  assertNoSymlinkParents(filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error("Refusing symlink manifest path");
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || stat.size > maxBytes) throw new Error("Unsafe managed file");
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!sameManagedFileStat(stat, fs.fstatSync(fd))) throw new Error("Managed file changed");
    assertNoSymlinkParents(filePath);
    if (!sameManagedFileStat(stat, fs.lstatSync(filePath))) throw new Error("Managed file changed");
    return { fd, stat };
  } catch (error) { fs.closeSync(fd); throw error; }
}

function inspectTarget(filePath: string): Buffer | null {
  let fd: number | undefined;
  try {
    const opened = openManagedWorktreeFile(filePath, MAX_WORKTREE_MANIFEST_BYTES);
    fd = opened.fd;
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_WORKTREE_MANIFEST_BYTES + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_WORKTREE_MANIFEST_BYTES) throw new Error("Managed manifest too large");
      chunks.push(chunk.subarray(0, count));
    }
    assertNoSymlinkParents(filePath);
    if (total !== opened.stat.size || !sameManagedFileStat(opened.stat, fs.fstatSync(fd))
      || !sameManagedFileStat(opened.stat, fs.lstatSync(filePath))) throw new Error("Managed file changed");
    return Buffer.concat(chunks, total);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function durableReplace(filePath: string, bytes: Buffer): void {
  const directory = path.dirname(filePath);
  const rollback = path.join(directory, `.${path.basename(filePath)}.rollback-${process.pid}-${Date.now()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(rollback, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(rollback, filePath);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(rollback); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function writeWorktreeManifestAtomic(
  filePath: string,
  manifest: WorktreeManifestV1,
  faults: ManifestWriteFaults = {},
): void {
  if (!path.isAbsolute(filePath)) throw new Error("Manifest path must be absolute");
  const validation = validateWorktreeManifest(manifest);
  if (!validation.ok) throw new Error(`Refusing to write invalid manifest: ${validation.error}`);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_WORKTREE_MANIFEST_BYTES) throw new Error("Managed manifest too large");
  assertNoSymlinkParents(filePath);
  const previous = inspectTarget(filePath);
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd: number | undefined;
  let renamed = false;
  try {
    faults.beforeWrite?.();
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    faults.afterWrite?.();
    faults.beforeRename?.();
    fs.renameSync(tempPath, filePath);
    renamed = true;
    faults.afterRename?.();
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (renamed && previous !== null) durableReplace(filePath, previous);
    if (renamed && previous === null) {
      try { fs.unlinkSync(filePath); } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; }
      const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function readWorktreeManifest(filePath: string): ManifestReadResult {
  try {
    if (!path.isAbsolute(filePath)) return { kind: "invalid", error: "Manifest path must be absolute" };
    assertNoSymlinkParents(filePath);
    const bytes = inspectTarget(filePath);
    if (bytes === null) return { kind: "missing" };
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    const validation = validateWorktreeManifest(parsed);
    return validation.ok
      ? { kind: "ok", manifest: parsed as WorktreeManifestV1 }
      : { kind: "invalid", error: validation.error };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (error instanceof SyntaxError || (error instanceof Error && /^(Refusing symlink|Unsafe managed|Managed file|Managed manifest)/.test(error.message))) {
      return { kind: "invalid", error: "Unsafe or invalid manifest" };
    }
    return { kind: "io_error", error: "Manifest read failed", code };
  }
}

export function readWorktreeManifestDigest(filePath: string): string | null {
  try {
    if (!path.isAbsolute(filePath)) return null;
    const bytes = inspectTarget(filePath);
    return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  } catch { return null; }
}

export function worktreeDeletionEligibility(result: ManifestReadResult, workerId: string): ManifestDeletionDecision {
  if (result.kind !== "ok") return { eligible: false, reason: `manifest_${result.kind}` };
  const validation = validateWorktreeManifest(result.manifest);
  if (!validation.ok) return { eligible: false, reason: "manifest_invalid" };
  if (result.manifest.state !== "applied" && result.manifest.state !== "discarded") {
    return { eligible: false, reason: `state_${result.manifest.state}` };
  }
  const worker = result.manifest.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker) return { eligible: false, reason: "worker_unknown" };
  if (worker.state === "removed" || worker.cleanup?.worktreeRemoved) return { eligible: false, reason: "worktree_already_removed" };
  if (worker.cleanup === null) return { eligible: false, reason: "cleanup_missing" };
  if (worker.cleanup.eligibility !== "eligible") return { eligible: false, reason: "cleanup_not_eligible" };
  if (["planned", "creating", "running"].includes(worker.state)) return { eligible: false, reason: "worker_not_terminated" };
  if (result.manifest.state === "applied" && worker.cleanup.intent !== "post_apply") {
    return { eligible: false, reason: "cleanup_intent_mismatch" };
  }
  if (result.manifest.state === "discarded" && worker.cleanup.intent !== "discard" && worker.cleanup.intent !== "setup_rollback") {
    return { eligible: false, reason: "cleanup_intent_mismatch" };
  }
  return { eligible: true, reason: "cleanup_authorized" };
}

export function manifestDeletionEligibility(result: ManifestReadResult): ManifestDeletionDecision {
  if (result.kind !== "ok") return { eligible: false, reason: `manifest_${result.kind}` };
  const { manifest } = result;
  const validation = validateWorktreeManifest(manifest);
  if (!validation.ok) return { eligible: false, reason: "manifest_invalid" };
  if (manifest.state !== "applied" && manifest.state !== "discarded") return { eligible: false, reason: `state_${manifest.state}` };
  if (manifest.workers.some((worker) => worker.state !== "removed")) return { eligible: false, reason: "worker_not_removed" };
  if (manifest.workers.some((worker) => worker.cleanup === null)) return { eligible: false, reason: "cleanup_missing" };
  if (manifest.workers.some((worker) => worker.cleanup?.eligibility !== "eligible")) return { eligible: false, reason: "cleanup_not_eligible" };
  if (manifest.workers.some((worker) => !worker.cleanup?.worktreeRemoved || !worker.cleanup.branchRemoved)) return { eligible: false, reason: "cleanup_incomplete" };
  return { eligible: true, reason: "all_resources_settled" };
}
