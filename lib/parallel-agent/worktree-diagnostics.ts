import { createHash, randomUUID } from "node:crypto";

export const WORKTREE_OPERATION_KINDS = ["setup", "capture", "apply", "cleanup", "continue"] as const;
export type WorktreeOperationKind = typeof WORKTREE_OPERATION_KINDS[number];
export const WORKTREE_OPERATION_OUTCOMES = ["completed", "empty", "checked", "applied", "conflict", "precondition_failed", "recovery_required", "planned", "removed", "preserved", "partial", "failed", "aborted"] as const;
export type WorktreeOperationOutcome = typeof WORKTREE_OPERATION_OUTCOMES[number];
export const WORKTREE_DIAGNOSTIC_REASONS = ["none", "dirty_uncaptured", "manifest_invalid", "manifest_unsettled", "owner_active", "continue_ttl_active", "artifact_audit_retained", "explicit_discard_required", "creation_untrusted", "digest_mismatch", "unsafe_path", "git_failed", "persistence_failed", "cancelled", "timeout", "recovery_required", "unknown"] as const;
export type WorktreeDiagnosticReason = typeof WORKTREE_DIAGNOSTIC_REASONS[number];
export const WORKTREE_DIAGNOSTIC_THRESHOLDS = Object.freeze({
  maxEvents: 200, maxInventoryEntries: 256, maxManifestBytes: 1024 * 1024, maxInventoryBytes: 16 * 1024 * 1024,
  oldestAgeWarningMs: 7 * 24 * 60 * 60 * 1000, patchDeclaredBytesWarning: 1024 * 1024 * 1024, preservedWorktreesWarning: 32,
});
const ALLOWED_OUTCOMES: Record<WorktreeOperationKind, readonly WorktreeOperationOutcome[]> = {
  setup: ["completed", "preserved", "partial", "failed", "aborted"],
  capture: ["completed", "empty", "preserved", "failed", "aborted"],
  apply: ["checked", "applied", "empty", "conflict", "precondition_failed", "recovery_required", "failed", "aborted"],
  cleanup: ["planned", "removed", "preserved", "partial", "failed", "aborted"],
  continue: ["completed", "preserved", "recovery_required", "failed", "aborted"],
};
const FAILED_OUTCOMES = new Set<WorktreeOperationOutcome>(["failed", "aborted", "conflict", "precondition_failed", "recovery_required", "partial"]);
const CODE_REASONS: Readonly<Record<string, WorktreeDiagnosticReason>> = Object.freeze({
  DIRTY_UNCAPTURED: "dirty_uncaptured", UNCAPTURED_DIRTY_WORKTREE: "dirty_uncaptured", WORKTREE_CHANGED_AFTER_CAPTURE: "dirty_uncaptured",
  MANIFEST_UNAVAILABLE: "manifest_invalid", MANIFEST_INVALID: "manifest_invalid", ARTIFACT_MANIFEST_INVALID: "manifest_invalid", APPLY_MANIFEST_INVALID: "manifest_invalid",
  OWNER_ACTIVE: "owner_active", LEASE_ACTIVE: "owner_active", APPLY_TRANSACTION_ACTIVE: "owner_active",
  ARTIFACT_DIGEST_MISMATCH: "digest_mismatch", APPLY_ARTIFACT_DIGEST_MISMATCH: "digest_mismatch", DIFF_ARTIFACT_REJECTED: "digest_mismatch",
  ENV_SYNTHETIC_INVALID: "unsafe_path", ENV_HOOK_INVALID: "unsafe_path", ENV_HOOK_CHANGED: "unsafe_path", ENV_CONFIG_INVALID: "unsafe_path",
  APPLY_FILE_OUTSIDE_REPOSITORY: "unsafe_path", APPLY_FILE_INVALID: "unsafe_path", APPLY_MANIFEST_PATH_INVALID: "unsafe_path",
  ENV_REPOSITORY_MISMATCH: "unsafe_path", APPLY_REPOSITORY_MISMATCH: "unsafe_path", ARTIFACT_REPOSITORY_MISMATCH: "unsafe_path",
  GIT_EXIT_NONZERO: "git_failed", GIT_NOT_REPOSITORY: "git_failed", GIT_REF_NOT_FOUND: "git_failed", GIT_LOCK_CONFLICT: "git_failed",
  GIT_PATCH_CONFLICT: "git_failed", GIT_SPAWN_FAILED: "git_failed", ARTIFACT_GIT_FAILED: "git_failed",
  ARTIFACT_MANIFEST_WRITE_FAILED: "persistence_failed", ARTIFACT_PATCH_WRITE_FAILED: "persistence_failed", APPLY_STATE_PERSISTENCE_FAILED: "persistence_failed",
  WORKTREE_CLEANUP_STATE_PERSISTENCE_FAILED: "persistence_failed", CONTINUE_STATE_PERSISTENCE_FAILED: "persistence_failed",
  ENV_ABORTED: "cancelled", GIT_ABORTED: "cancelled", ABORTED: "cancelled",
  ENV_HOOK_TIMEOUT: "timeout", GIT_TIMEOUT: "timeout", GIT_READ_TIMEOUT: "timeout", GIT_WRITE_TIMEOUT: "timeout",
  APPLY_MANUAL_RECOVERY_REQUIRED: "recovery_required", APPLY_HISTORY_UNVERIFIED: "recovery_required", PRESERVED_FOR_RECOVERY: "recovery_required",
  manifest_not_settled: "manifest_unsettled", foreign_owner_active: "owner_active", owner_operation_active: "owner_active",
  continue_ttl_active: "continue_ttl_active", artifact_audit_retained: "artifact_audit_retained",
  worktree_requires_explicit_discard: "explicit_discard_required", untrusted_creation_identity: "creation_untrusted",
  artifact_invalid: "digest_mismatch", worktree_changed_after_capture: "dirty_uncaptured",
  worktree_dirty_without_artifact: "dirty_uncaptured", branch_ahead_without_artifact: "dirty_uncaptured",
  repo_identity_mismatch: "unsafe_path", unsafe_path: "unsafe_path", git_facts_unavailable: "git_failed",
});

