import type { CollaborationRunEvent, CollaborationRunState } from "./collaboration-types";

const TERMINAL_RUN_STATUSES = new Set<CollaborationRunState["status"]>([
  "complete",
  "aborted",
  "error",
  "applied",
  "recoverable",
]);

const TERMINAL_RUN_EVENTS = new Set<CollaborationRunEvent["type"]>([
  "run_complete",
  "run_error",
  "run_aborted",
]);

export interface ForegroundRunWaitOptions {
  runId: string;
  signal?: AbortSignal;
  getRun: (runId: string) => CollaborationRunState | undefined;
  subscribe: (runId: string, listener: (event: CollaborationRunEvent) => void) => () => void;
  abortRun: (runId: string) => Promise<boolean>;
  onProgress?: (event: CollaborationRunEvent, run: CollaborationRunState) => void;
}

/**
 * Foreground collaboration is a lifecycle barrier for its parent tool call.
 * It may resolve only with a terminal run. On abort we first stop and join the
 * workers; returning a still-running snapshot would detach them from
 * the parent loop and let the parent emit a false successful completion.
 */
export function waitForForegroundRun(options: ForegroundRunWaitOptions): Promise<CollaborationRunState> {
  const { runId, signal, getRun, subscribe, abortRun, onProgress } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let aborting = false;
    let unsubscribe = () => {};

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleSignalAbort);
      unsubscribe();
      fn();
    };

    const resolveTerminal = (missingMessage: string): boolean => {
      const latest = getRun(runId);
      if (!latest) {
        settle(() => reject(new Error(missingMessage)));
        return true;
      }
      if (!TERMINAL_RUN_STATUSES.has(latest.status)) return false;
      settle(() => resolve(latest));
      return true;
    };

    const abortAndJoin = (fallbackError: Error) => {
      if (settled || aborting) return;
      aborting = true;
      void abortRun(runId).then(() => {
        // abortCollaborationRun emits run_aborted only after worker aborts have
        // settled. The listener normally resolves first; this handles races and
        // already-terminal runs without ever accepting a running snapshot.
        if (!settled && !resolveTerminal("Run not found after foreground abort")) {
          settle(() => reject(fallbackError));
        }
      }).catch((error) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
    };

    function handleSignalAbort() {
      abortAndJoin(new DOMException("Subagent task aborted", "AbortError"));
    }

    const installedUnsubscribe = subscribe(runId, (event) => {
      const latest = getRun(runId);
      if (!latest) {
        if (TERMINAL_RUN_EVENTS.has(event.type)) {
          settle(() => reject(new Error("Run not found after completion")));
        }
        return;
      }
      if (TERMINAL_RUN_EVENTS.has(event.type)) {
        if (!TERMINAL_RUN_STATUSES.has(latest.status)) {
          settle(() => reject(new Error(`Foreground run emitted ${event.type} with non-terminal status ${latest.status}`)));
          return;
        }
        settle(() => resolve(latest));
        return;
      }
      onProgress?.(event, latest);
    });
    unsubscribe = installedUnsubscribe;
    // Defensive support for stores that replay synchronously from subscribe().
    if (settled) {
      unsubscribe();
      return;
    }

    // Close the start -> subscribe race: a fast worker may have completed before
    // the listener was installed. Reading state after subscription covers both
    // sides without missing a terminal transition.
    if (resolveTerminal("Run not found while waiting for foreground completion")) return;

    if (signal?.aborted) handleSignalAbort();
    else signal?.addEventListener("abort", handleSignalAbort, { once: true });
  });
}
