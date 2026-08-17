import assert from "node:assert/strict";
import { EventStore } from "../lib/agent-runtime/event-store.ts";
import { MessageUpdateCoalescer } from "../lib/agent-runtime/event-coalescer.ts";

interface TestEvent {
  event: { type: string; message?: { content: string } };
  seq: number;
}

const update = (seq: number, content: string): TestEvent => ({
  seq,
  event: { type: "message_update", message: { content } },
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

async function testTransportCoalescingAndEndFlush(): Promise<void> {
  const delivered: TestEvent[] = [];
  const coalescer = new MessageUpdateCoalescer<TestEvent>((event) => delivered.push(event), 10);
  coalescer.push(update(1, "a"));
  coalescer.push(update(2, "ab"));
  coalescer.push(update(3, "abc"));
  coalescer.push({ seq: 4, event: { type: "message_end", message: { content: "abc" } } });

  assert.deepEqual(delivered.map((item) => item.seq), [3, 4]);
  assert.equal(delivered[0].event.message?.content, "abc");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered.length, 2, "message_end flush must cancel the pending timer");

  coalescer.push(update(5, "discard me"));
  coalescer.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(delivered.length, 2, "cancel must prevent post-unmount delivery");
}

await testStoreReplayCompression();
await testLargeCumulativeUpdateRetention();
await testTransportCoalescingAndEndFlush();
console.log("stream event performance tests passed");
