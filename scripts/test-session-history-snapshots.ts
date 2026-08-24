import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSessionHistorySnapshotStore } from "../lib/session-history-snapshots.ts";
import { getChatRenderKey, promoteChatRenderKey } from "../lib/chat-render-keys.ts";
import { mergeFullSessionHistory } from "../lib/session-history-merge.ts";

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
  assert.match(workspace, /key=\{slotId \? getSessionRenderKey\(slotId\) : `empty-slot-\$\{index\}`\}/);
  assert.doesNotMatch(workspace, /<section\s+key=\{index\}/);
}

// A placeholder adopting its durable session id is still the same ChatWindow.
// Its render key must survive so optimistic messages and streaming state remain mounted.
{
  const renderKeys = new Map<string, string>();
  assert.equal(getChatRenderKey(renderKeys, "temporary"), "temporary");
  promoteChatRenderKey(renderKeys, "temporary", "durable");
  assert.equal(getChatRenderKey(renderKeys, "durable"), "temporary");
  assert.equal(renderKeys.has("temporary"), false);

  // Fork/project switches are different logical chats and must not call promote.
  renderKeys.delete("durable");
  assert.equal(getChatRenderKey(renderKeys, "forked"), "forked");
}

// Loading full worker history while it is running must retain durable and
// optimistic messages that arrived after the full-history snapshot was read.
{
  const merged = mergeFullSessionHistory(
    [message("old"), message("overlap")],
    ["entry-old", "entry-overlap"],
    [message("overlap"), message("live"), { ...message("pending"), clientMessageId: "client-1" }],
    ["entry-overlap", "entry-live", ""],
  );
  assert.deepEqual(merged.messages.map((item) => item.content), ["old", "overlap", "live", "pending"]);
  assert.deepEqual(merged.entryIds, ["entry-old", "entry-overlap", "entry-live", ""]);
}

// Full-history loading must reconcile the durable snapshot before merging the
// live tail. Reversing this order lets an appended optimistic copy confirm
// itself and remain below the assistant response.
{
  const hook = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const fullHistoryBlock = hook.slice(hook.indexOf("const loadFullHistory"), hook.indexOf("const loadTools"));
  assert.match(
    fullHistoryBlock,
    /const reconciledLoaded = reconcilePendingUserMessages\([\s\S]*?const merged = mergeFullSessionHistory\(\s*reconciledLoaded\.messages/,
  );
}

// A durable user message and its optimistic local copy are the same logical
// message. Full-history loading must keep the durable position instead of
// appending the local copy below the assistant response.
{
  const persistedUser = { ...message("question"), clientMessageId: "client-question" };
  const merged = mergeFullSessionHistory(
    [message("old"), persistedUser, { role: "assistant" as const, content: "answer" }],
    ["entry-old", "entry-question", "entry-answer"],
    [persistedUser],
    [""],
  );
  assert.deepEqual(merged.messages.map((item) => item.content), ["old", "question", "answer"]);
  assert.deepEqual(merged.entryIds, ["entry-old", "entry-question", "entry-answer"]);
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
