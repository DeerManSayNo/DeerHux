import { hostEventBus } from "../host-event-bus";
import { removedCollaborationMuxSnapshot, toCollaborationMuxSnapshot } from "./collaboration-mux";
import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";
import { deletePersistedTask, listPersistedTasks, loadTask, persistTaskEvent, persistTaskState } from "./subagent-persistence";

type Listener = (event: CollaborationRunEvent) => void;

const SNAPSHOT_EVENT_TYPES = new Set<CollaborationRunEvent["type"]>([
  "task_created",
  "run_setup_complete",
  "run_interrupted",
  "worker_start",
  "worker_complete",
  "worker_error",
  "worker_diff_ready",
  "task_summary_ready",
  "run_complete",
  "run_aborted",
  "run_error",
  "patch_apply_started",
  "patch_applied",
  "patch_apply_error",
]);

interface StoredCollaborationRun {
  state: CollaborationRunState;
  listeners: Set<Listener>;
  removalListeners: Set<() => void>;
  abort?: () => Promise<void>;
  cleanup?: () => void;
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

export function createCollaborationRun(state: CollaborationRunState): void {
  runs().set(state.runId, { state, listeners: new Set(), removalListeners: new Set() });
  persistTaskState(state);
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
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return undefined;
  updater(run.state);
  run.state.updatedAt = new Date().toISOString();
  persistTaskState(run.state);
  broadcastRun(run.state);
  return run.state;
}

export function emitCollaborationRunEvent(event: CollaborationRunEvent): void {
  const run = runs().get(event.runId);
  if (!run) return;
  const stamped = {
    ...event,
    eventId: event.eventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  run.state.events.push(stamped);
  if (run.state.events.length > 500) run.state.events.splice(0, run.state.events.length - 500);
  run.state.updatedAt = new Date().toISOString();
  persistTaskEvent(stamped);
  if (SNAPSHOT_EVENT_TYPES.has(stamped.type)) persistTaskState(run.state);
  broadcastRun(run.state);
  for (const listener of run.listeners) listener(stamped);
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

export function setCollaborationCleanup(runId: string, cleanup: () => void): void {
  const run = runs().get(runId);
  if (run) run.cleanup = cleanup;
}

/** 终态集合：进入这些状态的 run 不允许再 abort，避免污染终态快照（P2-5）。 */
const TERMINAL_RUN_STATUSES_FOR_ABORT = new Set<CollaborationRunState["status"]>([
  "complete",
  "aborted",
  "error",
  "applied",
]);

export async function abortCollaborationRun(runId: string): Promise<boolean> {
  if (!runs().has(runId)) getCollaborationRun(runId);
  const run = runs().get(runId);
  if (!run) return false;
  // 终态守卫：无论 run.abort 是否存在，已终结的 run 都拒绝 abort。此前 run.abort
  // 分支跳过 status 检查，导致对已 complete/applied 的 run 再调 abort 会重新执行
  // cleanupAll 并把 status 强行改回 aborted，污染终态快照。
  if (TERMINAL_RUN_STATUSES_FOR_ABORT.has(run.state.status)) return false;
  if (!run.abort) {
    if (run.state.status !== "setting_up" && run.state.status !== "running" && run.state.status !== "applying" && run.state.status !== "recoverable") return false;
    updateCollaborationRun(runId, (state) => {
      state.status = "aborted";
      for (const worker of state.workers) {
        if (worker.status === "pending" || worker.status === "running") worker.status = "aborted";
      }
    });
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    return true;
  }
  await run.abort();
  return true;
}

export function cleanupCollaborationRun(runId: string): void {
  const run = runs().get(runId);
  run?.cleanup?.();
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
export function removeCollaborationRun(runId: string): void {
  const run = runs().get(runId);
  if (run) {
    try { run.cleanup?.(); } catch { /* best effort */ }
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
