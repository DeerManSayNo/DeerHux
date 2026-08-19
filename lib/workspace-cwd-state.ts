import type { SessionInfo } from "./types";

export type CwdWorkspaceState = {
  sessionTabs: SessionInfo[];
  chatSlotIds: (string | null)[];
  selectedSession: SessionInfo | null;
  pendingSession: SessionInfo | null;
  activeSessionTabId: string | null;
  newSessionCwd: string | null;
  focusedChatSlotIndex: number;
  placeholderTabIds: ReadonlySet<string>;
  pendingSessionIdsBySlot: ReadonlyMap<number, string>;
  pendingTempTabIdsBySlot: ReadonlyMap<number, string>;
  runningSessionIds: ReadonlySet<string>;
};

export type CwdWorkspaceStateResult = {
  sessionTabs: SessionInfo[];
  chatSlotIds: (string | null)[];
  selectedSession: SessionInfo | null;
  pendingSession: SessionInfo | null;
  activeSessionTabId: string | null;
  newSessionCwd: string | null;
  focusedChatSlotIndex: number;
  placeholderTabIds: Set<string>;
  pendingSessionIdsBySlot: Map<number, string>;
  pendingTempTabIdsBySlot: Map<number, string>;
  runningSessionIds: Set<string>;
  staleSessionIds: Set<string>;
};

/**
 * Removes transient workspace state that belongs to a different project.
 *
 * The result is deliberately independent of React so CWD changes can update
 * state and imperative refs from one consistent snapshot.
 */
export function retainCwdWorkspaceState(
  state: CwdWorkspaceState,
  cwd: string,
): CwdWorkspaceStateResult {
  const sessionTabs = state.sessionTabs.filter((session) => session.cwd === cwd);
  const sessionTabsById = new Map(sessionTabs.map((session) => [session.id, session]));
  if (state.selectedSession?.cwd === cwd) sessionTabsById.set(state.selectedSession.id, state.selectedSession);
  if (state.pendingSession?.cwd === cwd) sessionTabsById.set(state.pendingSession.id, state.pendingSession);
  const retainedTabs = [...sessionTabsById.values()];
  const retainedSessionIds = new Set(retainedTabs.map((session) => session.id));

  const chatSlotIds = state.chatSlotIds.map((sessionId) => (
    sessionId && retainedSessionIds.has(sessionId) ? sessionId : null
  ));
  const placeholderTabIds = new Set(
    [...state.placeholderTabIds].filter((sessionId) => retainedSessionIds.has(sessionId)),
  );

  const pendingSessionIdsBySlot = new Map(
    [...state.pendingSessionIdsBySlot].filter(([slotIndex, sessionId]) => (
      chatSlotIds[slotIndex] !== null && retainedSessionIds.has(sessionId)
    )),
  );
  const pendingTempTabIdsBySlot = new Map(
    [...state.pendingTempTabIdsBySlot].filter(([slotIndex, sessionId]) => (
      chatSlotIds[slotIndex] !== null && retainedSessionIds.has(sessionId)
    )),
  );

  const activeSessionTabId = state.activeSessionTabId && retainedSessionIds.has(state.activeSessionTabId)
    ? state.activeSessionTabId
    : null;
  const focusedChatSlotIndex = chatSlotIds[state.focusedChatSlotIndex]
    ? state.focusedChatSlotIndex
    : Math.max(0, chatSlotIds.findIndex((sessionId) => sessionId !== null));

  const trackedSessionIds = new Set<string>();
  for (const session of state.sessionTabs) trackedSessionIds.add(session.id);
  if (state.selectedSession) trackedSessionIds.add(state.selectedSession.id);
  if (state.pendingSession) trackedSessionIds.add(state.pendingSession.id);
  for (const sessionId of state.chatSlotIds) if (sessionId) trackedSessionIds.add(sessionId);
  for (const sessionId of state.placeholderTabIds) trackedSessionIds.add(sessionId);
  for (const sessionId of state.pendingSessionIdsBySlot.values()) trackedSessionIds.add(sessionId);
  for (const sessionId of state.pendingTempTabIdsBySlot.values()) trackedSessionIds.add(sessionId);

  const staleSessionIds = new Set([...trackedSessionIds].filter((sessionId) => !retainedSessionIds.has(sessionId)));
  const runningSessionIds = new Set(
    [...state.runningSessionIds].filter((sessionId) => retainedSessionIds.has(sessionId)),
  );
  for (const sessionId of state.runningSessionIds) {
    if (!runningSessionIds.has(sessionId)) staleSessionIds.add(sessionId);
  }

  return {
    sessionTabs: retainedTabs,
    chatSlotIds,
    selectedSession: state.selectedSession?.cwd === cwd ? state.selectedSession : null,
    pendingSession: state.pendingSession?.cwd === cwd ? state.pendingSession : null,
    activeSessionTabId,
    newSessionCwd: state.newSessionCwd === cwd ? cwd : null,
    focusedChatSlotIndex,
    placeholderTabIds,
    pendingSessionIdsBySlot,
    pendingTempTabIdsBySlot,
    runningSessionIds,
    staleSessionIds,
  };
}
