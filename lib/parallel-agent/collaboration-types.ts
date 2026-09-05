import type { AgentEvent } from "@/lib/rpc-manager";
import type { WorktreeChangeStats } from "./worktree-file-metadata";

export type CollaborationRunMode = "analysis" | "isolated_coding";
export type CollaborationRunStatus = "setting_up" | "running" | "complete" | "aborted" | "error" | "applying" | "applied" | "recoverable";
export type CollaborationWorkerStatus = "pending" | "running" | "complete" | "aborted" | "error";
export type SubagentTaskMode = "ask" | "code" | "parallel" | "review" | "custom";
export type SubagentRunPlacement = "foreground" | "background";
export type SubagentCapability = "readonly" | "isolated_coding" | "review";
export type WorkerSessionState =
  | "running"
  | "complete_memory_destroyed"
  | "reopenable_from_jsonl"
  | "expired"
  | "deleted";

/**
 * Subagent worker 间调度编排模式（正交于 CollaborationRunMode 的隔离方式）。
 *
 * - parallel：所有 worker 同时启动（Promise.all fan-out），互不可见。适合
 *   多方案对比、独立调研、并行 review。
 * - sequential：逐次执行，每个 worker 完成后下一个才开始，前一个 worker 的
 *   结论作为参考注入后一个的 prompt。适合「调研→编码→审查」这类有依赖、
 *   或需要基于前序结论修正的 pipeline（对标 Claude Code 的串行 spawn）。
 * - pipeline：与 sequential 同样逐次 + 上一步结果注入，但语义上强调链式产物
 *   传递（实现复用 sequential 调度）。适合显式表达上下游流水线。
 * - dag：依赖图。MVP 阶段降级为 sequential（按声明顺序执行），保留枚举值
 *   供 planner 声明意图，后续按 dependsOn 拓扑排序实现。
 *
 * 与 mode 的关系：mode 决定隔离方式（analysis 只读共享 cwd / isolated_coding
 * git worktree 隔离），workflow 决定 worker 间时序。两者正交。
 */
export type SubagentWorkflow = "parallel" | "sequential" | "pipeline" | "dag";

export interface WorkerToolActivity {
  toolName: string;
  /** 从工具 input 里提取的关键信息：bash→命令、edit/write/read→文件路径、grep/find→pattern、code_search→query、codegraph→action + query/symbol、subagent→message。其他工具可为空串。 */
  summary: string;
  status: "running" | "done" | "error";
  /** ISO 时间戳 */
  ts: string;
}

export interface CollaborationWorkerSpec {
  name: string;
  task: string;
  /** 依赖的前置 worker 名（pipeline/dag 用）。parallel/sequential 模式忽略。 */
  dependsOn?: string[];
}

export interface CollaborationWorkerState extends CollaborationWorkerSpec {
  workerId: string;
  title?: string;
  instructions?: string;
  agentType?: SubagentTaskMode;
  capability?: SubagentCapability;
  model?: { provider: string; modelId: string };
  sessionId?: string;
  status: CollaborationWorkerStatus;
  result?: string;
  error?: string;
  worktreePath?: string;
  diff?: string;
  diffStats?: string;
  patchSha256?: string;
  patchBytes?: number;
  changedFiles?: string[];
  binaryFiles?: string[];
  changeStats?: WorktreeChangeStats;
  captureErrorCode?: string;
  appliedFiles?: string[];
  conflictFiles?: string[];
  workerSessionState?: WorkerSessionState;
  canContinue?: boolean;
  continueUnavailableReason?: string;
  continueExpiresAt?: string;
  /** 当前正在执行的工具（worker 运行期间实时更新）；无工具执行时为 undefined */
  activeTool?: WorkerToolActivity;
  /** 最近的工具调用历史（含执行结果），最多保留 8 条，新的在前 */
  recentTools?: WorkerToolActivity[];
}

export interface WorktreeRunCapabilities {
  implementation: "none" | "legacy" | "v2";
  review: boolean;
  apply: boolean;
  continue: boolean;
  discard: boolean;
}

