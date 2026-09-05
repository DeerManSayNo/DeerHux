import path from "path";
import { randomUUID } from "node:crypto";
import fs from "fs";
import { getWorktreeRollout } from "./worktree-rollout.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { summarizeFileChanges } from "./worktree-file-metadata";
import {
  createCollaborationRun,
  compareAndSetCollaborationRun,
  emitCollaborationRunEvent,
  getCollaborationRun,
  removeCollaborationRun,
  setCollaborationAbort,
  setCollaborationCleanup,
  subscribeCollaborationRun,
  updateCollaborationRun,
} from "./collaboration-store";
import type {
  CollaborationRunMode,
  CollaborationRunSnapshot,
  CollaborationRunState,
  CollaborationWorkerSpec,
  SubagentRunPlacement,
  SubagentTaskMode,
  SubagentWorkflow,
} from "./collaboration-types";
import type { AgentEvent } from "@/lib/rpc-manager";
import {
  getIsolatedRunDir,
  getIsolatedRunsRoot,
  getRepoStatus,
  isGitRepo,
  setupIsolatedWorkspace,
} from "./worktree";
import { readWorktreeManifest, transitionWorktreeManifest, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "./worktree-manifest";
import { captureWorktreeArtifact } from "./worktree-artifacts";
import { atomicApply, type AtomicApplyResult } from "./atomic-apply";
import { getGitProcessStartMarker } from "./git-lock";
import { refreshManifestHeartbeat, WORKTREE_TTL_MS } from "./worktree-reconciler";
import { collectGitFacts, executeCleanup, planCleanup, scanRunsRoot } from "./worktree-reconciler";
import { GitRepository } from "./git-repository";
import { claimContinueLease, settleContinueLease, type ContinueLeaseBinding } from "./worktree-continue";
import { sanitizeCollaborationRun } from "./collaboration-sanitize";
import { beginWorktreeOperation, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";
import { getWorkerOrigin } from "./subagent-registry";
import { buildIsolatedWorkerPrompt, buildWorkerPrompt, type PriorWorkerResult } from "./prompts";
import { aggregateSubagentResults } from "./llm-aggregator";
import { planSubagentTaskWithLlm } from "./llm-planner";
import { createSubagentWorkerSession, getAutoRecoveryModels, runWorkerPromptWithRecovery, type WorkerSession } from "./subagent-runner";
import {
  getConcurrentWorkerSlots,
  recordSubagentTimeoutOrAbort,
  reserveSubagentWorkerCapacity,
  type SubagentWorkerReservation,
} from "./subagent-concurrency";

export {
  abortCollaborationRun,
  getCollaborationRun,
  listCollaborationRuns,
  subscribeCollaborationRun,
} from "./collaboration-store";

export class CollaborationApplyRequestError extends Error {
  constructor(
    readonly status: 404 | 412 | 503,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "CollaborationApplyRequestError";
  }
}

/** 从工具执行事件里提取人类可读摘要（命令/文件路径/查询词） */
function summarizeToolEvent(event: AgentEvent): { toolName: string; summary: string } {
  const toolName = typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "";
  const asRecord = (value: unknown): Record<string, unknown> | null => (
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  );
  const input = asRecord(event.input);
  const args = asRecord(event.args);
  const sources = [input, args, asRecord(event), asRecord(input?.args), asRecord(input?.input)].filter(Boolean) as Record<string, unknown>[];
  const readPath = (source: Record<string, unknown>, keyPath: string): unknown => (
    keyPath.split(".").reduce<unknown>((acc, key) => (
      acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined
    ), source)
  );
  const pick = (...keys: string[]): string => {
    for (const source of sources) {
      for (const key of keys) {
        const value = readPath(source, key);
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        if (Array.isArray(value) && value.length > 0) return value.map((item) => String(item)).join(", ");
      }
    }
    return "";
  };
  let summary = "";
  switch (toolName) {
    case "bash":
    case "sh":
      summary = pick("command", "cmd");
      break;
    case "edit":
    case "write":
    case "read":
      summary = pick("filePath", "file_path", "path", "target_file");
      break;
    case "grep":
      summary = pick("pattern", "query", "path", "glob");
      break;
    case "find":
      summary = pick("path", "pattern", "glob", "name");
      break;
    case "code_search":
      summary = pick("query", "text", "q");
      break;
    case "codegraph": {
      const action = pick("action");
      const target = pick("query", "symbol");
      summary = [action, target].filter(Boolean).join(": ");
      break;
    }
    case "subagent":
      summary = pick("message", "task", "prompt");
      break;
    default:
      summary = pick("filePath", "file_path", "path", "command", "cmd", "query", "symbol", "message", "pattern");
  }
  return { toolName, summary };
}

/** 捕获 worker 的 tool_execution_start/end 事件，更新其活动工具状态。
 *  这些字段随 collaboration run 快照推送给前端，供 SubagentRunCard 流式展示。 */
function updateWorkerToolActivity(runId: string, workerIndex: number, event: AgentEvent): void {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
  updateCollaborationRun(runId, (run) => {
    const target = run.workers[workerIndex];
    if (!target) return;
    const { toolName, summary } = summarizeToolEvent(event);
    const ts = new Date().toISOString();
    if (event.type === "tool_execution_start") {
      target.activeTool = { toolName, summary, status: "running", ts };
      return;
    }
    // tool_execution_end：把 activeTool 收进 recentTools，清空 activeTool
    const finished = target.activeTool
      ? { ...target.activeTool, status: (event.isError ? "error" : "done") as "done" | "error", ts }
      : { toolName, summary, status: (event.isError ? "error" : "done") as "done" | "error", ts };
    target.activeTool = undefined;
    target.recentTools = [finished, ...(target.recentTools ?? [])].slice(0, 8);
  });
}

const TERMINAL_RUN_STATUSES = new Set<CollaborationRunState["status"]>(["complete", "aborted", "error", "applied", "recoverable"]);
const TERMINAL_RUN_EVENTS = new Set(["run_complete", "run_error", "run_aborted"]);
const SUBAGENT_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function snapshotRun(state: CollaborationRunState): CollaborationRunSnapshot {
  return sanitizeCollaborationRun({
    runId: state.runId,
    version: state.version,
    taskId: state.runId,
    parentEntryId: state.parentEntryId,
    title: state.title,
    mode: state.mode,
    taskMode: state.taskMode,
    runPlacement: state.runPlacement,
    workflow: state.workflow,
    status: state.status,
    message: state.message,
    workers: state.workers.map((worker) => {
      const { sessionId: _sessionId, worktreePath: _worktreePath, diff: _diff, patchPath: _patchPath, ...snapshot } = worker as typeof worker & { patchPath?: unknown };
      return snapshot;
    }),
    baseCommit: state.baseCommit,
    captureState: state.captureState,
    applyState: state.applyState,
    applyTransactionId: state.applyTransactionId,
    applyStartedAt: state.applyStartedAt,
    recoveryState: state.recoveryState,
    summary: state.summary,
    error: state.error,
    canContinue: state.canContinue,
    continueUnavailableReason: state.continueUnavailableReason,
    continueExpiresAt: state.continueExpiresAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}

async function appendRunSnapshot(parentSessionId: string | undefined, state: CollaborationRunState): Promise<void> {
  if (!parentSessionId) return;
  try {
    const filePath = await resolveSessionPath(parentSessionId);
    if (!filePath) return;
    const manager = SessionManager.open(filePath);
    manager.appendCustomEntry("agent_collaboration_run", snapshotRun(state));
    invalidateSessionListCache();
  } catch {
    // Best effort: collaboration still runs even if the parent session cannot be annotated.
  }
}

export async function startCollaborationRun(params: {
  cwd: string;
  message: string;
  workers?: CollaborationWorkerSpec[];
  mode?: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  workflow?: SubagentWorkflow;
  runPlacement?: SubagentRunPlacement;
  title?: string;
  parentSessionId?: string;
  parentEntryId?: string;
  parentModel?: { provider: string; modelId: string };
}): Promise<CollaborationRunState> {
  if ((params.mode === "isolated_coding" || (!params.mode && params.taskMode === "code"))
    && !getWorktreeRollout().newRunsEnabled) throw new Error("WORKTREE_V2_DISABLED");
  const runId = `collab_${randomUUID()}`;
  const now = new Date().toISOString();
  const cwd = path.resolve(params.cwd);
  // mode→taskMode 的兜底推断（用户只给了 mode 没给 taskMode 时）。
  const inferredTaskMode = params.taskMode
    ?? (params.mode === "isolated_coding" ? "code" : params.mode === "analysis" ? "ask" : undefined);
  // ★ LLM 智能规划：用 parentModel 推断 taskMode/workflow/workers；用户显式字段
  //   优先，无 model / 超时 / 失败则透明回退正则（planSubagentTaskWithLlm 内部处理）。
  //   规划延迟体现为 subagent 工具的 pending，有 30s 超时兜底，不会卡死。
  const planned = await planSubagentTaskWithLlm({
    message: params.message,
    model: params.parentModel,
    taskMode: inferredTaskMode,
    placement: params.runPlacement,
    workflow: params.workflow,
    workers: params.workers,
  });
  const mode = params.mode ?? planned.mode;
  const workflow = planned.workflow;
  const workerNames = planned.workers.map((worker) => worker.name.trim());
  if (workerNames.some((name) => !name)) throw new Error("Worker names must not be empty");
  if (new Set(workerNames).size !== workerNames.length) throw new Error("Worker names must be unique within a run");
  const plannedWorkerNames = new Set(workerNames);
  for (const worker of planned.workers) {
    for (const dependency of worker.dependsOn ?? []) {
      if (!plannedWorkerNames.has(dependency) || dependency === worker.name) {
        throw new Error(`Worker dependency cannot be resolved: ${dependency}`);
      }
    }
  }
  if (mode === "isolated_coding") {
    if (!getWorktreeRollout().newRunsEnabled) throw new Error("WORKTREE_V2_DISABLED");
    if (!(await isGitRepo(cwd))) throw new Error("Code in Isolation requires a git repository so diffs can be reviewed and applied.");
    const repoStatus = await getRepoStatus(cwd);
    if (!repoStatus.clean) {
      throw new Error(`GIT_DIRTY_WORKTREE: source repository has ${repoStatus.files.length} changed file(s)`);
    }
  }
  const workerReservation = reserveSubagentWorkerCapacity({
    runId,
    cwd,
    workerSlots: getConcurrentWorkerSlots(workflow, planned.workers.length),
  });
  const state: CollaborationRunState = {
    runId,
    version: 0,
    parentSessionId: params.parentSessionId,
    parentEntryId: params.parentEntryId,
    model: params.parentModel,
    cwd,
    title: params.title ?? planned.title,
    message: planned.message,
    mode,
    taskMode: planned.taskMode,
    runPlacement: planned.runPlacement,
    workflow,
    status: mode === "isolated_coding" ? "setting_up" : "running",
    isGit: mode === "isolated_coding" ? true : await isGitRepo(params.cwd),
    worktreeManifestPath: mode === "isolated_coding"
      ? path.join(getIsolatedRunDir(runId), "worktree-manifest.json")
      : undefined,
    worktreeImplementation: mode === "isolated_coding" ? 2 : undefined,
    canContinue: false,
    continueUnavailableReason: "Subagent run is still running.",
    workers: planned.workers.map((worker, index) => ({
      ...worker,
      workerId: `${runId}_worker_${index + 1}`,
      title: worker.name,
      instructions: worker.task,
      agentType: planned.taskMode,
      capability: mode === "isolated_coding" ? "isolated_coding" : planned.taskMode === "review" ? "review" : "readonly",
      status: "pending",
      workerSessionState: "running",
      canContinue: false,
      continueUnavailableReason: "Worker session is not available yet.",
    })),
    events: [],
    createdAt: now,
    updatedAt: now,
  };
  const workerIdByName = new Map(state.workers.map((worker) => [worker.name, worker.workerId]));
  for (const worker of state.workers) {
    if (worker.dependsOn) worker.dependsOn = worker.dependsOn.map((dependency) => workerIdByName.get(dependency) ?? dependency);
  }

  try {
    createCollaborationRun(state);
    emitCollaborationRunEvent({ type: "task_created", runId, summary: state.title });
    await appendRunSnapshot(params.parentSessionId, state);

    executeCollaborationRun(runId, workerReservation).catch(async (error: unknown) => {
      workerReservation.release();
      const err = error instanceof Error ? error.message : String(error);
      const updated = updateCollaborationRun(runId, (run) => {
        run.status = "error";
        run.error = err;
        run.canContinue = false;
      });
      if (updated) {
        emitCollaborationRunEvent({ type: "run_error", runId, error: err });
        await appendRunSnapshot(updated.parentSessionId, updated);
      }
    });

    return state;
  } catch (error) {
    workerReservation.release();
    throw error;
  }
}

/** isolated_coding run 终态后保留 worktree 的时长：apply/continue 通常很快，2h 足够且不占太久。 */
const ISOLATED_WORKTREE_RETENTION_MS = WORKTREE_TTL_MS;
/** analysis 无 worktree，且 worker session 内存已销毁；短暂保留 run 只为返回明确不可继续原因。 */
const ANALYSIS_RUN_RETENTION_MS = 10 * 60 * 1000;

export function waitForCollaborationRun(runId: string): Promise<CollaborationRunState> {
  const existing = getCollaborationRun(runId);
  if (!existing) return Promise.reject(new Error("Run not found"));
  if (TERMINAL_RUN_STATUSES.has(existing.status)) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    unsubscribe = subscribeCollaborationRun(runId, (event) => {
      if (!TERMINAL_RUN_EVENTS.has(event.type)) return;
      unsubscribe?.();
      const latest = getCollaborationRun(runId);
      if (latest) resolve(latest);
      else reject(new Error("Run not found after completion"));
    });
  });
}

/**
 * 按 run 模式调度终态回收。analysis 明确标记不可继续后短暂保留；
 * isolated_coding 保留 worktree/jsonl 2h 供 continue；到期只标记失效，成果由显式
 * Apply/Discard 或后续基于 manifest 的 reconciler 处理。
 */
function scheduleRunReclaim(runId: string, mode: CollaborationRunMode): void {
  if (mode === "isolated_coding") {
    const expiresAt = new Date(Date.now() + ISOLATED_WORKTREE_RETENTION_MS).toISOString();
    const updated = updateCollaborationRun(runId, (run) => {
      if (run.recoveryState) {
        run.canContinue = false;
        run.continueUnavailableReason = "Run requires manual recovery.";
        for (const worker of run.workers) {
          worker.canContinue = false;
          worker.continueUnavailableReason = "Run requires manual recovery.";
        }
        return;
      }
      run.continueUnavailableReason = undefined;
      run.continueExpiresAt = expiresAt;
      for (const worker of run.workers) {
        if (!worker.sessionId || !worker.worktreePath || worker.status === "aborted") {
          worker.workerSessionState = worker.status === "aborted" ? "deleted" : "complete_memory_destroyed";
          worker.canContinue = false;
          worker.continueUnavailableReason = worker.status === "aborted"
            ? "Worker was aborted and cannot be continued."
            : "Worker session or workspace is not available.";
          worker.continueExpiresAt = undefined;
          continue;
        }
        worker.workerSessionState = "reopenable_from_jsonl";
        worker.canContinue = true;
        worker.continueUnavailableReason = undefined;
        worker.continueExpiresAt = expiresAt;
      }
      run.canContinue = run.workers.some((worker) => worker.canContinue);
      if (!run.canContinue) {
        run.continueUnavailableReason = "No workers are currently available to continue.";
        run.continueExpiresAt = undefined;
      }
    });
    if (updated) void appendRunSnapshot(updated.parentSessionId, updated);
    setTimeout(() => {
      try {
        const expired = updateCollaborationRun(runId, (run) => {
          run.canContinue = false;
          run.continueUnavailableReason = "Subagent worktree retention expired.";
          for (const worker of run.workers) {
            worker.workerSessionState = "expired";
            worker.canContinue = false;
            worker.continueUnavailableReason = "Subagent worktree retention expired.";
          }
        });
        if (expired) void appendRunSnapshot(expired.parentSessionId, expired);
      } catch { /* best effort */ }
    }, ISOLATED_WORKTREE_RETENTION_MS).unref?.();
    return;
  }
  const updated = updateCollaborationRun(runId, (run) => {
    run.canContinue = false;
    run.continueUnavailableReason = "Analysis subagent runs do not retain worker sessions for continue.";
    for (const worker of run.workers) {
      worker.workerSessionState = "complete_memory_destroyed";
      worker.canContinue = false;
      worker.continueUnavailableReason = "Analysis subagent runs do not retain worker sessions for continue.";
      worker.continueExpiresAt = undefined;
    }
  });
  if (updated) void appendRunSnapshot(updated.parentSessionId, updated);
  setTimeout(() => {
    void removeCollaborationRun(runId).catch(() => {});
  }, ANALYSIS_RUN_RETENTION_MS).unref?.();
}

async function executeCollaborationRun(runId: string, workerReservation?: SubagentWorkerReservation): Promise<void> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");

  let aborted = false;
  const setupController = new AbortController();
  let runDir = "";
  let isGit = false;
  let manifestPath = state.worktreeManifestPath;
  let worktrees: Map<string, string> = new Map();
  let agentCwds: Map<string, string> = new Map();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const workerSessions: WorkerSession[] = [];

  const cleanupAll = async () => {
    if (runDir) {
      if (!manifestPath) throw new Error("Worktree manifest is required for cleanup");
      const scanned = scanRunsRoot(path.dirname(runDir)).runs.find((candidate) => candidate.manifestPath === manifestPath || candidate.manifest.runId === state.runId);
      if (!scanned) throw new Error("Strict worktree manifest scan rejected cleanup");
      const facts = Object.fromEntries(scanned.manifest.workers.map((worker) => [worker.workerId, collectGitFacts(scanned.manifest, worker, scanned.runDir)]));
      const plan = planCleanup(scanned, facts, { instanceId: SUBAGENT_INSTANCE_ID, processStartIdentity: getGitProcessStartMarker() });
      const cleaned = await executeCleanup(plan, { instanceId: SUBAGENT_INSTANCE_ID, processStartIdentity: getGitProcessStartMarker() });
      if (!cleaned.complete) throw new Error("Worktree cleanup was not fully authorized or completed");
    }
    for (const session of workerSessions) {
      try { session.destroy(); } catch { /* best effort */ }
    }
  };

  setCollaborationAbort(runId, async () => {
    aborted = true;
    setupController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    recordSubagentTimeoutOrAbort("abort");
    await Promise.all(workerSessions.map((session) => session.abort().catch(() => {})));
    for (const session of workerSessions) {
      try { session.destroy(); } catch { /* best effort */ }
    }
    const updated = updateCollaborationRun(runId, (run) => {
      run.status = "aborted";
      run.canContinue = false;
      run.continueUnavailableReason = "Subagent run was aborted.";
      for (const worker of run.workers) {
        if (worker.status === "pending" || worker.status === "running") worker.status = "aborted";
        worker.workerSessionState = "deleted";
        worker.canContinue = false;
        worker.continueUnavailableReason = "Subagent run was aborted.";
      }
    });
    if (!updated) throw new Error("ABORT_STATE_PERSISTENCE_FAILED");
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    await appendRunSnapshot(updated.parentSessionId, updated);
    // Abort 只停止执行。Worktree 必须保留到显式 Discard 或成果被安全捕获。
    workerReservation?.release();
  });
  setCollaborationCleanup(runId, cleanupAll);

  if (state.mode === "isolated_coding") {
    runDir = getIsolatedRunDir(state.runId);
    const workspace = await setupIsolatedWorkspace(state.cwd, state.runId, SUBAGENT_INSTANCE_ID, state.workers.map((worker) => ({
      workerId: worker.workerId,
      displayName: worker.name,
    })), { signal: setupController.signal });
    runDir = workspace.runDir;
    isGit = workspace.isGit;
    manifestPath = workspace.manifestPath;
    worktrees = workspace.worktrees;
    agentCwds = workspace.agentCwds;
    const setupCommitted = updateCollaborationRun(runId, (run) => {
      run.status = "running";
      run.canContinue = false;
      run.continueUnavailableReason = "Subagent run is still running.";
      run.isGit = isGit;
      run.worktreeManifestPath = workspace.manifestPath;
      run.baseCommit = workspace.baseCommit;
      for (const worker of run.workers) worker.worktreePath = worktrees.get(worker.workerId);
    });
    if (!setupCommitted) throw new Error("RUN_SETUP_STATE_PERSISTENCE_FAILED");
    emitCollaborationRunEvent({ type: "run_setup_complete", runId });
    heartbeatTimer = setInterval(() => {
      if (!manifestPath || !refreshManifestHeartbeat(manifestPath, SUBAGENT_INSTANCE_ID, getGitProcessStartMarker(), "running")) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    }, 15_000);
    heartbeatTimer.unref?.();
  }

  const current = getCollaborationRun(runId);
  if (!current || aborted) {
    workerReservation?.release();
    return;
  }
  const recoveryModels = getAutoRecoveryModels();

  /** 收集 index 这个 worker 应注入的前序 worker 结论（sequential/pipeline/dag 用）。
   *  优先按 dependsOn 显式声明；未声明时 fallback 到顺序前一个。 */
  const collectPriorResults = (index: number): PriorWorkerResult[] => {
    const run = getCollaborationRun(runId);
    if (!run) return [];
    const worker = run.workers[index];
    const dependencyIds = worker?.dependsOn ?? [];
    const deps = dependencyIds.length > 0
      ? dependencyIds.map((dependencyId) => run.workers.find((w) => w.workerId === dependencyId)).filter((w): w is NonNullable<typeof w> => Boolean(w))
      : (index > 0 ? [run.workers[index - 1]].filter((w): w is NonNullable<typeof w> => Boolean(w)) : []);
    return deps
      .filter((w) => w.status === "complete" && w.result?.trim())
      .map((w) => ({ name: w.name, task: w.task, result: w.result ?? "" }));
  };

  /** 执行单个 worker（parallel 与 sequential 复用）。priorResults 为前序结论注入。
   *  返回 result（失败/中止时为 undefined）。 */
  const executeOneWorker = async (worker: (typeof current.workers)[number], index: number, priorResults: PriorWorkerResult[]): Promise<string | undefined> => {
    if (aborted) return undefined;
    const workerCwd = current.mode === "isolated_coding" ? agentCwds.get(worker.workerId) : current.cwd;
    if (!workerCwd) {
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "error";
          target.error = "Worker workspace was not created";
        }
      });
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.workerId, error: "Worker workspace was not created" });
      return undefined;
    }

    let unsubscribeWorkerEvents: (() => void) | null = null;
    try {
      const workerSession = await createSubagentWorkerSession(workerCwd, current.mode, undefined, {
        parentSessionId: current.parentSessionId,
        runId: current.runId,
        workerName: worker.name,
      }, current.model);
      workerSessions.push(workerSession);
      // abort 可能发生在异步创建 Session 期间；创建完成后必须重新检查，
      // 否则已中止的 run 仍会继续发送 prompt、执行工具并泄漏 runtime。
      if (aborted) {
        await workerSession.abort().catch(() => {});
        workerSession.destroy();
        return undefined;
      }
      // Session 此时只是创建完成，prompt 尚未通过准入。不要提前暴露 sessionId，
      // 否则用户会打开一个 (no messages) 窗口，甚至与 worker 的启动链路竞争。
      unsubscribeWorkerEvents = workerSession.listen((event) => {
        emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.workerId, event });
        updateWorkerToolActivity(runId, index, event);
      });
      const prompt = current.mode === "analysis"
        ? buildWorkerPrompt(current.message, worker.task, priorResults)
        : buildIsolatedWorkerPrompt(current.message, worker.task, priorResults);
      const result = await runWorkerPromptWithRecovery(
        workerSession,
        prompt,
        recoveryModels,
        (model, attempt, error) => {
          const message = error instanceof Error ? error.message : String(error);
          emitCollaborationRunEvent({
            type: "worker_event",
            runId,
            workerId: worker.workerId,
            event: {
              type: "auto_recovery_start",
              attempt,
              provider: model.provider,
              modelId: model.modelId,
              errorMessage: message,
            },
          });
        },
        () => {
          // worker 已发出 agent_start：prompt 已完成准入并进入实际执行链路。
          // 这是卡片允许打开 worker 会话的安全边界。
          updateCollaborationRun(runId, (run) => {
            const target = run.workers[index];
            if (!target) return;
            target.status = "running";
            target.sessionId = workerSession.sessionId;
            target.workerSessionState = "running";
            target.canContinue = false;
            target.continueUnavailableReason = "Worker is still running.";
          });
          emitCollaborationRunEvent({ type: "worker_start", runId, workerId: worker.workerId });
        },
      );
      unsubscribeWorkerEvents();
      unsubscribeWorkerEvents = null;

      if (aborted) {
        updateCollaborationRun(runId, (run) => {
          const target = run.workers[index];
          if (target) {
            target.status = "aborted";
            target.workerSessionState = "deleted";
            target.canContinue = false;
            target.continueUnavailableReason = "Worker was aborted.";
          }
        });
        return undefined;
      }

      if (current.mode === "isolated_coding" && manifestPath) {
        emitCollaborationRunEvent({ type: "worker_capture_started", runId, workerId: worker.workerId });
      }
      const captureResult = current.mode === "isolated_coding" && manifestPath
        ? await captureWorktreeArtifact(manifestPath, worker.workerId, { diagnosticRunId: runId })
        : null;
      // Abort may settle while Git capture is awaiting child processes. Keep any
      // artifact it produced, but never replace the stopped Worker projection.
      if (aborted) return undefined;
      const capturedWorker = compareAndSetCollaborationRun(runId, { allowedStatuses: ["running"] }, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "complete";
          target.result = result;
          target.workerSessionState = "complete_memory_destroyed";
          target.canContinue = false;
          target.continueUnavailableReason = "Continue availability is being finalized.";
          if (captureResult) {
            target.diff = undefined;
            target.patchSha256 = captureResult.capture?.patchSha256 ?? undefined;
            target.patchBytes = captureResult.capture?.patchBytes ?? undefined;
            target.changedFiles = captureResult.capture?.changedFiles ?? [];
            target.binaryFiles = captureResult.capture?.binaryFiles ?? [];
            target.changeStats = summarizeFileChanges(captureResult.capture?.fileChanges);
            target.diffStats = (captureResult.capture?.changedFiles ?? []).join("\n");
            target.captureErrorCode = captureResult.errorCode ?? undefined;
            if (!captureResult.ok) {
              target.status = "error";
              target.error = captureResult.error ?? "Artifact capture failed";
              run.captureState = captureResult.manifestStatePersisted ? "preserved" : "failed";
              if (!captureResult.manifestStatePersisted) run.recoveryState = "manual_recovery_required";
            }
          }
        }
      });
      if (!capturedWorker.ok) throw new Error("CAPTURE_STATE_PERSISTENCE_FAILED");
      if (captureResult) {
        emitCollaborationRunEvent({
          type: captureResult.ok ? "worker_capture_completed" : "worker_capture_error",
          runId, workerId: worker.workerId,
          errorCode: captureResult.errorCode ?? undefined,
          fileCount: captureResult.capture?.changedFiles.length ?? 0,
          binaryFileCount: captureResult.capture?.binaryFiles.length ?? 0,
        });
        if (!captureResult.ok) {
          emitCollaborationRunEvent({ type: "worktree_preserved", runId, workerId: worker.workerId, reasonCode: "CAPTURE_FAILED" });
        }
      }
      emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.workerId, result });

      const latestWorker = getCollaborationRun(runId)?.workers[index];
      if (latestWorker?.patchSha256) {
        emitCollaborationRunEvent({
          type: "worker_diff_ready",
          runId,
          workerId: worker.workerId,
          diffStats: latestWorker.diffStats,
        });
      }
      return result;
    } catch (error) {
      unsubscribeWorkerEvents?.();
      if (aborted) return undefined;
      const err = error instanceof Error ? error.message : String(error);
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "error";
          target.error = err;
          target.workerSessionState = target.sessionId ? "complete_memory_destroyed" : undefined;
          target.canContinue = false;
          target.continueUnavailableReason = err;
        }
      });
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.workerId, error: err });
      return undefined;
    }
  };

  // ── 按 workflow 调度 worker ───────────────────────────────────
  // parallel：全部同时启动（Promise.all fan-out），互不可见。
  // sequential/pipeline/dag：逐次执行，每个 worker 执行前收集其依赖（或前一个）
  //   worker 的结论注入 prompt。dag 当前按声明顺序降级为 sequential。
  const workflow = current.workflow ?? "parallel";
  if (workflow === "parallel") {
    await Promise.all(current.workers.map((worker, index) => executeOneWorker(worker, index, [])));
  } else {
    for (let index = 0; index < current.workers.length; index += 1) {
      if (aborted) break;
      await executeOneWorker(current.workers[index], index, collectPriorResults(index));
      if (aborted) break;
    }
  }

  if (aborted) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    workerReservation?.release();
    return;
  }

  const terminalProjection = getCollaborationRun(runId);
  if (manifestPath && terminalProjection?.captureState !== "failed" && !terminalProjection?.recoveryState) {
    const manifestResult = readWorktreeManifest(manifestPath);
    if (manifestResult.kind === "ok") {
      try {
        if (manifestResult.manifest.state === "captured") {
          updateCollaborationRun(runId, (run) => { run.captureState = "captured"; });
        } else {
          for (const worker of manifestResult.manifest.workers) {
            if (worker.state === "running") worker.state = "stopped";
          }
          const preserved = manifestResult.manifest.state === "preserved"
            ? manifestResult.manifest
            : transitionWorktreeManifest(manifestResult.manifest, "preserved", { caller: "runner", now: new Date().toISOString() });
          writeWorktreeManifestAtomic(manifestPath, preserved);
          updateCollaborationRun(runId, (run) => { run.captureState = "preserved"; });
          emitCollaborationRunEvent({ type: "worktree_preserved", runId, reasonCode: "INCOMPLETE_CAPTURE" });
        }
      } catch {
        updateCollaborationRun(runId, (run) => { run.recoveryState = "manual_recovery_required"; });
      }
    } else {
      updateCollaborationRun(runId, (run) => { run.recoveryState = "manual_recovery_required"; });
    }
  }
  if (manifestPath) refreshManifestHeartbeat(manifestPath, SUBAGENT_INSTANCE_ID, getGitProcessStartMarker(), null);

  // Keep the run admitted until aggregation and the authoritative final snapshot
  // are committed together. A failed write must not masquerade as completion.
  const forAggregate = getCollaborationRun(runId);
  const summary = forAggregate
    ? await aggregateSubagentResults(forAggregate, { model: current.model })
    : "";
  const finalized = aborted ? undefined : compareAndSetCollaborationRun(runId, { allowedStatuses: ["running"] }, (run) => {
    run.summary = summary;
    run.status = run.recoveryState ? "recoverable" : run.workers.some((worker) => worker.status === "error") ? "error" : "complete";
    if (run.status === "error") run.error = "One or more child agents failed";
    run.canContinue = false;
    run.continueUnavailableReason = "Continue availability is being finalized.";
  });
  const completed = finalized?.ok ? finalized.state : undefined;
  if (!completed) {
    for (const session of workerSessions) {
      try { session.destroy(); } catch { /* best effort */ }
    }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    workerReservation?.release();
    if (aborted) return;
    throw new Error("RUN_FINALIZATION_STATE_PERSISTENCE_FAILED");
  }
  emitCollaborationRunEvent({
    type: completed.status === "complete" ? "run_complete" : "run_error",
    runId,
    summary: completed.summary,
    error: completed.error,
  });
  await appendRunSnapshot(completed.parentSessionId, completed);
  workerReservation?.release();

  // 终态回收（P0-1/P0-2）：worker session 在 run 终态后不再需要，立即 destroy。
  // worktree + Map + jsonl 按模式分流：
  //   - analysis（只读）：无 worktree 且内存 session 已销毁，明确标记不可继续后短暂保留。
  //   - isolated_coding：apply/continue 需要 worktree + worker jsonl，保留到 TTL。
  for (const session of workerSessions) {
    try { session.destroy(); } catch { /* best effort */ }
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  scheduleRunReclaim(completed.runId, completed.mode);
}

