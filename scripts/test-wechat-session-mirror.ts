import assert from "node:assert/strict";
import { EventStore } from "../lib/agent-runtime/event-store.ts";
import { WeChatSessionMirror } from "../lib/wechat-session-mirror.ts";
const store = new EventStore();
const sent: Array<[string, string]> = [];
const errors: unknown[] = [];
let typingStarted = 0;
let typingStopped = 0;
const bindings = new Map([["phone", "desktop"]]);
const gate: { promise?: Promise<void> } = {};
const mirror = new WeChatSessionMirror({
  beginTyping: () => { typingStarted++; return () => { typingStopped++; }; },
  recipients: (sessionId) => [...bindings].filter(([, id]) => id === sessionId).map(([user]) => user),
  send: async (user, text) => { if (gate.promise) await gate.promise; sent.push([user, text]); },
  onError: (error) => { errors.push(error); },
});
const unsub = store.subscribeAll(mirror.handle);
const emit = (event: Record<string, unknown> & { type: string }, turnId = "t1", sessionId = "desktop") => store.append({ sessionId, runId: sessionId, turnId, event });
const user = (text: string, id?: string) => ({ type: "message_end", message: { role: "user", content: text, ...(id ? { clientMessageId: id } : {}) } });
const assistant = (text: string) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });

emit(user("桌面提问", "client-1"));
emit(user("桌面提问", "client-1"));
emit(user("底层重复 user echo"));
emit(assistant("中间过程"));
emit({ type: "tool_execution_end", result: "不应推送" });
emit(assistant("最终回答"));
emit({ type: "agent_end" });
emit({ type: "agent_end" });
await mirror.drain();
assert.deepEqual(sent, [["phone", "【电脑端】\n桌面提问"], ["phone", "【AI 回复】\n最终回答"]]);

// 微信回合的原始事件没有 clientMessageId，也必须排除。
emit(user("微信提问", "wechat:inbound"), "t2");
emit(user("微信提问"), "t2");
emit(assistant("原链路回复"), "t2");
emit({ type: "agent_end" }, "t2");
emit(user("未绑定会话", "client-other"), "t3", "other");
emit(assistant("其他窗口回复"), "t3", "other");
emit({ type: "agent_end" }, "t3", "other");
await mirror.drain();
assert.equal(sent.length, 2);

// 重试不提前发送答案；运行时回收后重复的 turnId 不吞掉新 clientMessageId。
emit(user("下一问", "client-2"));
emit(assistant("重试前"));
emit({ type: "agent_end", willRetry: true });
await mirror.drain();
assert.equal(sent.at(-1)?.[1], "【电脑端】\n下一问");
emit(assistant("重试成功"));
emit({ type: "agent_end" });
await mirror.drain();
assert.equal(sent.at(-1)?.[1], "【AI 回复】\n重试成功");

// user 已发送后切换绑定，旧回合结束也不能泄漏到新绑定。
emit(user("切换前", "client-3"), "t4");
await mirror.drain();
const beforeSwitch = sent.length;
bindings.set("phone", "other");
emit(assistant("旧回合结果"), "t4");
emit({ type: "agent_end" }, "t4");
await mirror.drain();
assert.equal(sent.length, beforeSwitch);

bindings.set("phone", "desktop");
emit(user("报错测试", "client-4"), "t5");
emit({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "模型无权限" } }, "t5");
emit({ type: "agent_end" }, "t5");
await mirror.drain();
assert.equal(sent.at(-1)?.[1], "【AI 回复】\n请求失败：模型无权限");

// 发送延迟时，答案必须等待用户消息发完；停止后不继续发送排队项。
let release!: () => void;
gate.promise = new Promise<void>((resolve) => { release = resolve; });
emit(user("排队测试", "client-5"), "t6");
emit(assistant("排队答案"), "t6");
emit({ type: "agent_end" }, "t6");
await Promise.resolve();
const beforeStop = sent.length;
mirror.stop();
release();
await mirror.drain();
assert.equal(sent.length, beforeStop + 1, "in-flight user send completes, queued answer is cancelled");
assert.equal(errors.length, 0);
assert.equal(typingStarted, typingStopped, "all typing leases are released");
unsub();
console.log("微信双向同步测试通过：桌面输入与最终回答、顺序、重复事件、微信回环、窗口隔离、重试、模型错误、切换与停止。");
