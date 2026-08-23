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

function testByteBudgetsAndCoalescingAccounting(): void {
  const store = new EventStore({
    epoch: "epoch-test",
    maxGlobalEvents: 100,
    maxEventsPerSession: 100,
    maxEventsPerRun: 100,
    maxGlobalBytes: 1_500,
    maxSessionBytes: 900,
    maxRunBytes: 700,
  });
  const payload = "x".repeat(350);
  for (let index = 0; index < 8; index += 1) {
    store.append({
      sessionId: "session-a",
      runId: "run-a",
      turnId: "turn-a",
      event: { type: index % 2 === 0 ? "message_start" : "message_end", payload, index },
    });
  }
  assert.ok(store.getSince("run-a").length < 8);
  assert.ok(store.getSessionSince("session-a").length < 8);
  assert.ok(store.getGlobalSince().events.length < 8);

  const coalesced = new EventStore({
    epoch: "epoch-coalesce",
    maxGlobalBytes: 1_200,
    maxSessionBytes: 1_200,
    maxRunBytes: 1_200,
  });
  for (let index = 0; index < 20; index += 1) {
    coalesced.append({
      sessionId: "session-a",
      runId: "run-a",
      turnId: "turn-a",
      event: { type: "message_update", payload: "y".repeat(100 + index) },
    });
  }
  assert.equal(coalesced.getSince("run-a").length, 1);
  assert.equal(coalesced.getSessionSince("session-a").length, 1);
  assert.equal(coalesced.getGlobalSince().events.length, 1);
}

function testOversizedEventStillDeliversLive(): void {
  const store = new EventStore({
    epoch: "epoch-oversized",
    maxGlobalBytes: 500,
    maxSessionBytes: 500,
    maxRunBytes: 500,
  });
  const delivered: SequencedAgentEvent[] = [];
  const unsubscribe = store.subscribeAll((event) => delivered.push(event));
  const event = store.append({
    sessionId: "session-large",
    runId: "run-large",
    event: { type: "message_end", payload: "z".repeat(5_000) },
  });
  unsubscribe();
  assert.equal(delivered[0], event);
  assert.deepEqual(store.getSince("run-large"), []);
  assert.deepEqual(store.getSessionSince("session-large"), []);
  assert.equal(store.getGlobalSince().events.length, 0);
  const diagnostics = store.diagnostics();
  assert.equal(diagnostics.globalRetainedBytes, 0);
  assert.equal(diagnostics.sessionRetainedBytes, 0);
  assert.equal(diagnostics.runRetainedBytes, 0);
}

