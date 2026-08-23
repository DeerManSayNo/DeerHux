import assert from "node:assert/strict";
import { EventStore } from "../lib/agent-runtime/event-store.ts";
import {
  getMessageUpdateCoalescerDiagnostics,
  MessageUpdateCoalescer,
  resetMessageUpdateCoalescerDiagnosticsForTests,
} from "../lib/agent-runtime/event-coalescer.ts";

interface TestEvent {
  sessionId: string;
  runId: string;
  turnId?: string;
  globalSeq: number;
  event: { type: string; message?: { content: string } };
}

const update = (
  sessionId: string,
  globalSeq: number,
  content: string,
  turnId = "turn-1",
  runId = `run-${sessionId}`,
): TestEvent => ({
  sessionId,
  runId,
  turnId,
  globalSeq,
  event: { type: "message_update", message: { content } },
});

const barrier = (sessionId: string, globalSeq: number, type = "message_end"): TestEvent => ({
  sessionId,
  runId: `run-${sessionId}`,
  turnId: "turn-1",
  globalSeq,
  event: { type },
});

async function testStoreReplayCompression(): Promise<void> {
  const store = new EventStore({ maxEventsPerRun: 100 });
  const append = (type: string, content?: string, turnId = "turn-1") => store.append({
    sessionId: "session",
    runId: "session",
    turnId,
    event: { type, ...(content ? { message: { content } } : {}) },
  });

  append("message_start", "a");
  append("message_update", "a");
  append("message_update", "ab");
  append("message_update", "abc");
  append("message_end", "abc");

  const replay = store.getSince("session");
  assert.deepEqual(replay.map((item) => item.event.type), [
    "message_start", "message_update", "message_end",
  ]);
  assert.equal((replay[1].event.message as { content: string }).content, "abc");
  assert.equal((replay[2].event.message as { content: string }).content, "abc");
  assert.deepEqual(replay.map((item) => item.seq), [1, 4, 5]);
  assert.deepEqual(store.getSince("session", 2).map((item) => item.seq), [4, 5]);

  append("message_update", "next", "turn-2");
  append("tool_execution_start", undefined, "turn-2");
  append("message_update", "after tool", "turn-2");
  assert.deepEqual(store.getSince("session").slice(-3).map((item) => item.event.type), [
    "message_update", "tool_execution_start", "message_update",
  ]);
}

async function testLargeCumulativeUpdateRetention(): Promise<void> {
  const store = new EventStore({
    maxGlobalBytes: 2 * 1024 * 1024,
    maxSessionBytes: 2 * 1024 * 1024,
    maxRunBytes: 2 * 1024 * 1024,
  });
  let content = "";
  for (let index = 0; index < 10_000; index += 1) {
    content += "x";
    store.append({
      sessionId: "large-session",
      runId: "large-run",
      turnId: "large-turn",
      event: { type: "message_update", message: { role: "assistant", content } },
    });
  }
  assert.equal(store.getSince("large-run").length, 1);
  assert.equal(store.getSessionSince("large-session").length, 1);
  assert.equal(store.getGlobalSince().events.length, 1);
  const diagnostics = store.diagnostics();
  assert.ok(diagnostics.globalRetainedBytes < 20_000);
  assert.ok(diagnostics.sessionRetainedBytes < 20_000);
  assert.ok(diagnostics.runRetainedBytes < 20_000);
}

function testSameStreamCoalescing(): void {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event));
  coalescer.push(update("A", 1, "a"));
  coalescer.push(update("A", 2, "ab"));
  coalescer.push(update("A", 3, "abc"));
  coalescer.flush();
  assert.deepEqual(delivered.map((item) => item.globalSeq), [3]);
}

function testInterleavedSessions(): void {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event));
  coalescer.push(update("A", 1, "A1"));
  coalescer.push(update("B", 2, "B1"));
  coalescer.push(update("A", 3, "A2"));
  coalescer.push(update("B", 4, "B2"));
  coalescer.flush();
  assert.deepEqual(delivered.map((item) => [item.sessionId, item.globalSeq]), [["A", 3], ["B", 4]]);
}