function assertWorkerCanContinue(
  state: CollaborationRunState,
  worker: CollaborationRunState["workers"][number],
): void {
  if (state.recoveryState) throw new Error("Run requires manual recovery and cannot be continued.");
  if (state.status === "applied") throw new Error("Subagent run has already been applied and cannot be continued.");
  if (state.status === "aborted") throw new Error("Subagent run was aborted and cannot be continued.");
  if (state.status === "applying") throw new Error("Subagent patches are currently being applied; continue is unavailable.");
  if (state.status === "running" || state.status === "setting_up") throw new Error("Subagent run is still running.");
  if (state.mode === "analysis") {
    throw new Error(state.continueUnavailableReason ?? "Analysis subagent runs do not retain worker sessions for continue.");
  }
  if (state.canContinue === false) {
    throw new Error(state.continueUnavailableReason ?? "Subagent run cannot be continued.");
  }
  if (worker.canContinue === false) {
    throw new Error(worker.continueUnavailableReason ?? "Worker cannot be continued.");
  }
  if (worker.appliedFiles?.length) {
    throw new Error("Worker changes were already applied; continue is unavailable.");
  }
  if (worker.workerSessionState === "expired") throw new Error(worker.continueUnavailableReason ?? "Worker continue window expired.");
  if (worker.workerSessionState === "deleted") throw new Error(worker.continueUnavailableReason ?? "Worker session was deleted.");
  const expiresAt = worker.continueExpiresAt ?? state.continueExpiresAt;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new Error("Worker continue window expired.");
  }
  if (!worker.sessionId) throw new Error("Worker session is not available yet.");
}

