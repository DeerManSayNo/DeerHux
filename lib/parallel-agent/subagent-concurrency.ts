import path from "path";

export const SUBAGENT_TOOL_NAME = "subagent";
export const MAX_SUBAGENT_TOOL_CALLS_PER_TURN = 1;
export const GLOBAL_SUBAGENT_WORKER_LIMIT = 10;
export const PROJECT_SUBAGENT_WORKER_LIMIT = 5;

type SubagentConcurrencyRejectionScope = "tool_call" | "global_workers" | "project_workers";

export interface SubagentConcurrencyRejectionDetails {
  scope: SubagentConcurrencyRejectionScope;
  current: number;
  maxAllowed: number;
  requested: number;
  activeRuns: number;
  activeWorkers: number;
  rejectedWorkers: number;
  projectKey?: string;
  activeProjectWorkers?: number;
  suggestion: string;
}

interface ActiveRunReservation {
  projectKey: string;
  workerSlots: number;
}

interface SubagentConcurrencyState {
  activeRuns: Map<string, ActiveRunReservation>;
  activeWorkers: number;
  activeProjectWorkers: Map<string, number>;
  rejectedWorkers: number;
  timeoutOrAbortCount: number;
}

declare global {
  var __deerhuxSubagentConcurrency: SubagentConcurrencyState | undefined;
}

export class SubagentConcurrencyLimitError extends Error {
  readonly details: SubagentConcurrencyRejectionDetails;

  constructor(message: string, details: SubagentConcurrencyRejectionDetails) {
    super(message);
    this.name = "SubagentConcurrencyLimitError";
    this.details = details;
  }
}

export interface SubagentWorkerReservation {
  runId: string;
  projectKey: string;
  workerSlots: number;
  release: () => void;
}

function getState(): SubagentConcurrencyState {
  if (!globalThis.__deerhuxSubagentConcurrency) {
    globalThis.__deerhuxSubagentConcurrency = {
      activeRuns: new Map(),
      activeWorkers: 0,
      activeProjectWorkers: new Map(),
      rejectedWorkers: 0,
      timeoutOrAbortCount: 0,
    };
  }
  return globalThis.__deerhuxSubagentConcurrency;
}

export function normalizeSubagentProjectKey(cwd: string): string {
  return path.resolve(cwd || process.cwd());
}

export function getSubagentConcurrencySnapshot(projectKey?: string) {
  const state = getState();
  return {
    activeRuns: state.activeRuns.size,
    activeWorkers: state.activeWorkers,
    rejectedWorkers: state.rejectedWorkers,
    timeoutOrAbortCount: state.timeoutOrAbortCount,
    ...(projectKey ? { activeProjectWorkers: state.activeProjectWorkers.get(projectKey) ?? 0 } : {}),
  };
}

export function getConcurrentWorkerSlots(workflow: string | undefined, workerCount: number): number {
  if (workerCount <= 0) return 0;
  return workflow === "sequential" || workflow === "pipeline" ? 1 : workerCount;
}

