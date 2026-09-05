import { hostEventBus } from "../host-event-bus";
import { removedCollaborationMuxSnapshot, toCollaborationMuxSnapshot } from "./collaboration-mux";
import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";
import { deletePersistedTask, listPersistedTasks, loadTask, persistTaskEvent, persistTaskState, readTaskSnapshotForInspection } from "./subagent-persistence";

type Listener = (event: CollaborationRunEvent) => void;
/** Does not admit a runtime Run or write a cold-cache interruption/recovery event. */
export function inspectCollaborationRunSnapshot(runId: string): CollaborationRunState | undefined {
  return runs().get(runId)?.state ?? readTaskSnapshotForInspection(runId);
}
const MAX_RUN_EVENTS = 1000;
const SNAPSHOT_EVENT_TYPES = new Set<CollaborationRunEvent["type"]>([
  "task_created", "run_setup_complete", "run_interrupted", "worker_start",
  "worker_complete", "worker_error", "worker_diff_ready", "task_summary_ready",
  "run_complete", "run_aborted", "run_error", "patch_apply_started",
  "patch_applied", "patch_apply_error",
  "worker_capture_started", "worker_capture_completed", "worker_capture_error",
  "patch_apply_checked", "patch_apply_committed", "patch_apply_recovery_required",
  "worktree_preserved", "worktree_cleanup_completed", "worktree_cleanup_error",
]);

export type CollaborationRunUpdateFailure = "not_found" | "version_mismatch" | "status_mismatch" | "invalid_transition" | "persistence_failed";

export type CollaborationRunUpdateResult =
  | { ok: true; state: CollaborationRunState }
  | { ok: false; reason: CollaborationRunUpdateFailure; state?: CollaborationRunState };

