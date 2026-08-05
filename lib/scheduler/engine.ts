// ============================================================================
// Scheduler engine — manages node-cron jobs, syncs with persistent store
// ============================================================================

import fs from "fs";
import path from "path";
import cron, { type ScheduledTask as CronScheduledTask } from "node-cron";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadTasks, addTask, updateTask, deleteTask } from "./store";
import type { ScheduledTask, PromptTaskConfig } from "./types";

// Map of task id → cron ScheduledTask instance
const runningJobs = new Map<string, CronScheduledTask>();

let started = false;
let schedulerLockOwned = false;
const SCHEDULER_LOCK_FILE = "scheduler.lock";

function getSchedulerLockPath(): string {
  const dir = getAgentDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, SCHEDULER_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function releaseSchedulerLock(): void {
  if (!schedulerLockOwned) return;
  const lockPath = getSchedulerLockPath();
  const lockPid = readLockPid(lockPath);
  if (lockPid === process.pid) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore cleanup errors during process shutdown.
    }
  }
  schedulerLockOwned = false;
}

function acquireSchedulerLock(): boolean {
  const lockPath = getSchedulerLockPath();
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      schedulerLockOwned = true;
      process.once("exit", releaseSchedulerLock);
      return true;
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code !== "EEXIST") throw err;

      const lockPid = readLockPid(lockPath);
      if (lockPid === process.pid) {
        // Same process after Next.js HMR: reclaim the lock and clean node-cron's in-process registry below.
        fs.writeFileSync(lockPath, payload, "utf-8");
        schedulerLockOwned = true;
        process.once("exit", releaseSchedulerLock);
        return true;
      }

      if (lockPid === null || !isProcessAlive(lockPid)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may have acquired it between read and unlink.
        }
      }

      console.log(`[scheduler] Another process already owns the scheduler lock (pid ${lockPid ?? "unknown"}); skipping startup`);
      return false;
    }
  }

  return false;
}

function executeTaskLazily(task: ScheduledTask): void {
  // The runner pulls in the agent runtime and session reader. Keep that large
  // dependency graph out of scheduler startup and only load it on a trigger.
  void import("./runner")
    .then(({ executeTask }) => {
      // Lazy loading creates a window in which the task can be edited, disabled,
      // or deleted. Re-read it so stale prompts are never executed.
      const latestTask = loadTasks().find((candidate) => candidate.id === task.id);
      if (!latestTask || !latestTask.enabled) return;
      return executeTask(latestTask);
    })
    .catch((error: unknown) => {
      // Cron callbacks and run-now are fire-and-forget by design. Preserve the
      // runner's internal error recording while handling import/top-level errors
      // here so a failed trigger never becomes an unhandled rejection.
      console.error(`[scheduler] Failed to execute task "${task.name}":`, error);
    });
}

function scheduleJob(task: ScheduledTask): void {
  if (!task.enabled) return;

  // Validate cron expression
  if (!cron.validate(task.cron)) {
    console.warn(`[scheduler] Invalid cron expression for task "${task.name}": ${task.cron}`);
    return;
  }

  // Remove existing job if any
  unscheduleJob(task.id);

  try {
    const job = cron.schedule(task.cron, () => {
      executeTaskLazily(task);
    }, {
      name: task.name,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    runningJobs.set(task.id, job);
    console.log(`[scheduler] Scheduled task "${task.name}" with cron "${task.cron}"`);
  } catch (err) {
    console.error(`[scheduler] Failed to schedule task "${task.name}":`, err);
  }
}

function unscheduleJob(taskId: string): void {
  const existing = runningJobs.get(taskId);
  if (existing) {
    existing.stop();
    existing.destroy?.();
    runningJobs.delete(taskId);
  }
}

export function startScheduler(): void {
  if (started) return;
  if (!acquireSchedulerLock()) return;
  started = true;

  // Kill any stale cron jobs left over from previous module load (e.g. HMR in dev).
  // node-cron's internal task registry survives module reload because it's an
  // external package, but our in-memory `runningJobs` Map is fresh.  Without this
  // cleanup, every HMR cycle adds another duplicate cron job for the same task.
  const staleJobs = cron.getTasks();
  if (staleJobs.size > 0) {
    console.log(`[scheduler] Cleaning up ${staleJobs.size} stale cron job(s) from previous module load`);
    for (const [, job] of staleJobs) {
      job.stop();
      job.destroy();
    }
  }

  const tasks = loadTasks();
  console.log(`[scheduler] Starting scheduler with ${tasks.length} task(s)`);

  for (const task of tasks) {
    scheduleJob(task);
  }
}

export function stopScheduler(): void {
  for (const [id] of runningJobs) {
    unscheduleJob(id);
  }
  started = false;
  releaseSchedulerLock();
  console.log("[scheduler] Scheduler stopped");
}

// ============================================================================
// Public API — called by API routes to manage tasks at runtime
// ============================================================================

export function getTasks(): ScheduledTask[] {
  return loadTasks();
}

export function getTask(id: string): ScheduledTask | undefined {
  return loadTasks().find((t) => t.id === id);
}

export function createTask(
  name: string,
  type: "prompt",
  cronExpression: string,
  config: PromptTaskConfig
): ScheduledTask {
  const task: ScheduledTask = {
    id: crypto.randomUUID(),
    name,
    type,
    cron: cronExpression,
    enabled: true,
    config,
    createdAt: new Date().toISOString(),
    runCount: 0,
    logs: [],
  };

  addTask(task);
  scheduleJob(task);
  console.log(`[scheduler] Created task "${task.name}" (${task.id})`);
  return task;
}

export function modifyTask(
  id: string,
  updates: Partial<Pick<ScheduledTask, "name" | "cron" | "enabled" | "config">>
): ScheduledTask | null {
  const updated = updateTask(id, updates);
  if (!updated) return null;

  // Reschedule: if disabled, unschedule; otherwise re-schedule with new config
  unscheduleJob(id);
  if (updated.enabled) {
    scheduleJob(updated);
  }

  return updated;
}

export function removeTask(id: string): boolean {
  unscheduleJob(id);
  const result = deleteTask(id);
  if (result) {
    console.log(`[scheduler] Removed task ${id}`);
  }
  return result;
}

export function getJobStatus(taskId: string): { scheduled: boolean; nextRun: Date | null } {
  const job = runningJobs.get(taskId);
  if (!job) return { scheduled: false, nextRun: null };
  try {
    const nextRun = job.getNextRun();
    return { scheduled: true, nextRun };
  } catch {
    return { scheduled: true, nextRun: null };
  }
}

export function runTaskNow(id: string): boolean {
  const task = getTask(id);
  if (!task) return false;
  executeTaskLazily(task);
  return true;
}