export async function continueCollaborationWorker(runId: string, workerId: string, prompt?: string): Promise<CollaborationRunState> {
  const operation = beginWorktreeOperation("continue", { runId, workerId });
  try {
    const result = await continueCollaborationWorkerInternal(runId, workerId, prompt);
    operation.finish(result.status === "aborted" ? "aborted" : result.status === "error" || result.status === "recoverable" ? "failed" : "completed", {
      reason: result.status === "aborted" ? "cancelled" : result.error ? worktreeDiagnosticReason(result.error) : "none",
    });
    return result;
  } catch (error) {
    operation.finish("failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

async function continueCollaborationWorkerInternal(runId: string, workerId: string, prompt?: string): Promise<CollaborationRunState> {
  let continueHeartbeat: ReturnType<typeof setInterval> | undefined;
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");
  const workerIndex = state.workers.findIndex((item) => item.workerId === workerId);
  const worker = workerIndex >= 0 ? state.workers[workerIndex] : undefined;
  if (!worker) throw new Error("Worker not found");
  const previous = {
    runStatus: state.status,
    runCanContinue: state.canContinue,
    runReason: state.continueUnavailableReason,
    workerStatus: worker.status,
    workerSessionState: worker.workerSessionState,
    workerCanContinue: worker.canContinue,
    workerReason: worker.continueUnavailableReason,
  };
  assertWorkerCanContinue(state, worker);
  const admitted = compareAndSetCollaborationRun(runId, {
    expectedVersion: state.version,
    allowedStatuses: ["complete", "error", "recoverable"],
  }, (run) => {
    run.status = "running";
    run.canContinue = false;
    run.continueUnavailableReason = "Worker continue is being validated.";
    const target = run.workers[workerIndex];
    if (target) {
      target.status = "running";
      target.workerSessionState = "running";
      target.canContinue = false;
      target.continueUnavailableReason = "Worker continue is being validated.";
    }
  });
  if (!admitted.ok) throw new Error("CONTINUE_ADMISSION_FAILED");
  const admissionVersion = admitted.state.version;

  let workerReservation: SubagentWorkerReservation;
  try {
    workerReservation = reserveSubagentWorkerCapacity({
      runId: `${runId}:continue:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      cwd: state.cwd,
      workerSlots: 1,
    });
  } catch (error) {
    compareAndSetCollaborationRun(runId, { expectedVersion: admissionVersion, allowedStatuses: ["running"] }, (run) => {
      run.status = previous.runStatus;
      run.canContinue = previous.runCanContinue;
      run.continueUnavailableReason = previous.runReason;
      const target = run.workers[workerIndex];
      if (target) {
        target.status = previous.workerStatus;
        target.workerSessionState = previous.workerSessionState;
        target.canContinue = previous.workerCanContinue;
        target.continueUnavailableReason = previous.workerReason;
      }
    });
    throw error;
  }
  let continueBinding: ContinueLeaseBinding | null = null;
  let workerSession: WorkerSession | null = null;
  let continuationAborted = false;
  setCollaborationAbort(runId, async () => {
    continuationAborted = true;
    await workerSession?.abort();
    const stopped = updateCollaborationRun(runId, (run) => {
      run.status = "aborted";
      run.canContinue = false;
      run.continueUnavailableReason = "Subagent run was aborted.";
      const target = run.workers[workerIndex];
      if (target) {
        target.status = "aborted";
        target.canContinue = false;
        target.workerSessionState = "complete_memory_destroyed";
        target.continueUnavailableReason = "Worker was aborted.";
      }
    });
    if (!stopped) throw new Error("ABORT_STATE_PERSISTENCE_FAILED");
    emitCollaborationRunEvent({ type: "run_aborted", runId });
  });
  let workerCwd = state.cwd;
  if (state.mode === "isolated_coding") {
    try {
      if (!worker.sessionId) throw new Error("Worker session is not available yet");
      const sessionFile = await resolveSessionPath(worker.sessionId);
      if (!sessionFile || !fs.existsSync(sessionFile) || fs.lstatSync(sessionFile).isSymbolicLink()) {
        throw new Error("Worker session file was not found or is unsafe; continue is unavailable");
      }
      const sessionHeader = SessionManager.open(sessionFile).getHeader();
      const sessionOrigin = await getWorkerOrigin(worker.sessionId);
      const repository = await GitRepository.open(state.cwd, { instanceId: SUBAGENT_INSTANCE_ID });
      continueBinding = await claimContinueLease({
        runsRoot: getIsolatedRunsRoot(),
        runId,
        workerId: worker.workerId,
        repository,
        expectedBaseCommit: state.baseCommit,
        sessionId: worker.sessionId,
        sessionHeader,
        sessionOrigin: sessionOrigin ?? null,
        instanceId: SUBAGENT_INSTANCE_ID,
      });
      if (continuationAborted || getCollaborationRun(runId)?.status !== "running") {
        throw new Error("CONTINUE_CANCELLED");
      }
      workerCwd = continueBinding.agentCwd;
      continueHeartbeat = setInterval(() => {
        if (!continueBinding || !refreshManifestHeartbeat(continueBinding.manifestPath, SUBAGENT_INSTANCE_ID, getGitProcessStartMarker(), "continue")) {
          if (continueHeartbeat) clearInterval(continueHeartbeat);
          continueHeartbeat = undefined;
        }
      }, 15_000);
      continueHeartbeat.unref?.();
    } catch (error) {
      workerReservation.release();
      if (continueBinding) await settleContinueLease(continueBinding);
      compareAndSetCollaborationRun(runId, { expectedVersion: admissionVersion, allowedStatuses: ["running"] }, (run) => {
        run.status = "recoverable";
        run.canContinue = false;
        run.recoveryState = "manual_recovery_required";
        run.continueUnavailableReason = "Worktree manifest requires manual recovery.";
        const target = run.workers[workerIndex];
        if (target) {
          target.status = previous.workerStatus;
          target.workerSessionState = previous.workerSessionState;
          target.canContinue = false;
          target.continueUnavailableReason = "Worktree manifest requires manual recovery.";
        }
      });
      throw error;
    }
  }
  const message = prompt?.trim() || "请继续这个子任务，基于当前会话上下文补充结论、修复遗漏，并给出最新摘要。";
  const recoveryModels = getAutoRecoveryModels();
  let unsubscribeWorkerEvents: (() => void) | null = null;

  updateCollaborationRun(runId, (run) => {
    run.continueUnavailableReason = "Worker continue is running.";
    const target = run.workers[workerIndex];
    if (target) target.continueUnavailableReason = "Worker continue is running.";
  });
  emitCollaborationRunEvent({ type: "worker_resumed", runId, workerId: worker.workerId, summary: message });

  try {
    workerSession = await createSubagentWorkerSession(workerCwd, state.mode, worker.sessionId, {
      parentSessionId: state.parentSessionId,
      runId: state.runId,
      workerName: worker.name,
    }, state.model);
    if (continuationAborted || getCollaborationRun(runId)?.status !== "running") {
      await workerSession.abort();
      throw new Error("CONTINUE_CANCELLED");
    }
    unsubscribeWorkerEvents = workerSession.listen((event) => {
      emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.workerId, event });
      updateWorkerToolActivity(runId, workerIndex, event);
    });
    const result = await runWorkerPromptWithRecovery(
      workerSession,
      message,
      recoveryModels,
      (model, attempt, error) => {
        emitCollaborationRunEvent({
          type: "worker_event",
          runId,
          workerId: worker.workerId,
          event: {
            type: "auto_recovery_start",
            attempt,
            provider: model.provider,
            modelId: model.modelId,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    unsubscribeWorkerEvents();
    unsubscribeWorkerEvents = null;

    if (continuationAborted) return getCollaborationRun(runId)!;
    updateCollaborationRun(runId, (run) => {
      const target = run.workers[workerIndex];
      if (!target) return;
      target.status = "complete";
      target.result = target.result?.trim() ? `${target.result.trim()}\n\n---\n\n继续结果：\n${result}` : result;
      target.workerSessionState = "complete_memory_destroyed";
      target.canContinue = false;
      target.continueUnavailableReason = "Continue availability is being finalized.";
      target.diff = undefined;
      run.canContinue = false;
      run.continueUnavailableReason = "Continue availability is being finalized.";
    });
    if (continueBinding) {
      emitCollaborationRunEvent({ type: "worker_capture_started", runId, workerId: worker.workerId });
      const captureResult = await captureWorktreeArtifact(continueBinding.manifestPath, worker.workerId, { diagnosticRunId: runId });
      const capturedManifest = readWorktreeManifest(continueBinding.manifestPath);
      const capturedWorker = compareAndSetCollaborationRun(runId, { allowedStatuses: ["running"] }, (run) => {
        const target = run.workers[workerIndex];
        if (!target) return;
        target.patchSha256 = captureResult.capture?.patchSha256 ?? undefined;
        target.patchBytes = captureResult.capture?.patchBytes ?? undefined;
        target.changedFiles = captureResult.capture?.changedFiles ?? [];
        target.binaryFiles = captureResult.capture?.binaryFiles ?? [];
        target.changeStats = summarizeFileChanges(captureResult.capture?.fileChanges);
        target.diffStats = (captureResult.capture?.changedFiles ?? []).join("\n");
        target.captureErrorCode = captureResult.errorCode ?? undefined;
        run.captureState = captureResult.ok
          ? capturedManifest.kind === "ok" && capturedManifest.manifest.state === "captured" ? "captured" : "preserved"
          : captureResult.manifestStatePersisted ? "preserved" : "failed";
        if (!captureResult.ok) {
          target.status = "error";
          target.error = captureResult.error ?? "Artifact capture failed";
          if (!captureResult.manifestStatePersisted) run.recoveryState = "manual_recovery_required";
        }
      });
      if (!capturedWorker.ok) throw new Error("CAPTURE_STATE_PERSISTENCE_FAILED");
      emitCollaborationRunEvent({
        type: captureResult.ok ? "worker_capture_completed" : "worker_capture_error",
        runId, workerId: worker.workerId,
        errorCode: captureResult.errorCode ?? undefined,
        fileCount: captureResult.capture?.changedFiles.length ?? 0,
        binaryFileCount: captureResult.capture?.binaryFiles.length ?? 0,
      });
      if (!captureResult.ok) {
        emitCollaborationRunEvent({ type: "worktree_preserved", runId, workerId: worker.workerId, reasonCode: "CAPTURE_FAILED" });
      }
    }
    // LLM 聚合 summary（≥2 completed 才综合；continue 单 worker 时回退静态拼接）。
    const forAggregate = getCollaborationRun(runId);
    const summary = forAggregate ? await aggregateSubagentResults(forAggregate, { model: state.model }) : "";
    if (continuationAborted) return getCollaborationRun(runId)!;
    // Keep the control plane running until capture and its exclusive lease settle.
    if (continueBinding) {
      await settleContinueLease(continueBinding);
      continueBinding = null;
      if (continueHeartbeat) clearInterval(continueHeartbeat);
    }
    const finalized = compareAndSetCollaborationRun(runId, { allowedStatuses: ["running"] }, (run) => {
      run.summary = summary;
      run.status = run.recoveryState ? "recoverable" : run.workers.some((item) => item.status === "error") ? "error" : "complete";
      if (run.status === "complete") run.error = undefined;
    });
    const updated = finalized.ok ? finalized.state : undefined;
    if (!updated) throw new Error("CONTINUE_STATE_PERSISTENCE_FAILED");
    emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.workerId, result });
    if (updated) {
      const latestWorker = updated.workers[workerIndex];
      if (latestWorker?.patchSha256) {
        emitCollaborationRunEvent({ type: "worker_diff_ready", runId, workerId: worker.workerId, diffStats: latestWorker.diffStats });
      }
      emitCollaborationRunEvent({ type: "task_summary_ready", runId, summary: updated.summary });
      await appendRunSnapshot(updated.parentSessionId, updated);
      // continue 走独立路径，不经过 executeCollaborationRun 的终态回收块，需自己调度。
      // 注意：这里不能用 cleanupAll（其 workerSessions 闭包不含本次 continue 的 session），
      // 本次 continue session 已在 finally destroy；scheduleRunReclaim 负责清 worktree/Map/jsonl。
      scheduleRunReclaim(updated.runId, updated.mode);
      return updated;
    }
    const latest = getCollaborationRun(runId);
    if (!latest) throw new Error("Run not found after continue");
    return latest;
  } catch (error) {
    unsubscribeWorkerEvents?.();
    if (continuationAborted) return getCollaborationRun(runId)!;
    const err = error instanceof Error ? error.message : String(error);
    updateCollaborationRun(runId, (run) => {
      const target = run.workers[workerIndex];
      if (target) {
        target.status = "error";
        target.error = err;
        target.workerSessionState = target.sessionId ? "complete_memory_destroyed" : undefined;
        target.canContinue = false;
        target.continueUnavailableReason = err;
      }
      run.status = "error";
      run.error = err;
      run.canContinue = false;
      run.continueUnavailableReason = err;
    });
    // 错误路径：单 worker 时 aggregateSubagentResults 直接静态拼接（不调 LLM），快速返回。
    const forAggregateErr = getCollaborationRun(runId);
    const summaryErr = forAggregateErr ? await aggregateSubagentResults(forAggregateErr, { model: state.model }) : "";
    const updated = updateCollaborationRun(runId, (run) => { run.summary = summaryErr; });
    emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.workerId, error: err });
    if (updated) {
      await appendRunSnapshot(updated.parentSessionId, updated);
      scheduleRunReclaim(updated.runId, updated.mode);
    }
    throw error;
  } finally {
    if (continueHeartbeat) clearInterval(continueHeartbeat);
    if (continueBinding) {
      try {
        await settleContinueLease(continueBinding);
      } catch {
        updateCollaborationRun(runId, (run) => {
          run.recoveryState = "manual_recovery_required";
          if (run.status !== "aborted" && run.status !== "applied") run.status = "recoverable";
          run.canContinue = false;
          run.continueUnavailableReason = "Continue lease could not be safely settled.";
        });
      }
    }
    workerSession?.destroy();
    workerReservation.release();
  }
}

type PublicAtomicApplyResult = Omit<AtomicApplyResult, "journalPath">;

function applyStatePersistenceFailure(
  transactionId: string,
  workerIds: readonly string[],
  files: readonly string[],
  phase: AtomicApplyResult["phase"] = "persisted",
): PublicAtomicApplyResult {
  return {
    success: false,
    outcome: "recovery_required",
    transactionId,
    phase,
    workerIds: [...workerIds],
    files: [...files],
    errorCode: "APPLY_STATE_PERSISTENCE_FAILED",
    error: "Apply failed (APPLY_STATE_PERSISTENCE_FAILED)",
  };
}

function persistAuthoritativeAppliedProjection(
  runId: string,
  apply: {
    transactionId: string;
    requestedWorkerIds: string[];
    appliedFiles: string[];
  },
  manifest: WorktreeManifestV1,
): CollaborationRunState | undefined {
  const current = getCollaborationRun(runId);
  if (!current) return undefined;
  if (current.status === "applied" && current.applyState === "applied"
    && current.applyTransactionId === apply.transactionId) return current;
  const committed = compareAndSetCollaborationRun(runId, {
    expectedVersion: current.version,
    allowedStatuses: ["complete", "error", "recoverable", "applying", "applied"],
  }, (run) => {
    run.status = "applied";
    run.applyState = "applied";
    run.applyTransactionId = apply.transactionId;
    run.recoveryState = undefined;
    run.canContinue = false;
    run.continueUnavailableReason = "Subagent artifacts have been applied.";
    const appliedFiles = new Set(apply.appliedFiles);
    for (const workerId of apply.requestedWorkerIds) {
      const worker = run.workers.find((candidate) => candidate.workerId === workerId);
      if (!worker) continue;
      const captured = manifest.workers.find((candidate) => candidate.workerId === workerId)?.capture?.changedFiles ?? [];
      worker.appliedFiles = captured.filter((file) => appliedFiles.has(file));
      worker.canContinue = false;
      worker.continueUnavailableReason = "Worker changes were applied.";
    }
  });
  return committed.ok ? committed.state : undefined;
}

export async function applyCollaborationPatches(
  runId: string,
  workerIds: string[],
  files?: string[],
  transactionId?: string,
): Promise<PublicAtomicApplyResult> {
  if (workerIds.length === 0) throw new Error("At least one worker must be selected");
  if (files !== undefined && files.length === 0) throw new Error("At least one file must be selected");
  const state = getCollaborationRun(runId);
  if (!state) throw new CollaborationApplyRequestError(404, "APPLY_RUN_NOT_FOUND", "Run not found");
  if (state.mode !== "isolated_coding") {
    throw new CollaborationApplyRequestError(412, "APPLY_MODE_UNSUPPORTED", "Run does not support artifact apply");
  }
  if (!["complete", "error", "recoverable", "applying", "applied"].includes(state.status)) {
    throw new CollaborationApplyRequestError(412, "APPLY_RUN_NOT_READY", "Run is not ready for artifact apply");
  }
  if (!state.worktreeManifestPath) {
    throw new CollaborationApplyRequestError(412, "APPLY_MANIFEST_UNAVAILABLE", "Run does not have an apply manifest");
  }
  const expectedManifestPath = path.join(getIsolatedRunDir(runId), "worktree-manifest.json");
  if (path.resolve(state.worktreeManifestPath) !== path.resolve(expectedManifestPath)) {
    throw new CollaborationApplyRequestError(412, "APPLY_MANIFEST_PATH_INVALID", "Run apply manifest is outside its managed directory");
  }
  const manifestResult = readWorktreeManifest(state.worktreeManifestPath);
  if (manifestResult.kind !== "ok" || !["captured", "applying", "applied"].includes(manifestResult.manifest.state)) {
    throw new CollaborationApplyRequestError(412, "APPLY_MANIFEST_NOT_CAPTURED", "Run does not have a captured apply manifest");
  }
  if (manifestResult.manifest.runId !== runId) {
    throw new CollaborationApplyRequestError(412, "APPLY_MANIFEST_RUN_MISMATCH", "Run apply manifest identity does not match");
  }
  const existingApply = manifestResult.manifest.state === "applied" && manifestResult.manifest.apply?.outcome === "applied"
    ? manifestResult.manifest.apply
    : null;
  if (existingApply) {
    const verified = await atomicApply({
      manifestPath: state.worktreeManifestPath,
      targetCwd: state.cwd,
      workerIds,
      files,
      transactionId: transactionId ?? existingApply.transactionId,
      idempotencyKey: transactionId ?? existingApply.transactionId,
    });
    if (verified.outcome !== "applied") {
      const { journalPath: _journalPath, ...publicResult } = verified;
      return publicResult;
    }
    const replayed = persistAuthoritativeAppliedProjection(runId, existingApply, manifestResult.manifest);
    if (!replayed) {
      const persistenceFailure = applyStatePersistenceFailure(existingApply.transactionId, existingApply.requestedWorkerIds, existingApply.appliedFiles);
      emitCollaborationRunEvent({
        type: "patch_apply_recovery_required",
        runId,
        transactionId: persistenceFailure.transactionId,
        phase: "persisted",
        errorCode: persistenceFailure.errorCode ?? undefined,
      });
      emitCollaborationRunEvent({
        type: "patch_apply_error",
        runId,
        transactionId: persistenceFailure.transactionId,
        phase: "persisted",
        errorCode: persistenceFailure.errorCode ?? undefined,
        error: persistenceFailure.error ?? "Apply state persistence failed",
      });
      return persistenceFailure;
    }
    return { success: true, outcome: "applied", transactionId: existingApply.transactionId, phase: "persisted", workerIds: existingApply.requestedWorkerIds, files: existingApply.appliedFiles, errorCode: null, error: null };
  }
  if (!getWorktreeRollout().newApplyEnabled) {
    throw new CollaborationApplyRequestError(503, "APPLY_DISABLED", "New worktree Apply requests are disabled; artifacts and historical results remain available");
  }
  const effectiveTransactionId = transactionId ?? state.applyTransactionId ?? randomUUID();
  if (state.status === "applying" && state.applyTransactionId && state.applyTransactionId !== effectiveTransactionId) {
    return { success: false, outcome: "precondition_failed", transactionId: effectiveTransactionId, phase: null, workerIds: [], files: [], errorCode: "APPLY_TRANSACTION_ACTIVE", error: "Apply failed (APPLY_TRANSACTION_ACTIVE)" };
  }
  if (state.status === "applying" && state.applyTransactionId === effectiveTransactionId) {
    return { success: false, outcome: "precondition_failed", transactionId: effectiveTransactionId, phase: null, workerIds: [], files: [], errorCode: "APPLY_TRANSACTION_ACTIVE", error: "Apply failed (APPLY_TRANSACTION_ACTIVE)" };
  }
  const applyStartedAt = new Date().toISOString();
  const applying = compareAndSetCollaborationRun(runId, {
    expectedVersion: state.version,
    allowedStatuses: ["complete", "error", "recoverable"],
  }, (run) => {
    run.status = "applying";
    run.applyState = "applying";
    run.applyTransactionId = effectiveTransactionId;
    run.applyStartedAt = applyStartedAt;
    run.canContinue = false;
    run.continueUnavailableReason = "Subagent artifacts are being applied.";
  });
  if (!applying.ok) {
    if (applying.reason === "persistence_failed") {
      return { success: false, outcome: "error", transactionId: effectiveTransactionId, phase: null, workerIds: [], files: [], errorCode: "APPLY_STATE_PERSISTENCE_FAILED", error: "Apply failed (APPLY_STATE_PERSISTENCE_FAILED)" };
    }
    return { success: false, outcome: "precondition_failed", transactionId: effectiveTransactionId, phase: null, workerIds: [], files: [], errorCode: "APPLY_PRECONDITION_CHANGED", error: "Apply failed (APPLY_PRECONDITION_CHANGED)" };
  }
  emitCollaborationRunEvent({ type: "patch_apply_started", runId, transactionId: effectiveTransactionId });
  const result = await atomicApply({
    manifestPath: state.worktreeManifestPath,
    targetCwd: state.cwd,
    workerIds,
    files,
    transactionId: effectiveTransactionId,
    idempotencyKey: effectiveTransactionId,
  });
  const settledManifest = readWorktreeManifest(state.worktreeManifestPath);
  const authoritativeApply = settledManifest.kind === "ok"
    && settledManifest.manifest.state === "applied"
    && settledManifest.manifest.apply?.outcome === "applied"
    ? settledManifest.manifest.apply
    : null;
  const requestMatchesAuthoritative = authoritativeApply
    && JSON.stringify(authoritativeApply.requestedWorkerIds) === JSON.stringify(workerIds)
    && JSON.stringify(authoritativeApply.requestedFiles) === JSON.stringify(files === undefined ? null : [...files].sort());
  // A manifest alone is insufficient: the journal may still require recovery, or
  // another transaction may have completed the same payload while we waited for Git.
  const appliedFact = result.outcome === "applied" && authoritativeApply && requestMatchesAuthoritative ? authoritativeApply : null;
  let updated: CollaborationRunState | undefined;
  let responseResult: PublicAtomicApplyResult;
  if (appliedFact) {
    updated = persistAuthoritativeAppliedProjection(runId, appliedFact, settledManifest.kind === "ok" ? settledManifest.manifest : manifestResult.manifest);
    responseResult = updated
      ? { success: true, outcome: "applied", transactionId: appliedFact.transactionId, phase: "persisted", workerIds: appliedFact.requestedWorkerIds, files: appliedFact.appliedFiles, errorCode: null, error: null }
      : applyStatePersistenceFailure(appliedFact.transactionId, appliedFact.requestedWorkerIds, appliedFact.appliedFiles);
  } else {
    const current = getCollaborationRun(runId);
    const ownershipMatches = current?.applyTransactionId === effectiveTransactionId
      && current.status !== "applied";
    const settled = current && ownershipMatches
      ? compareAndSetCollaborationRun(runId, {
        expectedVersion: current.version,
        allowedStatuses: ["applying"],
      }, (run) => {
        run.applyTransactionId = result.transactionId;
        const requiresRecovery = result.outcome === "recovery_required" || result.outcome === "applied";
        run.applyState = requiresRecovery ? "recovery_required" : "failed";
        run.status = requiresRecovery ? "recoverable" : "complete";
        run.canContinue = false;
        run.continueUnavailableReason = "Captured artifacts remain available for apply or recovery.";
        if (requiresRecovery) run.recoveryState = "manual_recovery_required";
      })
      : null;
    updated = settled?.ok ? settled.state : undefined;
    const { journalPath: _journalPath, ...publicResult } = result;
    responseResult = updated && result.outcome !== "applied"
      ? publicResult
      : applyStatePersistenceFailure(result.transactionId, result.workerIds, result.files, result.phase);
  }

  const factualPhase = appliedFact ? "persisted" : result.phase;
  if (factualPhase === "checked" || factualPhase === "applied" || factualPhase === "persisted") {
    emitCollaborationRunEvent({ type: "patch_apply_checked", runId, transactionId: responseResult.transactionId, phase: "checked" });
  }
  if (factualPhase === "applied" || factualPhase === "persisted") {
    emitCollaborationRunEvent({ type: "patch_apply_committed", runId, transactionId: responseResult.transactionId, phase: "applied", files: responseResult.files });
  }
  if (responseResult.outcome === "recovery_required") {
    emitCollaborationRunEvent({
      type: "patch_apply_recovery_required",
      runId,
      transactionId: responseResult.transactionId,
      phase: responseResult.phase ?? undefined,
      errorCode: responseResult.errorCode ?? undefined,
    });
  }
  emitCollaborationRunEvent(responseResult.outcome === "applied"
    ? { type: "patch_applied", runId, transactionId: responseResult.transactionId, phase: responseResult.phase ?? undefined, result: "Artifacts applied" }
    : { type: "patch_apply_error", runId, transactionId: responseResult.transactionId, phase: responseResult.phase ?? undefined, errorCode: responseResult.errorCode ?? undefined, error: responseResult.error ?? "Apply failed" });
  if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
  return responseResult;
}