export interface WorktreeOperationContext { runId?: string; workerId?: string; transactionId?: string; repoHash?: string }
export interface WorktreeOperationDetails {
  reason?: WorktreeDiagnosticReason; patchBytes?: number; fileCount?: number; binaryFileCount?: number;
  worktreeRemoved?: boolean; branchRemoved?: boolean;
  preservedCount?: number; removedWorktreeCount?: number; removedBranchCount?: number;
}
interface Measurement { count: number; total: number; max: number }
export interface WorktreeOperationMetrics {
  started: number; terminal: number; completed: number; failed: number; preserved: number; binaryPatches: number;
  /** Process-lifetime success rate and bounded recent-duration P95 (at most 200 terminal samples). */
  successRate: number; durationP95Ms: number;
  fileCountTotal: number; binaryFileCountTotal: number; worktreesRemoved: number; branchesRemoved: number;
  outcomes: Record<WorktreeOperationOutcome, number>; durationMs: Measurement; patchBytes: Measurement;
}
export interface WorktreeDiagnosticEvent extends WorktreeOperationContext, WorktreeOperationDetails {
  operationId: string; kind: WorktreeOperationKind; phase: "started" | "checkpoint" | "decision" | "terminal"; timestamp: number;
  outcome?: WorktreeOperationOutcome; durationMs?: number;
  facts?: { repoMatches: boolean; pathSafe: boolean; worktreeExists: boolean; worktreeRegistered: boolean; dirty: boolean | null; artifactExists: boolean; artifactDigestMatches: boolean; captureMatchesWorktree: boolean | null };
}
interface DiagnosticState {
  startedAt: number; salt: string; operations: Record<WorktreeOperationKind, WorktreeOperationMetrics>;
  reasons: Record<WorktreeDiagnosticReason, number>; events: WorktreeDiagnosticEvent[];
  durationSamples: Record<WorktreeOperationKind, number[]>;
}
declare global { var __deerhuxWorktreeDiagnostics: DiagnosticState | undefined }

