export const SUBAGENT_TOOL_NAME = "subagent";
export const MAX_SUBAGENT_TOOL_CALLS_PER_TURN = 1;
export const GLOBAL_SUBAGENT_WORKER_LIMIT = 30;

type SubagentConcurrencyRejectionScope = "tool_call" | "global_workers";

export interface SubagentConcurrencyRejectionDetails {
  scope: SubagentConcurrencyRejectionScope;
  current: number;
  maxAllowed: number;
  requested: number;
  activeRuns: number;
  activeWorkers: number;
  rejectedWorkers: number;
  suggestion: string;
}

interface ActiveRunReservation {
  workerSlots: number;
}

interface SubagentConcurrencyState {
  activeRuns: Map<string, ActiveRunReservation>;
  activeWorkers: number;
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
  workerSlots: number;
  release: () => void;
}

function getState(): SubagentConcurrencyState {
  if (!globalThis.__deerhuxSubagentConcurrency) {
    globalThis.__deerhuxSubagentConcurrency = {
      activeRuns: new Map(),
      activeWorkers: 0,
      rejectedWorkers: 0,
      timeoutOrAbortCount: 0,
    };
  }
  return globalThis.__deerhuxSubagentConcurrency;
}

export function getSubagentConcurrencySnapshot() {
  const state = getState();
  return {
    activeRuns: state.activeRuns.size,
    activeWorkers: state.activeWorkers,
    rejectedWorkers: state.rejectedWorkers,
    timeoutOrAbortCount: state.timeoutOrAbortCount,
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
  const state = getState();
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

  state.activeRuns.set(params.runId, { workerSlots });
  state.activeWorkers += workerSlots;
  logSubagentConcurrency("reserve_workers", {
    workerSlots,
    ...getSubagentConcurrencySnapshot(),
  });

  let released = false;
  return {
    runId: params.runId,
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
  logSubagentConcurrency("release_workers", {
    workerSlots: reservation.workerSlots,
    ...getSubagentConcurrencySnapshot(),
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
  // Keep console diagnostics low-cardinality and free of paths, prompts and ids.
  const safe: Record<string, number> = {};
  for (const key of ["workerSlots", "activeRuns", "activeWorkers", "rejectedWorkers", "timeoutOrAbortCount", "current", "maxAllowed", "requested"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  console.info("[subagent-concurrency]", event, safe);
}
