import assert from "node:assert/strict";
import { AgentEventBus } from "../lib/agent-event-bus.ts";

const bus = new AgentEventBus();
const changedFilesBySession = new Map([
  ["session-alpha", ["/alpha/changed.ts"]],
  ["session-beta", ["/beta/changed.ts"]],
]);
const completedSessions: string[] = [];

const unsubscribeAlpha = bus.subscribe("session-alpha", ({ event }) => {
  if (event.type === "agent_start") changedFilesBySession.set("session-alpha", []);
  if (event.type === "agent_end") completedSessions.push("session-alpha");
});
const unsubscribeBeta = bus.subscribe("session-beta", ({ event }) => {
  if (event.type === "agent_start") changedFilesBySession.set("session-beta", []);
  if (event.type === "agent_end") completedSessions.push("session-beta");
});

bus.emit({ sessionId: "session-alpha", event: { type: "agent_start" } });
assert.deepEqual(changedFilesBySession.get("session-alpha"), []);
assert.deepEqual(
  changedFilesBySession.get("session-beta"),
  ["/beta/changed.ts"],
  "不同 session 的 agent_start 不得清空其他窗口的文件状态",
);

bus.emit({ sessionId: "session-alpha", event: { type: "agent_end" } });
assert.deepEqual(completedSessions, ["session-alpha"]);
assert.ok(
  !completedSessions.includes("session-beta"),
  "不同 session 的监听器不应接收或执行 agent_end 音效副作用",
);

unsubscribeAlpha();
bus.emit({ sessionId: "session-alpha", event: { type: "agent_end" } });
assert.deepEqual(completedSessions, ["session-alpha"], "取消订阅后不得继续执行副作用");

unsubscribeBeta();
console.log("agent event bus tests passed");