export interface CollaborationRunUpdatePrecondition {
  expectedVersion?: number;
  allowedStatuses?: readonly CollaborationRunState["status"][];
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<CollaborationRunState["status"], ReadonlySet<CollaborationRunState["status"]>>> = {
  setting_up: new Set(["setting_up", "running", "error", "aborted", "recoverable"]),
  running: new Set(["running", "complete", "error", "aborted", "recoverable"]),
  complete: new Set(["complete", "running", "applying", "applied", "error", "recoverable"]),
  error: new Set(["error", "running", "complete", "applying", "applied", "recoverable"]),
  recoverable: new Set(["recoverable", "running", "complete", "applying", "applied", "error", "aborted"]),
  applying: new Set(["applying", "applied", "complete", "error", "recoverable"]),
  applied: new Set(["applied"]),
  aborted: new Set(["aborted"]),
};

interface StoredCollaborationRun {
  state: CollaborationRunState;
  listeners: Set<Listener>;
  removalListeners: Set<() => void>;
  abort?: () => Promise<void>;
  cleanup?: () => void | Promise<void>;
}

declare global {
  var __deerhuxCollaborationRuns: Map<string, StoredCollaborationRun> | undefined;
  var __deerhuxCollaborationRunsLoaded: boolean | undefined;
}

function runs(): Map<string, StoredCollaborationRun> {
  if (!globalThis.__deerhuxCollaborationRuns) globalThis.__deerhuxCollaborationRuns = new Map();
  return globalThis.__deerhuxCollaborationRuns;
}

function broadcastRun(state: CollaborationRunState): void {
  if (!state.parentSessionId) return;
  hostEventBus.emit({
    type: "subagent_run_update",
    parentSessionId: state.parentSessionId,
    run: toCollaborationMuxSnapshot(state),
    updatedAt: Date.now(),
  });
}

function commitState(target: CollaborationRunState, candidate: CollaborationRunState): CollaborationRunState {
  for (const key of Object.keys(target) as Array<keyof CollaborationRunState>) {
    if (!(key in candidate)) delete target[key];
  }
  Object.assign(target, candidate);
  return target;
}

export function createCollaborationRun(state: CollaborationRunState): void {
  state.version = Number.isSafeInteger(state.version) && state.version >= 0 ? state.version : 0;
  if (!persistTaskState(state)) throw new Error("Failed to persist collaboration run");
  runs().set(state.runId, { state, listeners: new Set(), removalListeners: new Set() });
  broadcastRun(state);
}

export function getCollaborationRun(runId: string): CollaborationRunState | undefined {
  const existing = runs().get(runId)?.state;
  if (existing) return existing;
  const persisted = loadTask(runId);
  if (!persisted) return undefined;
  runs().set(runId, { state: persisted, listeners: new Set(), removalListeners: new Set() });
  return persisted;
}

export function listCollaborationRuns(): CollaborationRunState[] {
  const store = runs();
  if (!globalThis.__deerhuxCollaborationRunsLoaded) {
    for (const state of listPersistedTasks()) {
      if (!store.has(state.runId)) store.set(state.runId, { state, listeners: new Set(), removalListeners: new Set() });
    }
    globalThis.__deerhuxCollaborationRunsLoaded = true;
  }
  return [...store.values()].map((run) => run.state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateCollaborationRun(runId: string, updater: (state: CollaborationRunState) => void): CollaborationRunState | undefined {
  const result = compareAndSetCollaborationRun(runId, {}, updater);
  return result.ok ? result.state : undefined;
}

/**
 * Run 状态的唯一提交点。更新器只操作隔离候选值；只有前置条件、状态机和持久化
 * 全部成功后才替换共享内存并广播，因此失败的写盘不会泄露成权威 SSE 状态。
 */
export function compareAndSetCollaborationRun(
  runId: string,
  precondition: CollaborationRunUpdatePrecondition,
  updater: (state: CollaborationRunState) => void,
): CollaborationRunUpdateResult {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return { ok: false, reason: "not_found" };
  if (precondition.expectedVersion !== undefined && run.state.version !== precondition.expectedVersion) {
    return { ok: false, reason: "version_mismatch", state: run.state };
  }
  if (precondition.allowedStatuses && !precondition.allowedStatuses.includes(run.state.status)) {
    return { ok: false, reason: "status_mismatch", state: run.state };
  }

  const previousStatus = run.state.status;
  const candidate = structuredClone(run.state);
  updater(candidate);
  if (!ALLOWED_STATUS_TRANSITIONS[previousStatus].has(candidate.status)) {
    return { ok: false, reason: "invalid_transition", state: run.state };
  }
  if (candidate.status === "applying" && (!candidate.applyTransactionId || !candidate.applyStartedAt)) {
    return { ok: false, reason: "invalid_transition", state: run.state };
  }
  candidate.version = run.state.version + 1;
  candidate.updatedAt = new Date().toISOString();
  if (!persistTaskState(candidate)) return { ok: false, reason: "persistence_failed", state: run.state };

  const committed = commitState(run.state, candidate);
  broadcastRun(committed);
  return { ok: true, state: committed };
}

export function emitCollaborationRunEvent(event: CollaborationRunEvent): void {
  const run = runs().get(event.runId);
  if (!run) return;
  const stamped = {
    ...event,
    eventId: event.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  const candidate = structuredClone(run.state);
  candidate.events.push(stamped);
  if (candidate.events.length > MAX_RUN_EVENTS) candidate.events.splice(0, candidate.events.length - MAX_RUN_EVENTS);
  // Telemetry does not participate in the control-plane CAS revision. Otherwise a
  // worker output event could spuriously invalidate Apply/Continue admission.
  candidate.version = run.state.version;
  candidate.updatedAt = new Date().toISOString();

  // Event 写失败时立即降级为完整 snapshot；关键边界事件同时写 snapshot。
  // 两种格式都携带有界 events，因此任一成功都足以在重启后恢复事实。
  const eventPersisted = persistTaskEvent(stamped);
  const snapshotPersisted = (!eventPersisted || SNAPSHOT_EVENT_TYPES.has(stamped.type))
    ? persistTaskState(candidate)
    : false;
  if (!eventPersisted && !snapshotPersisted) return;
  const committed = commitState(run.state, candidate);
  broadcastRun(committed);
  for (const listener of run.listeners) {
    try { listener(stamped); } catch { /* one listener must not change operation outcome */ }
  }
}

export function subscribeCollaborationRun(
  runId: string,
  listener: Listener,
  onRemoved?: () => void,
): () => void {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return () => undefined;
  run.listeners.add(listener);
  if (onRemoved) run.removalListeners.add(onRemoved);
  return () => {
    run.listeners.delete(listener);
    if (onRemoved) run.removalListeners.delete(onRemoved);
  };
}

export function setCollaborationAbort(runId: string, abort: () => Promise<void>): void {
  const run = runs().get(runId);
  if (run) run.abort = abort;
}

export function setCollaborationCleanup(runId: string, cleanup: () => void | Promise<void>): void {
  const run = runs().get(runId);
  if (run) run.cleanup = cleanup;
}

/** 终态集合：进入这些状态的 run 不允许再 abort，避免污染终态快照（P2-5）。 */
const TERMINAL_RUN_STATUSES_FOR_ABORT = new Set<CollaborationRunState["status"]>([
  "complete",
  "aborted",
  "error",
  "applied",
  "recoverable",
]);

export async function abortCollaborationRun(runId: string): Promise<boolean> {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return false;
  // 终态守卫：无论 run.abort 是否存在，已终结的 run 都拒绝 abort。此前 run.abort
  // 分支跳过 status 检查，导致对已 complete/applied 的 run 再调 abort 会重新执行
  // cleanupAll 并把 status 强行改回 aborted，污染终态快照。
  if (TERMINAL_RUN_STATUSES_FOR_ABORT.has(run.state.status)) return false;
  // Apply owns an external Git transaction. Aborting it here could publish an aborted
  // snapshot while the already-started transaction commits successfully.
  if (run.state.status === "applying") return false;
  if (!run.abort) {
    if (run.state.status !== "setting_up" && run.state.status !== "running" && run.state.status !== "recoverable") return false;
    const stopped = updateCollaborationRun(runId, (state) => {
      state.status = "aborted";
      for (const worker of state.workers) {
        if (worker.status === "pending" || worker.status === "running") worker.status = "aborted";
      }
    });
    if (!stopped) return false;
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    return true;
  }
  await run.abort();
  return true;
}

export async function cleanupCollaborationRun(runId: string): Promise<void> {
  const run = runs().get(runId);
  await run?.cleanup?.();
}

/**
 * 全量回收一个已终结的 run：清 worktree + destroy worker sessions（通过已注册的
 * cleanup 回调）+ 清 listeners + 从内存 Map 删除 + 删磁盘 .jsonl 日志。
 *
 * 与 cleanupCollaborationRun 的区别：后者只调 cleanup 回调（清 worktree/session），
 * 不释放内存 Map 条目和磁盘文件，导致 store Map 单调增长（P0-2）。本函数用于
 * run 进入终态后的统一收尾。
 *
 * 幂等：重复调用安全（cleanup 回调内部已 try/catch；Map.get 返回 undefined 时
 * 直接 no-op；fs.unlink 不存在时静默）。
 */
export async function removeCollaborationRun(runId: string): Promise<void> {
  const run = runs().get(runId);
  if (run) {
    try { await run.cleanup?.(); } catch { return; }
    if (run.state.parentSessionId) {
      hostEventBus.emit({
        type: "subagent_run_update",
        parentSessionId: run.state.parentSessionId,
        run: removedCollaborationMuxSnapshot(runId),
        updatedAt: Date.now(),
      });
    }
    // Notify the legacy per-run stream before deleting host state.
    for (const listener of [...run.removalListeners]) {
      try { listener(); } catch { /* one mirror must not block cleanup */ }
    }
    run.removalListeners.clear();
    run.listeners.clear();
    // 释放对 abort/cleanup 闭包（捕获 workerSessions、runDir 等大对象）的引用。
    run.abort = undefined;
    run.cleanup = undefined;
    runs().delete(runId);
  }
  deletePersistedTask(runId);
}
