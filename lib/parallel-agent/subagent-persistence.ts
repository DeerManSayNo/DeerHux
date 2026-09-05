import fs from "fs";
import path from "path";
import { summarizeFileChanges } from "./worktree-file-metadata";
import { getAgentDir } from "@/lib/session-reader";

// 在 import 阶段就需要 TASKS_DIR（listPersistedTasks / ensureTasksDir 依赖），
// 而 getAgentDir 内部会读 env/磁盘，放在模块顶层即可，与原行为保持一致。
import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";
import { readWorktreeManifest } from "./worktree-manifest";

const TASKS_DIR = path.join(getAgentDir(), "tasks");
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_SCAN_BYTES = 8 * 1024 * 1024;

type TaskLogEntry =
  | { type: "state"; state: CollaborationRunState }
  | { type: "state_snapshot"; state: CollaborationRunState }
  | { type: "event"; event: CollaborationRunEvent };

const ACTIVE_STATUSES = new Set<CollaborationRunState["status"]>(["setting_up", "running", "applying"]);

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function taskPath(runId: string): string {
  return path.join(TASKS_DIR, `${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

function parseTaskLogEntry(line: string): TaskLogEntry | null {
  try {
    return JSON.parse(line) as TaskLogEntry;
  } catch {
    return null;
  }
}

export function normalizePersistedState(value: CollaborationRunState): CollaborationRunState {
  const state = value;
  state.version = Number.isSafeInteger(state.version) && state.version >= 0 ? state.version : 0;
  state.events = Array.isArray(state.events) ? state.events : [];
  if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  state.workflow ??= "parallel";
  state.workers = Array.isArray(state.workers) ? state.workers : [];
  const idByName = new Map<string, string>();
  state.workers.forEach((worker, index) => {
    worker.workerId ||= `${state.runId}_legacy_worker_${index + 1}`;
    if (!idByName.has(worker.name)) idByName.set(worker.name, worker.workerId);
    worker.status ??= "error";
    worker.canContinue ??= false;
  });
  for (const worker of state.workers) {
    if (worker.dependsOn) worker.dependsOn = worker.dependsOn.map((dependency) => idByName.get(dependency) ?? dependency);
  }
  if (state.mode === "isolated_coding" && !state.worktreeManifestPath) {
    const hasImplementation = state.worktreeImplementation !== undefined && state.worktreeImplementation !== null;
    state.recoveryState = hasImplementation ? "manual_recovery_required" : "legacy_recovery_required";
    state.canContinue = false;
    state.continueUnavailableReason = hasImplementation
      ? "Worktree implementation has no manifest; manual recovery is required."
      : "Legacy isolated run requires manual recovery.";
  } else if (state.mode === "isolated_coding" && state.worktreeManifestPath) {
    const manifest = readWorktreeManifest(state.worktreeManifestPath);
    if (manifest.kind !== "ok") {
      state.recoveryState = "manual_recovery_required";
      state.canContinue = false;
      state.continueUnavailableReason = `Worktree manifest is ${manifest.kind}; manual recovery is required.`;
    } else {
      state.worktreeImplementation = 2;
      state.baseCommit = manifest.manifest.baseCommit;
      state.applyTransactionId = manifest.manifest.apply?.transactionId;
      state.applyStartedAt = manifest.manifest.apply?.startedAt;
      state.applyState = manifest.manifest.state === "applied" ? "applied"
        : manifest.manifest.state === "applying" ? "applying" : state.applyState ?? "idle";
      state.captureState = manifest.manifest.state === "captured"
        ? "captured"
        : manifest.manifest.state === "preserved" || manifest.manifest.state === "cleanup_error" ? "preserved" : "pending";
      for (const worker of state.workers) {
        const persistedWorker = manifest.manifest.workers.find((candidate) => candidate.workerId === worker.workerId);
        const capture = persistedWorker?.capture;
        if (!capture) continue;
        worker.patchSha256 = capture.patchSha256 ?? undefined;
        worker.patchBytes = capture.patchBytes ?? undefined;
        worker.changedFiles = capture.changedFiles;
        worker.binaryFiles = capture.binaryFiles;
        worker.changeStats = summarizeFileChanges(capture.fileChanges);
        worker.captureErrorCode = capture.captureError ?? undefined;
        if (persistedWorker.state === "captured" && worker.status === "running") worker.status = "complete";
        if (capture.captureError && worker.status !== "aborted") worker.status = "error";
      }
      if (manifest.manifest.apply?.outcome === "recovery_required") {
        state.applyState = "recovery_required";
        state.recoveryState = "manual_recovery_required";
        state.status = "recoverable";
      } else if (manifest.manifest.state === "applying") {
        state.status = "applying";
      } else if (manifest.manifest.state === "applied") {
        state.status = "applied";
      } else if (manifest.manifest.state === "captured" && ACTIVE_STATUSES.has(state.status)) {
        state.status = "complete";
      }
    }
  }
  return state;
}

function loadLatestTaskState(filePath: string, normalize = true): CollaborationRunState | undefined {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    let offset = size;
    let buffer = "";
    let scanned = 0;

    while (offset > 0 && scanned < MAX_TAIL_SCAN_BYTES) {
      const bytesToRead = Math.min(TAIL_CHUNK_BYTES, offset, MAX_TAIL_SCAN_BYTES - scanned);
      offset -= bytesToRead;
      scanned += bytesToRead;

      const chunk = Buffer.alloc(bytesToRead);
      fs.readSync(fd, chunk, 0, bytesToRead, offset);
      buffer = chunk.toString("utf8") + buffer;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.shift() ?? "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        const entry = parseTaskLogEntry(line);
        if (entry?.type === "state" || entry?.type === "state_snapshot") {
          return normalize ? normalizePersistedState(entry.state) : entry.state;
        }
      }
    }

    const entry = parseTaskLogEntry(buffer.trim());
    return entry?.type === "state" || entry?.type === "state_snapshot"
      ? normalize ? normalizePersistedState(entry.state) : entry.state
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function persistTaskState(state: CollaborationRunState): boolean {
  try {
    ensureTasksDir();
    fs.appendFileSync(taskPath(state.runId), `${JSON.stringify({ type: "state_snapshot", state } satisfies TaskLogEntry)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function persistTaskEvent(event: CollaborationRunEvent): boolean {
  try {
    ensureTasksDir();
    fs.appendFileSync(taskPath(event.runId), `${JSON.stringify({ type: "event", event } satisfies TaskLogEntry)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除一个 task 的持久化日志文件。用于 run 终态回收时清理磁盘侧泄漏：
 * 每个 run 的 .jsonl 若不删，会在 ~/.deerhux/agent/tasks/ 下无限堆积，
 * 且 listPersistedTasks 的 readdirSync + 逐文件 tail 解析会越来越慢。
 * Best-effort：文件不存在或删除失败都静默。
 */
export function deletePersistedTask(runId: string): void {
  try {
    const filePath = taskPath(runId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* Best effort — 内存态清理不依赖磁盘清理成功 */
  }
}

/** Bounded historical snapshot read only: no recovery, normalization or persistence. */
export function readTaskSnapshotForInspection(runId: string): CollaborationRunState | undefined {
  const state = loadLatestTaskState(taskPath(runId), false);
  return state?.runId === runId ? state : undefined;
}

export function loadTask(runId: string): CollaborationRunState | undefined {
  try {
    const filePath = taskPath(runId);
    if (!fs.existsSync(filePath)) return undefined;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    let state: CollaborationRunState | undefined;
    let eventsAfterSnapshot: CollaborationRunEvent[] = [];
    for (const line of lines) {
      const entry = parseTaskLogEntry(line);
      if (!entry) continue;
      if (entry.type === "state" || entry.type === "state_snapshot") {
        state = entry.state;
        eventsAfterSnapshot = [];
      } else if (entry.type === "event") eventsAfterSnapshot.push(entry.event);
    }
    if (!state) return undefined;
    state = normalizePersistedState(state);
    const seen = new Set(state.events.map((event) => event.eventId).filter(Boolean));
    for (const event of eventsAfterSnapshot) {
      if (event.eventId && seen.has(event.eventId)) continue;
      state.events.push(event);
      if (event.eventId) seen.add(event.eventId);
    }
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
    markInterruptedIfStale(state);
    return state;
  } catch {
    return undefined;
  }
}

export function listPersistedTasks(): CollaborationRunState[] {
  try {
    ensureTasksDir();
    return fs.readdirSync(TASKS_DIR)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => {
        const task = loadLatestTaskState(path.join(TASKS_DIR, file));
        if (task) markInterruptedIfStale(task);
        return task ? [task] : [];
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function markInterruptedIfStale(state: CollaborationRunState): void {
  if (!ACTIVE_STATUSES.has(state.status)) return;
  if (state.events.some((event) => event.type === "run_interrupted")) {
    state.status = "recoverable";
    return;
  }
  const now = new Date().toISOString();
  const event: CollaborationRunEvent = {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "run_interrupted",
    runId: state.runId,
    timestamp: now,
    error: "Task was interrupted while the app was not running. Open a worker session to continue.",
  };
  state.status = "recoverable";
  state.updatedAt = now;
  state.events.push(event);
  if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  persistTaskEvent(event);
  persistTaskState(state);
}