function emptyMetrics(): WorktreeOperationMetrics {
  return { started: 0, terminal: 0, completed: 0, failed: 0, preserved: 0, binaryPatches: 0, successRate: 0, durationP95Ms: 0,
    fileCountTotal: 0, binaryFileCountTotal: 0, worktreesRemoved: 0, branchesRemoved: 0,
    outcomes: Object.fromEntries(WORKTREE_OPERATION_OUTCOMES.map((key) => [key, 0])) as Record<WorktreeOperationOutcome, number>,
    durationMs: { count: 0, total: 0, max: 0 }, patchBytes: { count: 0, total: 0, max: 0 } };
}
function emptyState(): DiagnosticState {
  return { startedAt: Date.now(), salt: randomUUID(),
    operations: Object.fromEntries(WORKTREE_OPERATION_KINDS.map((key) => [key, emptyMetrics()])) as Record<WorktreeOperationKind, WorktreeOperationMetrics>,
    reasons: Object.fromEntries(WORKTREE_DIAGNOSTIC_REASONS.map((key) => [key, 0])) as Record<WorktreeDiagnosticReason, number>, events: [],
    durationSamples: Object.fromEntries(WORKTREE_OPERATION_KINDS.map((key) => [key, [] as number[]])) as Record<WorktreeOperationKind, number[]> };
}
function state(): DiagnosticState {
  const current = globalThis.__deerhuxWorktreeDiagnostics ??= emptyState();
  current.durationSamples ??= Object.fromEntries(WORKTREE_OPERATION_KINDS.map((key) => [key, [] as number[]])) as Record<WorktreeOperationKind, number[]>;
  for (const kind of WORKTREE_OPERATION_KINDS) {
    current.operations[kind].successRate ??= 0;
    current.operations[kind].durationP95Ms ??= 0;
  }
  return current;
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0; }
function add(left: number, right = 1): number { return Math.min(Number.MAX_SAFE_INTEGER, left + number(right)); }
function measure(target: Measurement, value: number): void { target.count = add(target.count); target.total = add(target.total, value); target.max = Math.max(target.max, value); }
function append(current: DiagnosticState, event: WorktreeDiagnosticEvent): void {
  current.events.push(event);
  if (current.events.length > WORKTREE_DIAGNOSTIC_THRESHOLDS.maxEvents) current.events.splice(0, current.events.length - WORKTREE_DIAGNOSTIC_THRESHOLDS.maxEvents);
}
function recordDuration(current: DiagnosticState, kind: WorktreeOperationKind, metrics: WorktreeOperationMetrics, value: number): void {
  const samples = current.durationSamples[kind];
  samples.push(value);
  if (samples.length > WORKTREE_DIAGNOSTIC_THRESHOLDS.maxEvents) samples.splice(0, samples.length - WORKTREE_DIAGNOSTIC_THRESHOLDS.maxEvents);
  const sorted = [...samples].sort((left, right) => left - right);
  metrics.durationP95Ms = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}
function contextFields(context: WorktreeOperationContext): WorktreeOperationContext {
  const result: WorktreeOperationContext = {};
  for (const key of ["runId", "workerId", "transactionId"] as const) {
    if (typeof context[key] === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(context[key]!)) result[key] = context[key];
  }
  if (typeof context.repoHash === "string" && /^[a-f0-9]{16,64}$/.test(context.repoHash)) result.repoHash = context.repoHash;
  return result;
}

