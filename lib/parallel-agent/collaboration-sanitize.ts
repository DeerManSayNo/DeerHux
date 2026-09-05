import type {
  CollaborationRunEvent,
  CollaborationRunSnapshot,
  CollaborationRunState,
  WorkerToolActivity,
} from "./collaboration-types";
import { getWorktreeRunCapabilities } from "./worktree-rollout.ts";
import { sanitizeChangeStats } from "./worktree-file-metadata.ts";

const PUBLIC_REASON_CODES = new Set([
  "ABORT_STATE_PERSISTENCE_FAILED",
  "APPLY_ALREADY_APPLIED", "APPLY_ARTIFACT_DIGEST_MISMATCH", "APPLY_ARTIFACT_MISSING",
  "APPLY_FILE_DUPLICATE", "APPLY_FILE_INVALID", "APPLY_FILE_OUTSIDE_REPOSITORY", "APPLY_FILE_UNKNOWN",
  "APPLY_FILES_MISMATCH", "APPLY_FINAL_CHECK_FAILED", "APPLY_HEAD_CHANGED", "APPLY_HISTORY_UNVERIFIED", "APPLY_IDEMPOTENCY_MISMATCH",
  "APPLY_INTERNAL_ERROR", "APPLY_JOURNAL_INVALID", "APPLY_MANIFEST_INVALID", "APPLY_MANIFEST_NOT_CAPTURED",
  "APPLY_MANIFEST_PATH_INVALID", "APPLY_MANIFEST_RUN_MISMATCH", "APPLY_MANIFEST_UNAVAILABLE", "APPLY_MANUAL_RECOVERY_REQUIRED",
  "APPLY_MODE_UNSUPPORTED", "APPLY_DISABLED", "APPLY_NO_CHANGES", "APPLY_NO_CHANGES_SELECTED", "APPLY_PRECONDITION_CHANGED",
  "APPLY_REPOSITORY_DIRTY", "APPLY_REPOSITORY_MISMATCH", "APPLY_RUN_NOT_FOUND", "APPLY_RUN_NOT_READY",
  "APPLY_STATE_PERSISTENCE_FAILED", "APPLY_TRANSACTION_ACTIVE", "APPLY_TRANSACTION_INCOMPLETE",
  "APPLY_TRANSACTION_INVALID", "APPLY_WORKER_CONFLICT", "APPLY_WORKER_NOT_CAPTURED",
  "APPLY_WORKER_ORDER_INVALID", "APPLY_WORKER_UNKNOWN", "APPLY_WORKERS_EMPTY",
  "ARTIFACT_BASE_INVALID", "ARTIFACT_DIGEST_MISMATCH", "ARTIFACT_GIT_FAILED", "ARTIFACT_MANIFEST_INVALID",
  "ARTIFACT_MANIFEST_WRITE_FAILED", "ARTIFACT_PATCH_APPLY_FAILED", "ARTIFACT_PATCH_TOO_LARGE",
  "ARTIFACT_PATCH_WRITE_FAILED", "ARTIFACT_REPOSITORY_MISMATCH", "ARTIFACT_SYNTHETIC_INVALID", "ARTIFACT_TREE_MISMATCH",
  "ARTIFACT_WORKER_NOT_FOUND", "CAPTURE_FAILED", "CAPTURE_STATE_PERSISTENCE_FAILED",
  "ENV_CONFIG_INVALID", "ENV_CONFIG_UNAVAILABLE", "ENV_MODE_UNSUPPORTED", "ENV_REPOSITORY_MISMATCH",
  "ENV_HOOK_INVALID", "ENV_HOOK_NOT_TRACKED", "ENV_HOOK_CHANGED", "ENV_HOOK_FAILED", "ENV_HOOK_TIMEOUT",
  "ENV_HOOK_OUTPUT_LIMIT", "ENV_ABORTED", "ENV_OUTPUT_INVALID", "ENV_SYNTHETIC_INVALID", "ENV_INTERNAL",
  "CONTINUE_ADMISSION_FAILED", "CONTINUE_BASE_INVALID", "CONTINUE_BINDING_INVALID", "CONTINUE_CANCELLED",
  "CONTINUE_FAILED", "CONTINUE_OPERATION_ACTIVE", "CONTINUE_OWNER_ACTIVE", "CONTINUE_REPOSITORY_MISMATCH",
  "CONTINUE_SESSION_INVALID", "CONTINUE_STATE_PERSISTENCE_FAILED", "CONTINUE_UNAVAILABLE",
  "CONTINUE_WORKTREE_INVALID", "INCOMPLETE_CAPTURE", "PRESERVED_FOR_RECOVERY", "RUN_SETUP_STATE_PERSISTENCE_FAILED", "RUN_FINALIZATION_STATE_PERSISTENCE_FAILED",
  "WORKTREE_CLEANUP_COMPLETED", "WORKTREE_CLEANUP_PARTIAL", "WORKTREE_CLEANUP_STATE_PERSISTENCE_FAILED",
]);

