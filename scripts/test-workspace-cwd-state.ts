import assert from "node:assert/strict";
import { retainCwdWorkspaceState } from "../lib/workspace-cwd-state.ts";
import type { SessionInfo } from "../lib/types.ts";

const alpha = (id: string): SessionInfo => ({
  id,
  cwd: "/projects/alpha",
  path: "",
  name: id,
  created: "2026-08-18T00:00:00.000Z",
  modified: "2026-08-18T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
});
const beta = (id: string): SessionInfo => ({ ...alpha(id), cwd: "/projects/beta" });

{
  const oldTab = alpha("old-tab");
  const oldPlaceholder = alpha("old-placeholder");
  const keptTab = beta("kept-tab");
  const keptPending = beta("kept-pending");
  const next = retainCwdWorkspaceState({
    sessionTabs: [oldTab, oldPlaceholder, keptTab],
    chatSlotIds: ["old-tab", "old-placeholder", "kept-tab", null],
    selectedSession: oldTab,
    pendingSession: keptPending,
    activeSessionTabId: "old-placeholder",
    newSessionCwd: "/projects/alpha",
    focusedChatSlotIndex: 1,
    placeholderTabIds: new Set(["old-placeholder"]),
    pendingSessionIdsBySlot: new Map([[0, "old-tab"], [2, "kept-pending"]]),
    pendingTempTabIdsBySlot: new Map([[1, "old-placeholder"]]),
    runningSessionIds: new Set(["old-tab", "kept-tab", "untracked-old-running"]),
  }, "/projects/beta");

  assert.deepEqual(next.sessionTabs.map((session) => session.id), ["kept-tab", "kept-pending"]);
  assert.deepEqual(next.chatSlotIds, [null, null, "kept-tab", null]);
  assert.equal(next.selectedSession, null);
  assert.equal(next.pendingSession?.id, "kept-pending");
  assert.equal(next.activeSessionTabId, null);
  assert.equal(next.newSessionCwd, null);
  assert.equal(next.focusedChatSlotIndex, 2);
  assert.deepEqual([...next.placeholderTabIds], []);
  assert.deepEqual([...next.pendingSessionIdsBySlot], [[2, "kept-pending"]]);
  assert.deepEqual([...next.pendingTempTabIdsBySlot], []);
  assert.deepEqual([...next.runningSessionIds], ["kept-tab"]);
  assert.deepEqual([...next.staleSessionIds].sort(), ["old-placeholder", "old-tab", "untracked-old-running"]);
}

{
  const betaTab = beta("beta-tab");
  const next = retainCwdWorkspaceState({
    sessionTabs: [betaTab],
    chatSlotIds: ["beta-tab", null],
    selectedSession: betaTab,
    pendingSession: null,
    activeSessionTabId: "beta-tab",
    newSessionCwd: "/projects/beta",
    focusedChatSlotIndex: 0,
    placeholderTabIds: new Set(),
    pendingSessionIdsBySlot: new Map(),
    pendingTempTabIdsBySlot: new Map(),
    runningSessionIds: new Set(["beta-tab"]),
  }, "/projects/beta");

  assert.deepEqual(next.sessionTabs.map((session) => session.id), ["beta-tab"]);
  assert.deepEqual(next.chatSlotIds, ["beta-tab", null]);
  assert.equal(next.selectedSession?.id, "beta-tab");
  assert.equal(next.activeSessionTabId, "beta-tab");
  assert.equal(next.newSessionCwd, "/projects/beta");
  assert.equal(next.focusedChatSlotIndex, 0);
  assert.deepEqual([...next.runningSessionIds], ["beta-tab"]);
  assert.deepEqual([...next.staleSessionIds], []);
}

console.log("workspace CWD state tests passed");
