import path from "path";
import fs from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import {
  abortCollaborationRun,
  createCollaborationRun,
  emitCollaborationRunEvent,
  getCollaborationRun,
  removeCollaborationRun,
  setCollaborationAbort,
  setCollaborationCleanup,
  subscribeCollaborationRun,
  updateCollaborationRun,
} from "./collaboration-store";
import type {
  ApplyCollaborationPatchesResult,
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
  cleanupWorkspace,
  generateDiff,
  getRepoStatus,
  isGitRepo,
  setupIsolatedWorkspace,
  applyPatch,
} from "./worktree";
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
    case "codegraph_search":
      summary = pick("query", "text", "q");
      break;
    case "codegraph_callers":
    case "codegraph_callees":
    case "codegraph_impact":
      summary = pick("symbol", "query");
      break;
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

const TERMINAL_RUN_STATUSES = new Set<CollaborationRunState["status"]>(["complete", "aborted", "error", "applied"]);
const TERMINAL_RUN_EVENTS = new Set(["run_complete", "run_error", "run_aborted"]);

function snapshotRun(state: CollaborationRunState): CollaborationRunSnapshot {
  return {
    runId: state.runId,
    taskId: state.runId,
    parentEntryId: state.parentEntryId,
    title: state.title,
    mode: state.mode,
    taskMode: state.taskMode,
    runPlacement: state.runPlacement,
    workflow: state.workflow,
    status: state.status,
    message: state.message,
    workers: state.workers,
    summary: state.summary,
    error: state.error,
    canContinue: state.canContinue,
    continueUnavailableReason: state.continueUnavailableReason,
    continueExpiresAt: state.continueExpiresAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

async function appendRunSnapshot(parentSessionId: string | undefined, state: CollaborationRunState): Promise<void> {
  if (!parentSessionId) return;
  try {
    const filePath = await resolveSessionPath(parentSessionId);
    if (!filePath) return;
    if (upsertRunSnapshot(filePath, state)) {
      invalidateSessionListCache();
      return;
    }
    const manager = SessionManager.open(filePath);
    manager.appendCustomEntry("agent_collaboration_run", snapshotRun(state));
    invalidateSessionListCache();
  } catch {
    // Best effort: collaboration still runs even if the parent session cannot be annotated.
  }
}

function upsertRunSnapshot(filePath: string, state: CollaborationRunState): boolean {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let changed = false;
    const nextLines = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { runId?: unknown } };
        if (entry.type !== "custom" || entry.customType !== "agent_collaboration_run") return line;
        if (entry.data?.runId !== state.runId) return line;
        changed = true;
        return JSON.stringify({ ...entry, data: snapshotRun(state) });
      } catch {
        return line;
      }
    });
    if (!changed) return false;
    fs.writeFileSync(filePath, nextLines.join("\n"));
    return true;
  } catch {
    return false;
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
  allowDirtyWorktree?: boolean;
}): Promise<CollaborationRunState> {
  const runId = `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  if (mode === "isolated_coding") {
    if (!isGitRepo(cwd)) throw new Error("Code in Isolation requires a git repository so diffs can be reviewed and applied.");
    const repoStatus = getRepoStatus(cwd);
    if (!repoStatus.clean && !params.allowDirtyWorktree) {
      throw new Error(`Working directory has uncommitted changes. Subagent worktrees start from HEAD, so commit/stash changes or confirm running from HEAD first: ${repoStatus.files.join(", ")}`);
    }
  }
  const workerReservation = reserveSubagentWorkerCapacity({
    runId,
    cwd,
    workerSlots: getConcurrentWorkerSlots(workflow, planned.workers.length),
  });
  const state: CollaborationRunState = {
    runId,
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
    isGit: isGitRepo(params.cwd),
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
      });
      emitCollaborationRunEvent({ type: "run_error", runId, error: err });
      if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
    });

    return state;
  } catch (error) {
    workerReservation.release();
    throw error;
  }
}

/** isolated_coding run 终态后保留 worktree 的时长：apply/continue 通常很快，2h 足够且不占太久。 */
const ISOLATED_WORKTREE_RETENTION_MS = 2 * 60 * 60 * 1000;
/** analysis 无 worktree，且 worker session 内存已销毁；短暂保留 run 只为返回明确不可继续原因。 */
const ANALYSIS_RUN_RETENTION_MS = 10 * 60 * 1000;

export function waitForCollaborationRun(runId: string, timeoutMs = 12 * 60 * 1000): Promise<CollaborationRunState> {
  const existing = getCollaborationRun(runId);
  if (!existing) return Promise.reject(new Error("Run not found"));
  if (TERMINAL_RUN_STATUSES.has(existing.status)) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      recordSubagentTimeoutOrAbort("timeout");
      // P1-3 修复：超时后联动 abort，让后台 workers 真正停下并触发终态回收，
      // 而不是让它们继续占用 session/worktree 直到 30min watchdog 自行 settle。
      void abortCollaborationRun(runId).catch(() => {});
      const latest = getCollaborationRun(runId);
      reject(new Error(latest?.status === "running" || latest?.status === "setting_up"
        ? "Subagent task is still running"
        : "Timed out waiting for subagent task"));
    }, timeoutMs);

    unsubscribe = subscribeCollaborationRun(runId, (event) => {
      if (!TERMINAL_RUN_EVENTS.has(event.type)) return;
      clearTimeout(timeout);
      unsubscribe?.();
      const latest = getCollaborationRun(runId);
      if (latest) resolve(latest);
      else reject(new Error("Run not found after completion"));
    });
  });
}

/**
 * 按 run 模式调度终态回收。analysis 明确标记不可继续后短暂保留；
 * isolated_coding 保留 worktree/jsonl 2h 供 apply/continue，到期先标记 expired 再回收。
 */
function scheduleRunReclaim(runId: string, mode: CollaborationRunMode): void {
  if (mode === "isolated_coding") {
    const expiresAt = new Date(Date.now() + ISOLATED_WORKTREE_RETENTION_MS).toISOString();
    const updated = updateCollaborationRun(runId, (run) => {
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
        removeCollaborationRun(runId);
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
    try { removeCollaborationRun(runId); } catch { /* best effort */ }
  }, ANALYSIS_RUN_RETENTION_MS).unref?.();
}

async function executeCollaborationRun(runId: string, workerReservation?: SubagentWorkerReservation): Promise<void> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");

  let aborted = false;
  let runDir = "";
  let gitRoot: string | null = null;
  let isGit = false;
  let worktrees: Map<string, string> = new Map();
  const workerSessions: WorkerSession[] = [];

  const cleanupAll = () => {
    if (runDir) {
      try { cleanupWorkspace(runDir, gitRoot, isGit); } catch { /* best effort */ }
    }
    for (const session of workerSessions) {
      try { session.destroy(); } catch { /* best effort */ }
    }
  };

  setCollaborationAbort(runId, async () => {
    aborted = true;
    recordSubagentTimeoutOrAbort("abort");
    await Promise.all(workerSessions.map((session) => session.abort().catch(() => {})));
    cleanupAll();
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
    emitCollaborationRunEvent({ type: "run_aborted", runId });
    if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
    // aborted 不保留 worktree（用户主动中止，不会 apply）：全量回收 Map + jsonl +
    // listeners。cleanupAll 已清 worktree/session，这里主要释放内存与磁盘泄漏（P0-2）。
    workerReservation?.release();
    removeCollaborationRun(runId);
  });
  setCollaborationCleanup(runId, cleanupAll);

  if (state.mode === "isolated_coding") {
    const workspace = setupIsolatedWorkspace(state.cwd, state.workers.map((worker) => worker.name));
    runDir = workspace.runDir;
    gitRoot = workspace.gitRoot;
    isGit = workspace.isGit;
    worktrees = workspace.worktrees;
    updateCollaborationRun(runId, (run) => {
      run.status = "running";
      run.canContinue = false;
      run.continueUnavailableReason = "Subagent run is still running.";
      run.isGit = isGit;
      for (const worker of run.workers) worker.worktreePath = worktrees.get(worker.name);
    });
    emitCollaborationRunEvent({ type: "run_setup_complete", runId });
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
    const depNames = worker?.dependsOn ?? [];
    const deps = depNames.length > 0
      ? depNames.map((name) => run.workers.find((w) => w.name === name)).filter((w): w is NonNullable<typeof w> => Boolean(w))
      : (index > 0 ? [run.workers[index - 1]].filter((w): w is NonNullable<typeof w> => Boolean(w)) : []);
    return deps
      .filter((w) => w.status === "complete" && w.result?.trim())
      .map((w) => ({ name: w.name, task: w.task, result: w.result ?? "" }));
  };

  /** 执行单个 worker（parallel 与 sequential 复用）。priorResults 为前序结论注入。
   *  返回 result（失败/中止时为 undefined）。 */
  const executeOneWorker = async (worker: (typeof current.workers)[number], index: number, priorResults: PriorWorkerResult[]): Promise<string | undefined> => {
    if (aborted) return undefined;
    const workerCwd = current.mode === "isolated_coding" ? worktrees.get(worker.name) : current.cwd;
    if (!workerCwd) {
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "error";
          target.error = "Worker workspace was not created";
        }
      });
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: "Worker workspace was not created" });
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
      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "running";
          target.sessionId = workerSession.sessionId;
          target.workerSessionState = "running";
          target.canContinue = false;
          target.continueUnavailableReason = "Worker is still running.";
        }
      });
      emitCollaborationRunEvent({ type: "worker_start", runId, workerId: worker.name });

      unsubscribeWorkerEvents = workerSession.listen((event) => {
        emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.name, event });
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
            workerId: worker.name,
            event: {
              type: "auto_recovery_start",
              attempt,
              provider: model.provider,
              modelId: model.modelId,
              errorMessage: message,
            },
          });
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

      updateCollaborationRun(runId, (run) => {
        const target = run.workers[index];
        if (target) {
          target.status = "complete";
          target.result = result;
          target.workerSessionState = "complete_memory_destroyed";
          target.canContinue = false;
          target.continueUnavailableReason = "Continue availability is being finalized.";
          if (current.mode === "isolated_coding") {
            const { diff, stats } = generateDiff(workerCwd);
            target.diff = diff;
            target.diffStats = stats;
          }
        }
      });
      emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.name, result });

      const latestWorker = getCollaborationRun(runId)?.workers[index];
      if (latestWorker?.diff?.trim()) {
        emitCollaborationRunEvent({
          type: "worker_diff_ready",
          runId,
          workerId: worker.name,
          diff: latestWorker.diff,
          diffStats: latestWorker.diffStats,
        });
      }
      return result;
    } catch (error) {
      unsubscribeWorkerEvents?.();
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
      emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: err });
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
    workerReservation?.release();
    return;
  }

  // ── 终态：先定 status，再用 LLM 聚合 summary（多 worker 才综合，否则静态拼接）。
  updateCollaborationRun(runId, (run) => {
    run.status = run.workers.some((worker) => worker.status === "error") ? "error" : "complete";
    if (run.status === "error") run.error = "One or more child agents failed";
    run.canContinue = false;
    run.continueUnavailableReason = "Continue availability is being finalized.";
  });
  const forAggregate = getCollaborationRun(runId);
  // ★ LLM 聚合：≥2 个 completed worker 且有 model 时综合综述；否则回退静态拼接。
  //   聚合在 status 已定、worker 结果已落盘后进行，30s 超时兜底。
  const summary = forAggregate
    ? await aggregateSubagentResults(forAggregate, { model: current.model })
    : "";
  const completed = updateCollaborationRun(runId, (run) => {
    run.summary = summary;
  });
  if (!completed) {
    workerReservation?.release();
    return;
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
  scheduleRunReclaim(completed.runId, completed.mode);
}

async function assertWorkerCanContinue(
  state: CollaborationRunState,
  worker: CollaborationRunState["workers"][number],
): Promise<void> {
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
  const sessionFile = await resolveSessionPath(worker.sessionId);
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error("Worker session file was not found; continue is unavailable.");
  }
  const workerCwd = state.mode === "isolated_coding" ? worker.worktreePath : state.cwd;
  if (!workerCwd) throw new Error("Worker workspace is not available.");
  if (state.mode === "isolated_coding" && !fs.existsSync(workerCwd)) {
    throw new Error("Worker workspace was cleaned up; continue is unavailable.");
  }
}

export async function continueCollaborationWorker(runId: string, workerId: string, prompt?: string): Promise<CollaborationRunState> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");
  const workerIndex = state.workers.findIndex((item) => item.workerId === workerId || item.name === workerId);
  const worker = workerIndex >= 0 ? state.workers[workerIndex] : undefined;
  if (!worker) throw new Error("Worker not found");
  await assertWorkerCanContinue(state, worker);

  const workerCwd = state.mode === "isolated_coding" ? worker.worktreePath : state.cwd;
  if (!workerCwd) throw new Error("Worker workspace is not available");
  const workerReservation = reserveSubagentWorkerCapacity({
    runId: `${runId}:continue:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    cwd: state.cwd,
    workerSlots: 1,
  });
  const message = prompt?.trim() || "请继续这个子任务，基于当前会话上下文补充结论、修复遗漏，并给出最新摘要。";
  const recoveryModels = getAutoRecoveryModels();
  let workerSession: WorkerSession | null = null;
  let unsubscribeWorkerEvents: (() => void) | null = null;

  updateCollaborationRun(runId, (run) => {
    run.status = "running";
    run.canContinue = false;
    run.continueUnavailableReason = "Worker continue is running.";
    const target = run.workers[workerIndex];
    if (target) {
      target.status = "running";
      target.workerSessionState = "running";
      target.canContinue = false;
      target.continueUnavailableReason = "Worker continue is running.";
    }
  });
  emitCollaborationRunEvent({ type: "worker_resumed", runId, workerId: worker.name, summary: message });

  try {
    workerSession = await createSubagentWorkerSession(workerCwd, state.mode, worker.sessionId, {
      parentSessionId: state.parentSessionId,
      runId: state.runId,
      workerName: worker.name,
    }, state.model);
    unsubscribeWorkerEvents = workerSession.listen((event) => {
      emitCollaborationRunEvent({ type: "worker_event", runId, workerId: worker.name, event });
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
          workerId: worker.name,
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

    updateCollaborationRun(runId, (run) => {
      const target = run.workers[workerIndex];
      if (!target) return;
      target.status = "complete";
      target.result = target.result?.trim() ? `${target.result.trim()}\n\n---\n\n继续结果：\n${result}` : result;
      target.workerSessionState = "complete_memory_destroyed";
      target.canContinue = false;
      target.continueUnavailableReason = "Continue availability is being finalized.";
      if (run.mode === "isolated_coding") {
        const { diff, stats } = generateDiff(workerCwd);
        target.diff = diff;
        target.diffStats = stats;
      }
      run.status = run.workers.some((item) => item.status === "error") ? "error" : "complete";
      if (run.status !== "error") run.error = undefined;
      run.canContinue = false;
      run.continueUnavailableReason = "Continue availability is being finalized.";
    });
    // LLM 聚合 summary（≥2 completed 才综合；continue 单 worker 时回退静态拼接）。
    const forAggregate = getCollaborationRun(runId);
    const summary = forAggregate ? await aggregateSubagentResults(forAggregate, { model: state.model }) : "";
    const updated = updateCollaborationRun(runId, (run) => { run.summary = summary; });
    emitCollaborationRunEvent({ type: "worker_complete", runId, workerId: worker.name, result });
    if (updated) {
      const latestWorker = updated.workers[workerIndex];
      if (latestWorker?.diff?.trim()) {
        emitCollaborationRunEvent({ type: "worker_diff_ready", runId, workerId: worker.name, diff: latestWorker.diff, diffStats: latestWorker.diffStats });
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
    emitCollaborationRunEvent({ type: "worker_error", runId, workerId: worker.name, error: err });
    if (updated) {
      await appendRunSnapshot(updated.parentSessionId, updated);
      scheduleRunReclaim(updated.runId, updated.mode);
    }
    throw error;
  } finally {
    workerSession?.destroy();
    workerReservation.release();
  }
}

export async function applyCollaborationPatches(runId: string, workerNames: string[], files?: string[]): Promise<ApplyCollaborationPatchesResult> {
  const state = getCollaborationRun(runId);
  if (!state) throw new Error("Run not found");
  if (state.mode !== "isolated_coding") throw new Error("Only isolated coding runs can apply patches");
  if (state.status !== "complete" && state.status !== "error") throw new Error("Run must be finished before applying patches");

  const repoStatus = getRepoStatus(state.cwd);
  if (!repoStatus.clean) {
    throw new Error(`Working directory has uncommitted changes: ${repoStatus.files.join(", ")}`);
  }

  updateCollaborationRun(runId, (run) => {
    run.status = "applying";
    run.canContinue = false;
    run.continueUnavailableReason = "Subagent patches are being applied.";
  });
  emitCollaborationRunEvent({ type: "patch_apply_started", runId, files });

  const result: ApplyCollaborationPatchesResult = { success: true, applied: [], failed: [], conflicts: [], appliedFiles: [], conflictFiles: [] };
  for (const workerName of workerNames) {
    const worker = state.workers.find((item) => item.name === workerName || item.workerId === workerName);
    if (!worker?.worktreePath || !worker.diff?.trim()) {
      result.failed.push({ workerName, error: "Worker not found or no diff available" });
      continue;
    }
    const patchResult = applyPatch(state.cwd, worker.worktreePath, files);
    if (patchResult.success) {
      result.applied.push(workerName);
      if (files?.length) result.appliedFiles?.push(...files);
      emitCollaborationRunEvent({ type: "patch_applied", runId, workerId: workerName, result: "Patch applied successfully", files });
    } else {
      const error = patchResult.error ?? "Unknown patch error";
      result.failed.push({ workerName, error });
      if (/conflict|does not apply/i.test(error)) {
        result.conflicts.push(workerName);
        if (files?.length) result.conflictFiles?.push(...files);
      }
      emitCollaborationRunEvent({ type: "patch_apply_error", runId, workerId: workerName, error, files });
    }
  }

  result.success = result.failed.length === 0;
  const updated = updateCollaborationRun(runId, (run) => {
    run.status = result.success ? "applied" : "complete";
    if (result.success) {
      run.canContinue = false;
      run.continueUnavailableReason = "Subagent run has already been applied.";
      run.continueExpiresAt = undefined;
    }
    for (const workerName of result.applied) {
      const target = run.workers.find((item) => item.name === workerName || item.workerId === workerName);
      if (target) {
        target.appliedFiles = [...new Set([...(target.appliedFiles ?? []), ...(files ?? extractFilesFromDiffStats(target.diffStats))])];
        target.canContinue = false;
        target.continueUnavailableReason = "Worker changes were already applied.";
        target.workerSessionState = "deleted";
      }
    }
    for (const workerName of result.conflicts) {
      const target = run.workers.find((item) => item.name === workerName || item.workerId === workerName);
      if (target) target.conflictFiles = [...new Set([...(target.conflictFiles ?? []), ...(files ?? extractFilesFromDiffStats(target.diffStats))])];
    }
    if (!result.success) {
      run.canContinue = run.workers.some((worker) => worker.canContinue);
      run.continueUnavailableReason = run.canContinue ? undefined : "No workers are currently available to continue.";
    }
  });
  if (updated) await appendRunSnapshot(updated.parentSessionId, updated);
  if (result.success) removeCollaborationRun(runId);
  return result;
}

function extractFilesFromDiffStats(stats?: string): string[] {
  if (!stats) return [];
  return stats
    .split("\n")
    .map((line) => line.split("|")[0]?.trim())
    .filter((file): file is string => Boolean(file) && !/files? changed/.test(file));
}
