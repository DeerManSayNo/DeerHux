import type { CollaborationRunSnapshot, CollaborationRunState, WorktreeRunCapabilities } from "./collaboration-types";

/** Admission only: changing this flag must never reroute existing Runs to legacy code. */
export function getWorktreeRollout(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    implementationVersion: 2 as const,
    newRunsEnabled: env.SUBAGENT_WORKTREE_V2 === "1" || env.SUBAGENT_WORKTREE_V2 === "true",
    // Independent emergency brake. Historical replay and artifact reads remain available.
    newApplyEnabled: env.SUBAGENT_WORKTREE_V2_APPLY === undefined
      || env.SUBAGENT_WORKTREE_V2_APPLY === "1" || env.SUBAGENT_WORKTREE_V2_APPLY === "true",
    legacyMutationEnabled: false as const,
  };
}

export function getWorktreeRunCapabilities(state: CollaborationRunState | CollaborationRunSnapshot): WorktreeRunCapabilities {
  const v2 = state.mode === "isolated_coding" && (state.worktreeImplementation === 2
    || ("worktreeManifestPath" in state && typeof state.worktreeManifestPath === "string" && state.worktreeManifestPath.length > 0));
  return {
    implementation: state.mode !== "isolated_coding" ? "none" : v2 ? "v2" : "legacy",
    review: v2,
    apply: v2 && getWorktreeRollout().newApplyEnabled,
    continue: v2,
    discard: v2,
  };
}