export function worktreeDiagnosticReason(value: unknown): WorktreeDiagnosticReason {
  try {
    const code = typeof value === "string" ? value : value && typeof value === "object" && "code" in value ? (value as { code: unknown }).code : undefined;
    if (typeof code !== "string") return "unknown";
    if ((WORKTREE_DIAGNOSTIC_REASONS as readonly string[]).includes(code)) return code as WorktreeDiagnosticReason;
    return Object.hasOwn(CODE_REASONS, code) ? CODE_REASONS[code] : "unknown";
  } catch { return "unknown"; }
}
export function hashWorktreeRepository(repoRoot: string): string {
  try { return createHash("sha256").update(state().salt).update("\0").update(repoRoot).digest("hex").slice(0, 16); }
  catch { return "0000000000000000"; }
}

/** Record a bounded cleanup/recovery decision without paths, refs, OIDs or Git output. */
export function recordWorktreeDecision(context: WorktreeOperationContext, reasonValue: unknown, facts: WorktreeDiagnosticEvent["facts"]): void {
  try {
    const current = state();
    const reason = worktreeDiagnosticReason(reasonValue);
    const safeFacts = facts && {
      repoMatches: facts.repoMatches === true, pathSafe: facts.pathSafe === true,
      worktreeExists: facts.worktreeExists === true, worktreeRegistered: facts.worktreeRegistered === true,
      dirty: typeof facts.dirty === "boolean" ? facts.dirty : null,
      artifactExists: facts.artifactExists === true, artifactDigestMatches: facts.artifactDigestMatches === true,
      captureMatchesWorktree: typeof facts.captureMatchesWorktree === "boolean" ? facts.captureMatchesWorktree : null,
    };
    if (!safeFacts) return;
    current.reasons[reason] = add(current.reasons[reason]);
    append(current, { operationId: randomUUID(), kind: "cleanup", phase: "decision", timestamp: Date.now(),
      outcome: "planned", ...contextFields(context), reason, facts: safeFacts });
  } catch { /* Decision telemetry cannot affect cleanup or recovery. */ }
}