export function sanitizeCollaborationReasonCode(value: unknown): string | undefined {
  return typeof value === "string" && PUBLIC_REASON_CODES.has(value) ? value : undefined;
}

export function projectCollaborationError(
  errorCode: unknown,
  fallback: "Collaboration run failed" | "Worker operation failed" | "Collaboration event failed" | "Worker cannot be continued" = "Collaboration run failed",
): string {
  const code = sanitizeCollaborationReasonCode(errorCode);
  return code ? `${fallback} (${code})` : fallback;
}

function sanitizeTimestamp(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
}

function sanitizeToolName(value: unknown): string {
  const allowed = new Set(["bash", "sh", "edit", "write", "read", "grep", "find", "code_search", "codegraph", "subagent"]);
  return typeof value === "string" && allowed.has(value) ? value : "tool";
}

/** Preserve the activity shape without exposing commands, prompts, or paths. */
export function sanitizeWorkerToolActivity(activity: WorkerToolActivity): WorkerToolActivity {
  return {
    toolName: sanitizeToolName(activity.toolName),
    summary: "",
    status: activity.status === "done" || activity.status === "error" ? activity.status : "running",
    ts: sanitizeTimestamp(activity.ts),
  };
}

function sanitizeRepositoryPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\0\r\n]/.test(segment))) return null;
  return normalized;
}

function sanitizeRepositoryPaths(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return values.flatMap((value) => {
    const safe = typeof value === "string" ? sanitizeRepositoryPath(value) : null;
    return safe ? [safe] : [];
  });
}

