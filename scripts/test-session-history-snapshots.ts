import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSessionHistorySnapshotStore } from "../lib/session-history-snapshots.ts";

const message = (text: string) => ({ role: "user" as const, content: text });
const snapshot = (text: string, fullHistoryLoaded = false) => ({
  messages: [message(text)],
  entryIds: [`entry-${text}`],
  fullHistoryLoaded,
  hasOlderMessages: !fullHistoryLoaded,
});

// A workspace slot is presentation-only. Its React key must follow session
// identity so inserting a worker before a parent moves the parent component
// rather than reusing it for the worker and resetting its Hook state.
{
  const workspace = readFileSync(new URL("../components/ChatWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /key=\{slotId \?\? `empty-slot-\$\{index\}`\}/);
  assert.doesNotMatch(workspace, /<section\s+key=\{index\}/);
}

// Snapshot identity is the session id, not the workspace slot. Moving the same
// session to another slot must restore the exact complete-history state.
{
  const store = createSessionHistorySnapshotStore();
  store.set("parent", snapshot("parent-full-history", true));
  store.set("worker", snapshot("worker-recent-history"));

  const parent = store.get("parent");
  assert.equal(parent?.messages[0]?.content, "parent-full-history");
  assert.equal(parent?.fullHistoryLoaded, true);
  assert.equal(parent?.hasOlderMessages, false);
  assert.equal(store.get("worker")?.messages[0]?.content, "worker-recent-history");
}

// The store is bounded LRU. Recently read sessions stay resident when a new
// session is inserted, preventing an unbounded client-side message cache.
{
  const store = createSessionHistorySnapshotStore();
  for (let i = 0; i < 12; i += 1) store.set(`session-${i}`, snapshot(String(i)));
  assert.equal(store.size, 12);

  // Promote session-0, then add a thirteenth session. session-1 is now LRU.
  assert.ok(store.get("session-0"));
  store.set("session-12", snapshot("12"));
  assert.equal(store.size, 12);
  assert.equal(store.get("session-1"), null);
  assert.ok(store.get("session-0"));
  assert.ok(store.get("session-12"));
}

// Explicit removal handles a 404/deleted session without retaining stale data.
{
  const store = createSessionHistorySnapshotStore();
  store.set("deleted", snapshot("stale"));
  store.delete("deleted");
  assert.equal(store.get("deleted"), null);
}

console.log("session history snapshot tests passed");