/** Bounded, best-effort process telemetry; it must never alter an operation outcome. */
export function beginWorktreeOperation(kind: WorktreeOperationKind, context: WorktreeOperationContext = {}): {
  operationId: string; finish: (outcome: WorktreeOperationOutcome, details?: WorktreeOperationDetails) => void;
  checkpoint: (outcome: "checked" | "planned", details?: WorktreeOperationDetails) => void;
} {
  try {
    if (!(WORKTREE_OPERATION_KINDS as readonly string[]).includes(kind)) return { operationId: "unavailable", finish: () => undefined, checkpoint: () => undefined };
    const current = state();
    const safeContext = contextFields(context);
    const operationId = randomUUID();
    const started = performance.now();
    const metrics = current.operations[kind];
    metrics.started = add(metrics.started);
    append(current, { operationId, kind, phase: "started", timestamp: Date.now(), ...safeContext });
    let finished = false;
    const checkpoints = new Set<"checked" | "planned">();
    return { operationId, checkpoint(outcome, details = {}) {
      try {
        if (finished || checkpoints.has(outcome) || !(kind === "apply" && outcome === "checked" || kind === "cleanup" && outcome === "planned")) return;
        checkpoints.add(outcome);
        const safeDetails: WorktreeOperationDetails = { reason: details.reason === undefined ? "none" : worktreeDiagnosticReason(details.reason) };
        for (const field of ["patchBytes", "fileCount", "binaryFileCount", "preservedCount", "removedWorktreeCount", "removedBranchCount"] as const) {
          if (details[field] !== undefined) safeDetails[field] = number(details[field]);
        }
        metrics.outcomes[outcome] = add(metrics.outcomes[outcome]);
        append(current, { operationId, kind, phase: "checkpoint", timestamp: Date.now(), outcome, ...safeContext, ...safeDetails });
      } catch { /* Checkpoints are non-authoritative telemetry. */ }
    }, finish(outcome, details = {}) {
      if (finished) return;
      finished = true;
      try {
        const safeOutcome = ALLOWED_OUTCOMES[kind].includes(outcome) ? outcome : "failed";
        const reason = details.reason === undefined ? "none" : worktreeDiagnosticReason(details.reason);
        const durationMs = number(performance.now() - started);
        const safeDetails: WorktreeOperationDetails = { reason };
        metrics.terminal = add(metrics.terminal);
        if (!checkpoints.has(safeOutcome as "checked" | "planned")) metrics.outcomes[safeOutcome] = add(metrics.outcomes[safeOutcome]);
        if (FAILED_OUTCOMES.has(safeOutcome)) metrics.failed = add(metrics.failed);
        else metrics.completed = add(metrics.completed);
        metrics.successRate = metrics.terminal === 0 ? 0 : metrics.completed / metrics.terminal;
        metrics.preserved = add(metrics.preserved, details.preservedCount ?? (safeOutcome === "preserved" ? 1 : 0));
        measure(metrics.durationMs, durationMs);
        recordDuration(current, kind, metrics, durationMs);
        for (const field of ["patchBytes", "fileCount", "binaryFileCount", "preservedCount", "removedWorktreeCount", "removedBranchCount"] as const) {
          if (details[field] !== undefined) safeDetails[field] = number(details[field]);
        }
        if (safeDetails.patchBytes !== undefined) measure(metrics.patchBytes, safeDetails.patchBytes);
        metrics.fileCountTotal = add(metrics.fileCountTotal, safeDetails.fileCount ?? 0);
        metrics.binaryFileCountTotal = add(metrics.binaryFileCountTotal, safeDetails.binaryFileCount ?? 0);
        if ((safeDetails.binaryFileCount ?? 0) > 0) metrics.binaryPatches = add(metrics.binaryPatches);
        if (typeof details.worktreeRemoved === "boolean") safeDetails.worktreeRemoved = details.worktreeRemoved;
        if (typeof details.branchRemoved === "boolean") safeDetails.branchRemoved = details.branchRemoved;
        metrics.worktreesRemoved = add(metrics.worktreesRemoved, safeDetails.removedWorktreeCount ?? (safeDetails.worktreeRemoved ? 1 : 0));
        metrics.branchesRemoved = add(metrics.branchesRemoved, safeDetails.removedBranchCount ?? (safeDetails.branchRemoved ? 1 : 0));
        current.reasons[reason] = add(current.reasons[reason]);
        append(current, { operationId, kind, phase: "terminal", timestamp: Date.now(), outcome: safeOutcome, durationMs, ...safeContext, ...safeDetails });
      } catch { /* Telemetry failure cannot reverse real work. */ }
    } };
  } catch { return { operationId: "unavailable", finish: () => undefined, checkpoint: () => undefined }; }
}

export function getWorktreeDiagnostics() {
  try {
    const current = state();
    return { version: 1 as const, startedAt: current.startedAt,
      operations: structuredClone(current.operations), reasons: { ...current.reasons },
      events: current.events.map((event) => ({ ...event })), thresholds: { ...WORKTREE_DIAGNOSTIC_THRESHOLDS }, unavailable: false };
  } catch {
    return { version: 1 as const, startedAt: 0, operations: Object.fromEntries(WORKTREE_OPERATION_KINDS.map((key) => [key, emptyMetrics()])) as Record<WorktreeOperationKind, WorktreeOperationMetrics>,
      reasons: Object.fromEntries(WORKTREE_DIAGNOSTIC_REASONS.map((key) => [key, 0])) as Record<WorktreeDiagnosticReason, number>,
      events: [] as WorktreeDiagnosticEvent[], thresholds: { ...WORKTREE_DIAGNOSTIC_THRESHOLDS }, unavailable: true };
  }
}

export function resetWorktreeDiagnosticsForTests(): void {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) throw new Error("WORKTREE_DIAGNOSTICS_TEST_ONLY");
  globalThis.__deerhuxWorktreeDiagnostics = undefined;
}