/** Retain event identity/status/counts, but never legacy free-form payloads. */
function sanitizeCollaborationEvent(event: CollaborationRunEvent): CollaborationRunEvent {
  const errorCode = sanitizeCollaborationReasonCode(event.errorCode);
  const reasonCode = sanitizeCollaborationReasonCode(event.reasonCode);
  return {
    ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
    type: event.type,
    runId: event.runId,
    ...(typeof event.workerId === "string" ? { workerId: event.workerId } : {}),
    ...(typeof event.timestamp === "string" ? { timestamp: sanitizeTimestamp(event.timestamp) } : {}),
    ...(typeof event.transactionId === "string" ? { transactionId: event.transactionId } : {}),
    ...(event.phase === "prepared" || event.phase === "checked" || event.phase === "applied" || event.phase === "persisted" ? { phase: event.phase } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(Number.isSafeInteger(event.fileCount) && Number(event.fileCount) >= 0 ? { fileCount: event.fileCount } : {}),
    ...(Number.isSafeInteger(event.binaryFileCount) && Number(event.binaryFileCount) >= 0 ? { binaryFileCount: event.binaryFileCount } : {}),
    ...(event.error ? { error: projectCollaborationError(errorCode ?? reasonCode, "Collaboration event failed") } : {}),
  };
}

const PUBLIC_LIFECYCLE_EVENT_TYPES = new Set<CollaborationRunEvent["type"]>([
  "worker_capture_started", "worker_capture_completed", "worker_capture_error",
  "worktree_preserved", "worktree_cleanup_completed", "worktree_cleanup_error",
  "patch_apply_started", "patch_apply_checked", "patch_apply_committed",
  "patch_apply_recovery_required", "patch_applied", "patch_apply_error",
]);

/** Strict SSE projection for capture/apply/cleanup boundaries, including old Apply names. */
export function sanitizeCollaborationLifecycleEvent(event: CollaborationRunEvent): CollaborationRunEvent | undefined {
  if (!PUBLIC_LIFECYCLE_EVENT_TYPES.has(event.type)) return undefined;
  const sanitized = sanitizeCollaborationEvent(event);
  const { error: _error, files: _files, ...fixed } = sanitized;
  return fixed;
}

/** Shared external projection for GET Run, list snapshots, and Resume results. */
export function sanitizeCollaborationRun(
  state: CollaborationRunState | CollaborationRunSnapshot,
): CollaborationRunSnapshot {
  return {
    runId: state.runId,
    version: state.version,
    ...(state.worktreeImplementation === 2 ? { worktreeImplementation: 2 as const } : {}),
    worktreeCapabilities: getWorktreeRunCapabilities(state),
    ...("taskId" in state && typeof state.taskId === "string" ? { taskId: state.taskId } : {}),
    ...(typeof state.parentEntryId === "string" ? { parentEntryId: state.parentEntryId } : {}),
    ...(typeof state.title === "string" ? { title: state.title } : {}),
    mode: state.mode,
    ...(state.taskMode ? { taskMode: state.taskMode } : {}),
    ...(state.runPlacement ? { runPlacement: state.runPlacement } : {}),
    ...(state.workflow ? { workflow: state.workflow } : {}),
    status: state.status,
    ...(typeof state.baseCommit === "string" ? { baseCommit: state.baseCommit } : {}),
    ...(state.captureState ? { captureState: state.captureState } : {}),
    ...(state.applyState ? { applyState: state.applyState } : {}),
    ...(typeof state.applyTransactionId === "string" ? { applyTransactionId: state.applyTransactionId } : {}),
    ...(typeof state.applyStartedAt === "string" ? { applyStartedAt: state.applyStartedAt } : {}),
    ...(state.recoveryState ? { recoveryState: state.recoveryState } : {}),
    message: state.message,
    ...(typeof state.summary === "string" ? { summary: state.summary } : {}),
    ...(state.error ? { error: projectCollaborationError(undefined, "Collaboration run failed") } : {}),
    ...(typeof state.canContinue === "boolean" ? { canContinue: state.canContinue } : {}),
    ...(state.canContinue === false ? { continueUnavailableReason: "Worker cannot be continued" } : {}),
    ...(typeof state.continueExpiresAt === "string" ? { continueExpiresAt: state.continueExpiresAt } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    events: "events" in state && Array.isArray(state.events)
      ? state.events.map(sanitizeCollaborationEvent)
      : undefined,
    workers: state.workers.map((worker) => {
      const safeChangedFiles = sanitizeRepositoryPaths(worker.changedFiles);
      const captureErrorCode = sanitizeCollaborationReasonCode(worker.captureErrorCode);
      return {
        workerId: worker.workerId,
        name: worker.name,
        task: worker.task,
        ...(worker.dependsOn ? { dependsOn: worker.dependsOn.filter((value): value is string => typeof value === "string") } : {}),
        ...(typeof worker.title === "string" ? { title: worker.title } : {}),
        ...(typeof worker.instructions === "string" ? { instructions: worker.instructions } : {}),
        ...(worker.agentType ? { agentType: worker.agentType } : {}),
        ...(worker.capability ? { capability: worker.capability } : {}),
        ...(worker.model ? { model: { provider: worker.model.provider, modelId: worker.model.modelId } } : {}),
        status: worker.status,
        ...(typeof worker.result === "string" ? { result: worker.result } : {}),
        ...(worker.error ? { error: projectCollaborationError(captureErrorCode, "Worker operation failed") } : {}),
        ...(typeof worker.patchSha256 === "string" ? { patchSha256: worker.patchSha256 } : {}),
        ...(typeof worker.patchBytes === "number" && Number.isSafeInteger(worker.patchBytes) && worker.patchBytes >= 0 ? { patchBytes: worker.patchBytes } : {}),
        ...(captureErrorCode ? { captureErrorCode } : {}),
        ...(worker.workerSessionState ? { workerSessionState: worker.workerSessionState } : {}),
        ...(typeof worker.canContinue === "boolean" ? { canContinue: worker.canContinue } : {}),
        ...(worker.canContinue === false ? { continueUnavailableReason: "Worker cannot be continued" } : {}),
        ...(typeof worker.continueExpiresAt === "string" ? { continueExpiresAt: worker.continueExpiresAt } : {}),
        ...(worker.activeTool ? { activeTool: sanitizeWorkerToolActivity(worker.activeTool) } : {}),
        ...(worker.recentTools ? { recentTools: worker.recentTools.map(sanitizeWorkerToolActivity) } : {}),
        ...(safeChangedFiles ? { changedFiles: safeChangedFiles, diffStats: safeChangedFiles.join("\n") } : {}),
        ...(worker.binaryFiles ? { binaryFiles: sanitizeRepositoryPaths(worker.binaryFiles) } : {}),
        ...(sanitizeChangeStats(worker.changeStats) ? { changeStats: sanitizeChangeStats(worker.changeStats) } : {}),
        ...(worker.appliedFiles ? { appliedFiles: sanitizeRepositoryPaths(worker.appliedFiles) } : {}),
        ...(worker.conflictFiles ? { conflictFiles: sanitizeRepositoryPaths(worker.conflictFiles) } : {}),
      };
    }),
  };
}
