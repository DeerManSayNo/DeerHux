import assert from "node:assert/strict";
import { EventStore } from "../lib/agent-runtime/event-store.ts";
import { WeChatSessionMirror } from "../lib/wechat-session-mirror.ts";
const store = new EventStore();
const sent: string[] = [];
const errors: unknown[] = [];
let bound = true;
const mirror = new WeChatSessionMirror({
  recipients: (session) => bound && session === "session" ? ["phone"] : [],
  send: async (_user, text) => { sent.push(text); },
  sendProgress: async (_user, progress) => {
    sent.push(`${progress.toolCallId}:${progress.status ?? "start"}`);
    if (progress.toolCallId === "rejected") throw new Error("API rejected progress");
  },
  onError: (error) => { errors.push(error); },
});
store.subscribeAll(mirror.handle);
const emit = (event: { type: string; [key: string]: unknown }, turnId = "turn") => store.append({ sessionId: "session", runId: "session", turnId, event });
const user = (id: string) => ({ type: "message_end", message: { role: "user", content: "任务", clientMessageId: id } });
const start = (id: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash" });
emit(user("desktop"));
emit(start("rejected"));
emit({ type: "tool_execution_end", toolCallId: "rejected", toolName: "bash", isError: true });
emit(start("interrupted"));
emit({ type: "agent_end", willRetry: true });
await mirror.drain();
assert.ok(!sent.includes("interrupted:unknown"), "retry must not close active tools");
emit({ type: "agent_end" });
await mirror.drain();
assert.equal(errors.length, 2);
assert.ok(sent.includes("interrupted:unknown"), "unfinished tool must not remain running after turn ends");
assert.ok(sent.at(-1)?.startsWith("【AI 回复】"), "progress failures must not suppress the final reply");
const before = sent.length;
emit(start("late"));
await mirror.drain();
assert.equal(sent.length, before, "late events after completion are ignored");
// Switch bindings before queued progress executes.
emit(user("wechat:remote"), "remote");
emit(start("cancelled"), "remote");
bound = false;
await mirror.drainUser("phone");
assert.equal(sent.length, before);
bound = true;
emit({ type: "agent_end" }, "remote");
await mirror.drain();
const beforeStop = sent.length;
emit(user("wechat:stop"), "stop");
emit(start("stopped"), "stop");
mirror.stop();
await mirror.drain();
assert.equal(sent.length, beforeStop);
console.log("微信工具进度测试通过：发送失败隔离、重试、未完成工具收尾、迟到事件、切换绑定与停止。");