export interface CollaborationRunState {
  runId: string;
  /** Monotonically increasing store revision used by compare-and-set updates. */
  version: number;
  parentSessionId?: string;
  parentEntryId?: string;
  cwd: string;
  title?: string;
  message: string;
  mode: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  runPlacement?: SubagentRunPlacement;
  /** worker 间调度编排模式。未设置视为 "parallel"（向后兼容）。 */
  workflow?: SubagentWorkflow;
  status: CollaborationRunStatus;
  isGit?: boolean;
  /** Internal lifecycle fact. Must be removed by every external projection. */
  worktreeManifestPath?: string;
  worktreeImplementation?: 2;
  baseCommit?: string;
  captureState?: "pending" | "captured" | "preserved" | "failed";
  applyState?: "idle" | "applying" | "applied" | "failed" | "recovery_required";
  applyTransactionId?: string;
  /** Required together with applyTransactionId while status is applying. */
  applyStartedAt?: string;
  recoveryState?: "legacy_recovery_required" | "manual_recovery_required";
  workers: CollaborationWorkerState[];
  events: CollaborationRunEvent[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
  canContinue?: boolean;
  continueUnavailableReason?: string;
  continueExpiresAt?: string;
  /** 继承自父 session 的 model。worker 创建后立即切到它，避免 worker 用
   *  modelRegistry 的默认 model（实测会拿到超时的 openai/gpt-4）导致整个
   *  subagent 任务卡在 waitForCollaborationRun 直到全部 worker 超时。 */
  model?: { provider: string; modelId: string };
}

export interface CollaborationRunEvent {
  eventId?: string;
  type:
    | "task_created"
    | "run_setup_complete"
    | "run_interrupted"
    | "worker_start"
    | "worker_resumed"
    | "worker_event"
    | "worker_complete"
    | "worker_error"
    | "worker_diff_ready"
    | "worker_capture_started"
    | "worker_capture_completed"
    | "worker_capture_error"
    | "worktree_preserved"
    | "worktree_cleanup_completed"
    | "worktree_cleanup_error"
    | "task_summary_ready"
    | "run_complete"
    | "run_aborted"
    | "run_error"
    | "patch_apply_started"
    | "patch_apply_checked"
    | "patch_apply_committed"
    | "patch_apply_recovery_required"
    | "patch_applied"
    | "patch_apply_error";
  runId: string;
  workerId?: string;
  timestamp?: string;
  event?: AgentEvent;
  result?: string;
  error?: string;
  summary?: string;
  diff?: string;
  diffStats?: string;
  files?: string[];
  transactionId?: string;
  phase?: "prepared" | "checked" | "applied" | "persisted";
  errorCode?: string;
  reasonCode?: string;
  fileCount?: number;
  binaryFileCount?: number;
}

export interface CollaborationRunSnapshot {
  runId: string;
  version: number;
  worktreeImplementation?: 2;
  worktreeCapabilities?: WorktreeRunCapabilities;
  taskId?: string;
  parentEntryId?: string;
  title?: string;
  mode: CollaborationRunMode;
  taskMode?: SubagentTaskMode;
  runPlacement?: SubagentRunPlacement;
  workflow?: SubagentWorkflow;
  status: CollaborationRunStatus;
  baseCommit?: string;
  captureState?: "pending" | "captured" | "preserved" | "failed";
  applyState?: "idle" | "applying" | "applied" | "failed" | "recovery_required";
  applyTransactionId?: string;
  applyStartedAt?: string;
  recoveryState?: "legacy_recovery_required" | "manual_recovery_required";
  message: string;
  workers: CollaborationWorkerState[];
  events?: CollaborationRunEvent[];
  summary?: string;
  error?: string;
  canContinue?: boolean;
  continueUnavailableReason?: string;
  continueExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyCollaborationPatchesResult {
  success: boolean;
  applied: string[];
  failed: Array<{ workerName: string; error: string }>;
  conflicts: string[];
  appliedFiles?: string[];
  conflictFiles?: string[];
}