function testDiagnosticsCapacityAndEvictionReasons(): void {
  let now = 10;
  const countLimited = new EventStore({
    epoch: "epoch-count",
    maxGlobalEvents: 2,
    maxEventsPerSession: 2,
    maxEventsPerRun: 2,
    maxGlobalBytes: 1_000_000,
    maxSessionBytes: 1_000_000,
    maxRunBytes: 1_000_000,
    globalTtlMs: 1_000,
    sessionTtlMs: 1_000,
    runTtlMs: 1_000,
    now: () => now,
  });
  append(countLimited, "session-a", "message_start", "turn-a", "run-a");
  now = 20;
  append(countLimited, "session-a", "tool_start", "turn-a", "run-a");
  now = 30;
  append(countLimited, "session-a", "message_end", "turn-a", "run-a");
  let diagnostics = countLimited.diagnostics();
  assert.equal(diagnostics.epoch, "epoch-count");
  assert.equal(diagnostics.earliestGlobalSeq, 2);
  assert.equal(diagnostics.latestGlobalSeq, 3);
  assert.equal(diagnostics.oldestGlobalEventAgeMs, 10);
  assert.equal(diagnostics.newestGlobalEventAgeMs, 0);
  assert.equal(diagnostics.limits.maxGlobalEvents, 2);
  assert.equal(diagnostics.utilization.globalEvents, 1);
  assert.ok(diagnostics.utilization.globalBytes > 0 && diagnostics.utilization.globalBytes <= 1);
  assert.equal(diagnostics.evictions.global.eventLimit, 1);
  assert.equal(diagnostics.evictions.session.eventLimit, 1);
  assert.equal(diagnostics.evictions.run.eventLimit, 1);

  const byteLimited = new EventStore({
    epoch: "epoch-byte",
    maxGlobalBytes: 500,
    maxSessionBytes: 500,
    maxRunBytes: 500,
  });
  byteLimited.append({
    sessionId: "session-a",
    runId: "run-a",
    event: { type: "message_end", payload: "x".repeat(5_000) },
  });
  diagnostics = byteLimited.diagnostics();
  assert.equal(diagnostics.evictions.global.byteLimit, 1);
  assert.equal(diagnostics.evictions.session.byteLimit, 1);
  assert.equal(diagnostics.evictions.run.byteLimit, 1);

  let ttlNow = 0;
  const ttlLimited = new EventStore({ epoch: "epoch-ttl", ttlMs: 10, now: () => ttlNow });
  append(ttlLimited, "session-a", "message_end", "turn-a", "run-a");
  ttlNow = 20;
  diagnostics = ttlLimited.diagnostics();
  assert.equal(diagnostics.evictions.global.ttl, 1);
  assert.equal(diagnostics.evictions.session.ttl, 1);
  assert.equal(diagnostics.evictions.run.ttl, 1);
  assert.equal(diagnostics.oldestGlobalEventAgeMs, 0);

  const clearable = new EventStore({ epoch: "epoch-clear" });
  append(clearable, "session-a", "message_end", "turn-a", "run-a");
  clearable.clearAll();
  diagnostics = clearable.diagnostics();
  assert.equal(diagnostics.evictions.global.clear, 1);
  assert.equal(diagnostics.evictions.session.clear, 1);
  assert.equal(diagnostics.evictions.run.clear, 1);

  const clearRunStore = new EventStore({ epoch: "epoch-clear-run" });
  append(clearRunStore, "session-a", "message_end", "turn-a", "run-a");
  clearRunStore.clearRun("run-a");
  diagnostics = clearRunStore.diagnostics();
  assert.equal(diagnostics.evictions.run.clear, 1);
  assert.equal(diagnostics.globalEvents, 1, "clearRun must not clear the application journal");

  const coalesced = new EventStore({ epoch: "epoch-coalesced" });
  append(coalesced, "session-a", "message_update", "turn-a", "run-a");
  append(coalesced, "session-a", "message_update", "turn-a", "run-a");
  diagnostics = coalesced.diagnostics();
  assert.equal(diagnostics.evictions.global.total, 0);
  assert.equal(diagnostics.evictions.session.total, 0);
  assert.equal(diagnostics.evictions.run.total, 0);
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
  assert.equal(store.getRunSince("run-a", 0).reason, "cursor_evicted");
  assert.equal(store.getRunSince("run-a", 1).snapshotRequired, false);
  assert.equal(store.getRunSince("run-a", 2).snapshotRequired, false);
  assert.equal(store.getRunSince("run-a", 3).reason, "cursor_ahead");
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
  assert.equal(store.getLastSessionSeq("session-a"), 2, "global replay still references this session sequence");
  assert.deepEqual(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 1 }).events
    .map((event) => event.globalSeq), [2, 3, 4]);

  now = 200;
  assert.equal(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 4 }).snapshotRequired, false);
  assert.equal(store.getGlobalSince({ epoch: "epoch-test", globalSeq: 3 }).reason, "cursor_evicted");
  assert.equal(store.getLastSessionSeq("session-a"), 0);
}

testLegacyApiAndJournalFields();
testCoalescingPreservesHonestCursorRanges();
testGlobalOrderingSessionSequencesAndSubscribeAll();
testByteBudgetsAndCoalescingAccounting();
testOversizedEventStillDeliversLive();
testDiagnosticsCapacityAndEvictionReasons();
testResumeDecisionsAndIndependentRetention();
console.log("event store tests passed");
