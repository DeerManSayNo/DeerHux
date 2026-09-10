import assert from "node:assert/strict";
import { buildStreamingToolLayout, buildCompletedToolLayout, countRunningGroupTools } from "../lib/streaming-tool-layout.ts";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, TextContent } from "../lib/types.ts";

const tool = (id: number): AssistantContentBlock => ({ type: "toolCall", toolCallId: `t${id}`, toolName: "read", input: {} });
const text = (value: string): TextContent => ({ type: "text", text: value });
const assistant = (...content: AssistantContentBlock[]): AssistantMessage => ({ role: "assistant", content, model: "test", provider: "test" });
const user: AgentMessage = { role: "user", content: "test" };
const calls = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => tool(from + i));

// 上限按调用计数，跨 assistant 消息和流式尾部；结果内容不是正文分段。
const messages: AgentMessage[] = [user, assistant(...calls(1, 3)), {
  role: "toolResult", toolCallId: "t1", toolName: "read", content: [text("result")], isError: false,
}, assistant(tool(4))];
let layout = buildStreamingToolLayout(messages, assistant(tool(5)), true);
assert.equal(layout.byMessage.size, 0);
layout = buildStreamingToolLayout(messages, assistant(tool(5), tool(6)), true);
assert.deepEqual([...layout.byMessage.get(1)!.hiddenToolIds], ["t1"]);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 1);
assert.equal(layout.hiddenMessageIndexes.size, 0);

// 正文第一个有效字符立即收起所有旧调用；文本后的工具重新计数。
layout = buildStreamingToolLayout(messages, assistant(tool(5), text("开始说明"), tool(6)), true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 5);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.closedByText, true);
assert.equal(layout.hiddenMessageIndexes.has(3), true);
assert.equal(layout.byMessage.get(messages.length)!.hiddenToolIds.has("t6"), false);
assert.equal(layout.hiddenMessageIndexes.has(messages.length), false);

// 空白正文、思考、工具结果均不重置窗口。
layout = buildStreamingToolLayout([user, assistant(...calls(1, 5), text(" \n"), { type: "thinking", thinking: "思考" }, tool(6))], null, true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 1);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.closedByText, false);

// 同一消息中多个段落保留各自顺序与入口。
layout = buildStreamingToolLayout([user, assistant(tool(1), text("A"), ...calls(2, 8), text("B"), tool(9))], null, true);
assert.equal(layout.byMessage.get(1)!.groups.size, 2);
assert.equal(layout.byMessage.get(1)!.groups.get("t2")!.tools.length, 7);
assert.equal(layout.byMessage.get(1)!.hiddenToolIds.has("t9"), false);

// 持久化/流式重叠不重复计数；落盘前后分组 ID 稳定。
layout = buildStreamingToolLayout([user, assistant(...calls(1, 6))], assistant(tool(6)), true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 1);
assert.equal(layout.hiddenMessageIndexes.has(2), true);
const before = buildStreamingToolLayout([user], assistant(...calls(1, 6)), true);
const after = buildStreamingToolLayout([user, assistant(...calls(1, 6))], null, true);
assert.equal(before.byMessage.get(1)!.groups.get("t1")!.id, after.byMessage.get(1)!.groups.get("t1")!.id);

// 历史回合不参与新回合计数，结束、停止交回现有完成态逻辑。
layout = buildStreamingToolLayout([user, assistant(...calls(1, 9)), user, assistant(tool(10))], null, true);
assert.equal(layout.byMessage.size, 0);
layout = buildStreamingToolLayout(messages, assistant(...calls(5, 9)), false);
assert.equal(layout.byMessage.size, 0);
assert.equal(layout.hiddenMessageIndexes.size, 0);
// 工具结果未加载时不能推断执行中：只认真实运行事件里的 IDs。
const group = before.byMessage.get(1)!.groups.get("t1")!;
assert.equal(countRunningGroupTools(group), 0);
assert.equal(countRunningGroupTools(group, new Set()), 0);
assert.equal(countRunningGroupTools(group, new Set(["t2"])), 0);
assert.equal(countRunningGroupTools(group, new Set(["t1"])), 1);
const completedResults = new Map([["t1", {
  role: "toolResult" as const, toolCallId: "t1", toolName: "read", content: [text("done")], isError: false,
}]]);
assert.equal(countRunningGroupTools(group, new Set(["t1"]), completedResults), 0);
assert.equal(countRunningGroupTools(group, new Set(), completedResults), 0);
// 完成后的过程按正文分段，末尾不足五个工具也不能铺开。
const completedLayout = buildCompletedToolLayout([
  assistant(text("开始"), ...calls(1, 5)),
  assistant(text("继续"), ...calls(6, 7)),
]);
assert.equal(completedLayout.byMessage.get(0)!.groups.get("t1")!.tools.length, 5);
assert.equal(completedLayout.byMessage.get(1)!.groups.get("t6")!.tools.length, 2);
assert.equal(completedLayout.byMessage.get(1)!.hiddenToolIds.size, 2);
assert.equal(completedLayout.byMessage.get(1)!.groups.get("t6")!.closedByText, true);
assert.equal(buildCompletedToolLayout([assistant(text("只有正文"))]).byMessage.size, 0);
console.log("streaming tool layout tests passed");
