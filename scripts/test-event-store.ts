import assert from "node:assert/strict";
import { EventStore, type SequencedAgentEvent } from "../lib/agent-runtime/event-store.ts";

function append(
  store: EventStore,
  sessionId: string,
  type: string,
  turnId = "turn-1",
  runId = sessionId,
): SequencedAgentEvent {
  return store.append({
    sessionId,
    runId,
    turnId,
    event: { type, message: { content: type } },
  });
}

function testLegacyApiAndJournalFields(): void {
  const store = new EventStore({ epoch: "epoch-test" });
  const first = append(store, "session-a", "message_start");
  const second = append(store, "session-a", "message_end");

  assert.deepEqual(store.getSince("session-a").map((event) => event.seq), [1, 2]);
  assert.equal(store.getLastSeq("session-a"), 2);
  assert.equal(second.eventId, "epoch-test:2");
  assert.equal(second.epoch, "epoch-test");
  assert.equal(second.globalSeq, 2);
  assert.equal(second.sessionSeq, 2);
  assert.equal(second.topic, "message_end");
  assert.equal(second.payload, second.event);
  assert.equal(first.globalSeq, 1);
}

function testCoalescingPreservesHonestCursorRanges(): void {
  const store = new EventStore({ epoch: "epoch-test" });
  append(store, "session-a", "message_start");
  append(store, "session-a", "message_update");
  append(store, "session-a", "message_update");
  append(store, "session-a", "message_update");
  append(store, "session-a", "message_end");

  const legacyReplay = store.getSince("session-a");
  assert.deepEqual(legacyReplay.map((event) => event.seq), [1, 4, 5]);
  assert.deepEqual(legacyReplay.map((event) => [event.seqStart, event.seq]), [
    [1, 1], [2, 4], [5, 5],
  ]);

  const replay = store.getGlobalSince({ epoch: "epoch-test", globalSeq: 1 });
  assert.equal(replay.snapshotRequired, false);
  assert.deepEqual(replay.events.map((event) => event.globalSeq), [4, 5]);
  assert.deepEqual(replay.events.map((event) => [event.globalSeqStart, event.globalSeq]), [
    [2, 4], [5, 5],
  ]);

  // A cursor inside a coalesced range is resumable: globalSeq 2 and 3 were
  // superseded snapshots, not evicted journal data.
  const insideRange = store.getGlobalSince({ epoch: "epoch-test", globalSeq: 2 });
  assert.equal(insideRange.snapshotRequired, false);
  assert.deepEqual(insideRange.events.map((event) => event.globalSeq), [4, 5]);
}

function testGlobalOrderingSessionSequencesAndSubscribeAll(): void {
  const store = new EventStore({ epoch: "epoch-test" });
  const delivered: string[] = [];
  const unsubscribe = store.subscribeAll((event) => delivered.push(event.eventId));

  const a1 = append(store, "session-a", "message_start");
  const b1 = append(store, "session-b", "message_start");
  const a2 = append(store, "session-a", "message_end");
  unsubscribe();
  append(store, "session-b", "message_end");

  assert.deepEqual(delivered, ["epoch-test:1", "epoch-test:2", "epoch-test:3"]);
  assert.deepEqual([a1.sessionSeq, b1.sessionSeq, a2.sessionSeq], [1, 1, 2]);
  assert.deepEqual(store.getGlobalSince().events.map((event) => event.sessionId), [
    "session-a", "session-b", "session-a", "session-b",
  ]);
}

function testResumeDecisionsAndIndependentRetention(): void {
  let now = 0;
  const store = new EventStore({
    epoch: "epoch-test",
    maxGlobalEvents: 3,
    maxEventsPerSession: 2,
    maxEventsPerRun: 1,
    globalTtlMs: 100,
    sessionTtlMs: 20,
    runTtlMs: 10,
    now: () => now,
  });

  append(store, "session-a", "message_start", "turn-1", "run-a");
  now = 1;
  append(store, "session-b", "message_start", "turn-1", "run-b");
  now = 2;
  append(store, "session-a", "message_end", "turn-1", "run-a");
  now = 3;
  append(store, "session-b", "message_end", "turn-1", "run-b");

  assert.deepEqual(store.getSince("run-a").map((event) => event.globalSeq), [3]);
  assert.deepEqual(store.getSessionSince("session-a").map((event) => event.globalSeq), [1, 3]);
  assert.deepEqual(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 1 }).events
    .map((event) => event.globalSeq), [2, 3, 4]);

  const evicted = store.getGlobalSince({ epoch: "epoch-test", globalSeq: 0 });
  assert.equal(evicted.snapshotRequired, true);
  assert.equal(evicted.reason, "cursor_evicted");
  assert.deepEqual(evicted.events, []);

  const epochMismatch = store.canResume({ epoch: "old-epoch", globalSeq: 4 });
  assert.equal(epochMismatch.reason, "epoch_mismatch");
  assert.equal(epochMismatch.snapshotRequired, true);

  now = 25;
  // Run/session TTL expiry is independent: global history remains available.
  assert.deepEqual(store.getSince("run-a"), []);
  assert.deepEqual(store.getSessionSince("session-a"), []);
  assert.deepEqual(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 1 }).events
    .map((event) => event.globalSeq), [2, 3, 4]);

  now = 200;
  assert.equal(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 4 }).snapshotRequired, false);
  assert.equal(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 3 }).reason, "cursor_evicted");
}

testLegacyApiAndJournalFields();
testCoalescingPreservesHonestCursorRanges();
testGlobalOrderingSessionSequencesAndSubscribeAll();
testResumeDecisionsAndIndependentRetention();
console.log("event store tests passed");
