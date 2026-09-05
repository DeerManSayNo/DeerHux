import type {
  CollaborationRunState,
  CollaborationRunEvent,
  CollaborationRunStatus,
  CollaborationWorkerStatus,
  SubagentWorkflow,
  WorkerToolActivity,
} from "./collaboration-types";
import { sanitizeCollaborationLifecycleEvent, sanitizeWorkerToolActivity } from "./collaboration-sanitize.ts";
import { getWorktreeRunCapabilities } from "./worktree-rollout.ts";

export type CollaborationMuxWorker = {
  workerId?: string;
  name: string;
  title?: string;
  status: CollaborationWorkerStatus;
  /** 仅指示内部 Session 已就绪；任何出站快照都不返回 Session ID。 */
  sessionReady?: true;
  changedFileCount?: number;
  binaryFileCount?: number;
  patchSha256?: string;
  canContinue?: boolean;
  activeTool?: Pick<WorkerToolActivity, "toolName" | "summary" | "status" | "ts">;
  recentTools?: Array<Pick<WorkerToolActivity, "toolName" | "summary" | "status" | "ts">>;
};

export type CollaborationMuxSnapshot = {
  authoritative: true;
  runId: string;
  version: number;
  worktreeCapabilities?: import("./collaboration-types").WorktreeRunCapabilities;
  status: CollaborationRunStatus | "removed";
  captureState?: CollaborationRunState["captureState"];
  applyState?: CollaborationRunState["applyState"];
  recoveryState?: CollaborationRunState["recoveryState"];
  canContinue?: boolean;
  lifecycleEvent?: CollaborationRunEvent;
  applyTransactionId?: string;
  continueExpiresAt?: string;
  title?: string;
  workflow?: SubagentWorkflow;
  workers: CollaborationMuxWorker[];
  updatedAt: string;
};

/**
 * Build the only collaboration payload allowed on the live Mux channel.
 * Results and prompts stay on the explicit detail endpoint. Internal paths,
 * session ids and open-ended worker events are excluded from both projections.
 */
export function toCollaborationMuxSnapshot(state: CollaborationRunState): CollaborationMuxSnapshot {
  const lifecycleEvent = state.events.findLast((event) => Boolean(sanitizeCollaborationLifecycleEvent(event)));
  return {
    authoritative: true,
    runId: state.runId,
    version: state.version,
    worktreeCapabilities: getWorktreeRunCapabilities(state),
    status: state.status,
    ...(state.captureState ? { captureState: state.captureState } : {}),
    ...(state.applyState ? { applyState: state.applyState } : {}),
    ...(state.recoveryState ? { recoveryState: state.recoveryState } : {}),
    ...(typeof state.canContinue === "boolean" ? { canContinue: state.canContinue } : {}),
    ...(state.applyTransactionId ? { applyTransactionId: state.applyTransactionId } : {}),
    ...(state.continueExpiresAt ? { continueExpiresAt: state.continueExpiresAt } : {}),
    ...(lifecycleEvent ? { lifecycleEvent: sanitizeCollaborationLifecycleEvent(lifecycleEvent)! } : {}),
    ...(state.title ? { title: state.title } : {}),
    ...(state.workflow ? { workflow: state.workflow } : {}),
    workers: state.workers.map((worker) => ({
      ...(worker.workerId ? { workerId: worker.workerId } : {}),
      name: worker.name,
      ...(worker.title ? { title: worker.title } : {}),
      status: worker.status,
      ...(worker.sessionId ? { sessionReady: true as const } : {}),
      ...(worker.changedFiles ? { changedFileCount: worker.changedFiles.length } : {}),
      ...(worker.binaryFiles ? { binaryFileCount: worker.binaryFiles.length } : {}),
      ...(worker.patchSha256 && /^[a-f0-9]{64}$/.test(worker.patchSha256) ? { patchSha256: worker.patchSha256 } : {}),
      ...(typeof worker.canContinue === "boolean" ? { canContinue: worker.canContinue } : {}),
      ...(worker.activeTool ? { activeTool: sanitizeWorkerToolActivity(worker.activeTool) } : {}),
      ...(worker.recentTools ? { recentTools: worker.recentTools.map(sanitizeWorkerToolActivity) } : {}),
    })),
    updatedAt: state.updatedAt,
  };
}

/** An explicit authoritative tombstone; an empty/missing run is not silence. */
export function removedCollaborationMuxSnapshot(runId: string): CollaborationMuxSnapshot {
  return {
    authoritative: true,
    runId,
    version: 0,
    status: "removed",
    workers: [],
    updatedAt: new Date().toISOString(),
  };
}
