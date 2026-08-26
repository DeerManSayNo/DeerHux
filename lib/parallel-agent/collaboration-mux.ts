import type {
  CollaborationRunState,
  CollaborationRunStatus,
  CollaborationWorkerStatus,
  SubagentWorkflow,
  WorkerToolActivity,
} from "./collaboration-types";

export type CollaborationMuxWorker = {
  workerId?: string;
  name: string;
  title?: string;
  status: CollaborationWorkerStatus;
  /** prompt 已准入并持久化，详情接口此时可安全返回可打开的 sessionId。 */
  sessionReady?: true;
  activeTool?: Pick<WorkerToolActivity, "toolName" | "summary" | "status" | "ts">;
  recentTools?: Array<Pick<WorkerToolActivity, "toolName" | "summary" | "status" | "ts">>;
};

export type CollaborationMuxSnapshot = {
  authoritative: true;
  runId: string;
  status: CollaborationRunStatus | "removed";
  title?: string;
  workflow?: SubagentWorkflow;
  workers: CollaborationMuxWorker[];
  updatedAt: string;
};

/**
 * Build the only collaboration payload allowed on the live Mux channel.
 * Results, prompts, paths, session ids and open-ended worker events stay on the
 * explicit detail endpoint and can never leak into the background stream.
 */
export function toCollaborationMuxSnapshot(state: CollaborationRunState): CollaborationMuxSnapshot {
  return {
    authoritative: true,
    runId: state.runId,
    status: state.status,
    ...(state.title ? { title: state.title } : {}),
    ...(state.workflow ? { workflow: state.workflow } : {}),
    workers: state.workers.map((worker) => ({
      ...(worker.workerId ? { workerId: worker.workerId } : {}),
      name: worker.name,
      ...(worker.title ? { title: worker.title } : {}),
      status: worker.status,
      ...(worker.sessionId ? { sessionReady: true as const } : {}),
      ...(worker.activeTool ? { activeTool: { ...worker.activeTool } } : {}),
      ...(worker.recentTools ? { recentTools: worker.recentTools.map((tool) => ({ ...tool })) } : {}),
    })),
    updatedAt: state.updatedAt,
  };
}

/** An explicit authoritative tombstone; an empty/missing run is not silence. */
export function removedCollaborationMuxSnapshot(runId: string): CollaborationMuxSnapshot {
  return {
    authoritative: true,
    runId,
    status: "removed",
    workers: [],
    updatedAt: new Date().toISOString(),
  };
}