async function testAutomaticTimerFlush(): Promise<void> {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event), 10);
  coalescer.push(update("A", 1, "A1"));
  coalescer.push(update("B", 2, "B1"));
  coalescer.push(update("A", 3, "A2"));
  coalescer.push(update("B", 4, "B2"));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    delivered.map((item) => [item.sessionId, item.globalSeq]),
    [["A", 3], ["B", 4]],
    "单个自动定时器必须提交每条流的最新快照",
  );
}

function testSameSessionRunAndTurnIsolation(): void {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event));
  coalescer.push(update("A", 1, "run-1 turn-1 old", "turn-1", "run-1"));
  coalescer.push(update("A", 2, "run-1 turn-2", "turn-2", "run-1"));
  coalescer.push(update("A", 3, "run-2 turn-1", "turn-1", "run-2"));
  coalescer.push(update("A", 4, "run-1 turn-1 latest", "turn-1", "run-1"));
  coalescer.flush();

  assert.deepEqual(
    delivered.map((item) => [item.runId, item.turnId, item.globalSeq]),
    [["run-1", "turn-2", 2], ["run-2", "turn-1", 3], ["run-1", "turn-1", 4]],
  );
}

function testManyInterleavedSessions(): void {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event));
  const sessions = ["A", "B", "C", "D", "E"];
  let seq = 0;
  for (const id of ["A", "B", "C", "D", "A", "C", "B", "D", "E", "D", "A", "C", "E", "B"]) {
    seq += 1;
    coalescer.push(update(id, seq, `${id}${seq}`));
  }
  coalescer.flush();

  assert.deepEqual(new Set(delivered.map((item) => item.sessionId)), new Set(sessions));
  assert.deepEqual(delivered.map((item) => item.globalSeq), [...delivered.map((item) => item.globalSeq)].sort((a, b) => a - b));
  for (const id of sessions) {
    const expected = Math.max(...Array.from({ length: seq }, (_, index) => index + 1).filter((value) => {
      const eventId = ["A", "B", "C", "D", "A", "C", "B", "D", "E", "D", "A", "C", "E", "B"][value - 1];
      return eventId === id;
    }));
    assert.equal(delivered.find((item) => item.sessionId === id)?.globalSeq, expected);
  }
}

async function testBarrierAndCancel(): Promise<void> {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event), 10);
  coalescer.push(update("A", 1, "A1"));
  coalescer.push(update("B", 2, "B1"));
  coalescer.push(barrier("A", 3));
  assert.deepEqual(delivered.map((item) => item.globalSeq), [1, 2, 3]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered.length, 3, "顺序屏障必须取消待执行的定时器");

  coalescer.push(update("A", 4, "discard A"));
  coalescer.push(update("B", 5, "discard B"));
  coalescer.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered.length, 3, "cancel 后不得发送任何 Session 的延迟事件");
}

resetMessageUpdateCoalescerDiagnosticsForTests();
await testStoreReplayCompression();
await testLargeCumulativeUpdateRetention();
testSameStreamCoalescing();
testInterleavedSessions();
await testAutomaticTimerFlush();
testSameSessionRunAndTurnIsolation();
testManyInterleavedSessions();
await testBarrierAndCancel();
const coalescerDiagnostics = getMessageUpdateCoalescerDiagnostics();
assert.ok(coalescerDiagnostics.messageUpdatesReceivedTotal > coalescerDiagnostics.messageUpdatesEmittedTotal);
assert.ok(coalescerDiagnostics.messageUpdatesCoalescedTotal > 0);
assert.ok(coalescerDiagnostics.timerFlushesTotal > 0);
assert.ok(coalescerDiagnostics.barrierFlushesTotal > 0);
assert.ok(coalescerDiagnostics.pendingStreamsPeak >= 2);
assert.equal(coalescerDiagnostics.pendingStreams, 0);
console.log("stream event performance tests passed");
