import type { CollaborationRunSnapshot } from "./parallel-agent/collaboration-types";
import type { CollaborationMuxSnapshot } from "./parallel-agent/collaboration-mux";

function version(value: { version?: number }): number {
  return Number.isSafeInteger(value.version) ? value.version! : 0;
}

export function isCollaborationSnapshotOlder(
  incoming: { version?: number; updatedAt: string },
  current: { version?: number; updatedAt: string },
): boolean {
  if (version(incoming) !== version(current)) return version(incoming) < version(current);
  return incoming.updatedAt < current.updatedAt;
}

/** Fetch details only when facts absent from the small Mux projection changed. */
export function collaborationNeedsHydration(previous: CollaborationRunSnapshot, snapshot: CollaborationMuxSnapshot): boolean {
  if (isCollaborationSnapshotOlder(snapshot, previous) || snapshot.status === "removed") return false;
  if (snapshot.status !== previous.status && !["running", "setting_up", "applying"].includes(snapshot.status)) return true;
  if (snapshot.captureState !== previous.captureState || snapshot.applyState !== previous.applyState
    || snapshot.recoveryState !== previous.recoveryState) return true;
  const lifecycle = snapshot.lifecycleEvent;
  if (lifecycle?.eventId && lifecycle.type !== "worker_capture_started"
    && !previous.events?.some((event) => event.eventId === lifecycle.eventId)) return true;
  return snapshot.workers.some((worker) => {
    const old = previous.workers.find((candidate) => worker.workerId ? candidate.workerId === worker.workerId : candidate.name === worker.name);
    return !old || worker.patchSha256 !== old.patchSha256
      || (worker.changedFileCount ?? 0) !== (old.changedFiles?.length ?? 0);
  });
}

export function mergeCollaborationMuxSnapshot(previous: CollaborationRunSnapshot, snapshot: CollaborationMuxSnapshot): CollaborationRunSnapshot {
  if (isCollaborationSnapshotOlder(snapshot, previous)) return previous;
  const details = new Map(previous.workers.map((worker) => [worker.workerId ?? worker.name, worker]));
  return {
    ...previous,
    version: version(snapshot),
    title: snapshot.title ?? previous.title,
    status: snapshot.status === "removed" ? "aborted" : snapshot.status,
    workflow: snapshot.workflow,
    captureState: snapshot.captureState,
    applyState: snapshot.applyState,
    recoveryState: snapshot.recoveryState,
    worktreeCapabilities: snapshot.worktreeCapabilities,
    applyTransactionId: snapshot.applyTransactionId,
    canContinue: snapshot.canContinue,
    continueExpiresAt: snapshot.continueExpiresAt,
    updatedAt: snapshot.updatedAt,
    workers: snapshot.workers.map((worker) => {
      const old = details.get(worker.workerId ?? worker.name);
      const staleArtifact = old?.patchSha256 !== worker.patchSha256
        || (old?.changedFiles?.length ?? 0) !== (worker.changedFileCount ?? 0);
      return {
        ...old,
        ...worker,
        workerId: worker.workerId ?? worker.name,
        task: old?.task ?? "",
        // A new digest is not a new file list. Disable old artifact selection until
        // the matching detail response arrives, including same-version cold recovery.
        ...(staleArtifact ? { patchSha256: undefined, patchBytes: undefined, changedFiles: undefined, binaryFiles: undefined, changeStats: undefined, appliedFiles: undefined } : {}),
        sessionId: undefined,
        worktreePath: undefined,
      };
    }),
  };
}