export function reserveSubagentWorkerCapacity(params: {
  runId: string;
  cwd: string;
  workerSlots: number;
}): SubagentWorkerReservation {
  const workerSlots = Math.max(0, params.workerSlots);
  const projectKey = normalizeSubagentProjectKey(params.cwd);
  const state = getState();
  const activeProjectWorkers = state.activeProjectWorkers.get(projectKey) ?? 0;
  const suggestion = "请拆分 subagent 任务，或稍后在当前子任务完成后重试。";

  if (state.activeWorkers + workerSlots > GLOBAL_SUBAGENT_WORKER_LIMIT) {
    state.rejectedWorkers += workerSlots;
    const details = {
      scope: "global_workers" as const,
      current: state.activeWorkers,
      maxAllowed: GLOBAL_SUBAGENT_WORKER_LIMIT,
      requested: workerSlots,
      activeRuns: state.activeRuns.size,
      activeWorkers: state.activeWorkers,
      rejectedWorkers: state.rejectedWorkers,
      suggestion,
    };
    logSubagentConcurrency("reject_global_workers", details);
    throw new SubagentConcurrencyLimitError(
      `subagent worker limit exceeded: global active workers ${state.activeWorkers}/${GLOBAL_SUBAGENT_WORKER_LIMIT}, requested ${workerSlots}. ${suggestion}`,
      details,
    );
  }

  if (activeProjectWorkers + workerSlots > PROJECT_SUBAGENT_WORKER_LIMIT) {
    state.rejectedWorkers += workerSlots;
    const details = {
      scope: "project_workers" as const,
      current: activeProjectWorkers,
      maxAllowed: PROJECT_SUBAGENT_WORKER_LIMIT,
      requested: workerSlots,
      activeRuns: state.activeRuns.size,
      activeWorkers: state.activeWorkers,
      rejectedWorkers: state.rejectedWorkers,
      projectKey,
      activeProjectWorkers,
      suggestion,
    };
    logSubagentConcurrency("reject_project_workers", details);
    throw new SubagentConcurrencyLimitError(
      `subagent worker limit exceeded: project active workers ${activeProjectWorkers}/${PROJECT_SUBAGENT_WORKER_LIMIT}, requested ${workerSlots}. ${suggestion}`,
      details,
    );
  }

  state.activeRuns.set(params.runId, { projectKey, workerSlots });
  state.activeWorkers += workerSlots;
  state.activeProjectWorkers.set(projectKey, activeProjectWorkers + workerSlots);
  logSubagentConcurrency("reserve_workers", {
    runId: params.runId,
    projectKey,
    workerSlots,
    ...getSubagentConcurrencySnapshot(projectKey),
  });

  let released = false;
  return {
    runId: params.runId,
    projectKey,
    workerSlots,
    release: () => {
      if (released) return;
      released = true;
      releaseSubagentWorkerCapacity(params.runId);
    },
  };
}

export function releaseSubagentWorkerCapacity(runId: string): void {
  const state = getState();
  const reservation = state.activeRuns.get(runId);
  if (!reservation) return;
  state.activeRuns.delete(runId);
  state.activeWorkers = Math.max(0, state.activeWorkers - reservation.workerSlots);
  const activeProjectWorkers = state.activeProjectWorkers.get(reservation.projectKey) ?? 0;
  const nextProjectWorkers = Math.max(0, activeProjectWorkers - reservation.workerSlots);
  if (nextProjectWorkers === 0) state.activeProjectWorkers.delete(reservation.projectKey);
  else state.activeProjectWorkers.set(reservation.projectKey, nextProjectWorkers);
  logSubagentConcurrency("release_workers", {
    runId,
    projectKey: reservation.projectKey,
    workerSlots: reservation.workerSlots,
    ...getSubagentConcurrencySnapshot(reservation.projectKey),
  });
}

export function recordSubagentTimeoutOrAbort(reason: "timeout" | "abort"): void {
  const state = getState();
  state.timeoutOrAbortCount += 1;
  logSubagentConcurrency(reason, getSubagentConcurrencySnapshot());
}

export function makeSubagentToolCallLimitDetails(current: number, requested: number): SubagentConcurrencyRejectionDetails {
  const state = getState();
  return {
    scope: "tool_call",
    current,
    maxAllowed: MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
    requested,
    activeRuns: state.activeRuns.size,
    activeWorkers: state.activeWorkers,
    rejectedWorkers: state.rejectedWorkers,
    suggestion: "请把同一批工具调用里的多个 subagent 任务拆成先后两轮，等待当前子任务完成并回填结果后再发起下一次。",
  };
}

export function isSubagentConcurrencyLimitError(error: unknown): error is SubagentConcurrencyLimitError {
  return error instanceof SubagentConcurrencyLimitError;
}

function logSubagentConcurrency(event: string, payload: Record<string, unknown>): void {
  console.info("[subagent-concurrency]", event, payload);
}
