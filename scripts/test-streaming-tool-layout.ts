import assert from "node:assert/strict";
import { buildStreamingToolLayout, buildCompletedToolLayout, countRunningGroupTools, summarizeToolActivities, currentToolActivity } from "../lib/streaming-tool-layout.ts";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, TextContent, ToolCallContent } from "../lib/types.ts";

const tool = (id: number, toolName = "read"): ToolCallContent => ({ type: "toolCall", toolCallId: `t${id}`, toolName, input: {} });
const text = (value: string): TextContent => ({ type: "text", text: value });
const assistant = (...content: AssistantContentBlock[]): AssistantMessage => ({ role: "assistant", content, model: "test", provider: "test" });
const user: AgentMessage = { role: "user", content: "test" };
const calls = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => tool(from + i));

// One stable row spans persisted messages, results, and the streaming tail.
const messages: AgentMessage[] = [user, assistant(...calls(1, 3)), {
  role: "toolResult", toolCallId: "t1", toolName: "read", content: [text("result")], isError: false,
}, assistant(tool(4))];
let layout = buildStreamingToolLayout(messages, assistant(tool(5), tool(6)), true);
const group = layout.byMessage.get(1)!.groups.get("t1")!;
assert.equal(group.tools.length, 6);
assert.equal(group.closedByText, false);
assert.deepEqual([...layout.byMessage.get(1)!.hiddenToolIds], ["t1", "t2", "t3"]);
assert.equal(layout.hiddenMessageIndexes.has(3), true);
assert.equal(layout.hiddenMessageIndexes.has(messages.length), true);

// Text closes the previous segment; the new tool segment has its own row.
layout = buildStreamingToolLayout(messages, assistant(tool(5), text("开始说明"), tool(6)), true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 5);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.closedByText, true);
assert.equal(layout.byMessage.get(messages.length)!.groups.get("t6")!.tools.length, 1);
assert.equal(layout.hiddenMessageIndexes.has(messages.length), false);

// Whitespace/thinking/results don't split tool activity. Historical thinking is hidden.
layout = buildStreamingToolLayout([user, assistant(...calls(1, 5)), assistant({ type: "thinking", thinking: "历史思考" }, tool(6))], null, true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 6);
assert.equal(layout.hiddenMessageIndexes.has(2), true);
layout = buildStreamingToolLayout([user, assistant(tool(1))], assistant(tool(2), { type: "thinking", thinking: "当前思考" }), true);
assert.equal(layout.hiddenMessageIndexes.has(2), false);

// Several segments in one message retain source ordering.
layout = buildStreamingToolLayout([user, assistant(tool(1), text("A"), ...calls(2, 8), text("B"), tool(9))], null, true);
assert.deepEqual([...layout.byMessage.get(1)!.groups.keys()], ["t1", "t2", "t9"]);
assert.equal(layout.byMessage.get(1)!.groups.get("t2")!.tools.length, 7);

// Stream/persist overlap never duplicates a tool; the first call remains the group ID.
layout = buildStreamingToolLayout([user, assistant(...calls(1, 6))], assistant(tool(6)), true);
assert.equal(layout.byMessage.get(1)!.groups.get("t1")!.tools.length, 6);
assert.equal(layout.hiddenMessageIndexes.has(2), true);
const before = buildStreamingToolLayout([user], assistant(...calls(1, 6)), true);
const after = buildStreamingToolLayout([user, assistant(...calls(1, 6))], null, true);
assert.equal(before.byMessage.get(1)!.groups.get("t1")!.id, after.byMessage.get(1)!.groups.get("t1")!.id);

// Earlier turns never join the current row.
layout = buildStreamingToolLayout([user, assistant(...calls(1, 9)), user, assistant(tool(10))], null, true);
assert.equal(layout.byMessage.size, 1);
assert.equal(layout.byMessage.get(3)!.groups.get("t10")!.tools.length, 1);
assert.equal(buildStreamingToolLayout(messages, null, false).byMessage.size, 0);
assert.equal(countRunningGroupTools(group), 0);
assert.equal(countRunningGroupTools(group, new Set(["t1", "t2"])), 2);
const results = new Map([["t1", { role: "toolResult" as const, toolCallId: "t1", toolName: "read", content: [text("done")], isError: false }]]);
assert.equal(countRunningGroupTools(group, new Set(["t1", "t2"]), results), 1);

// Completed/aborted tails also remain collapsed, even for a single call.
const completed = buildCompletedToolLayout([assistant(tool(1), text("继续"), tool(2))]);
assert.equal(completed.byMessage.get(0)!.groups.size, 2);
assert.equal(completed.byMessage.get(0)!.groups.get("t2")!.closedByText, true);
assert.equal(buildCompletedToolLayout([assistant(text("只有正文"))]).byMessage.size, 0);
assert.equal(summarizeToolActivities([tool(1, "bash")]), "运行了命令");
assert.equal(summarizeToolActivities([tool(1, "bash"), tool(2), tool(3)]), "已读取文件并运行了命令");
assert.equal(summarizeToolActivities([tool(1)]), "已读取文件");
assert.equal(summarizeToolActivities([tool(1, "grep"), tool(2, "code_search")]), "已搜索内容");
assert.equal(summarizeToolActivities([tool(1, "custom_read_database")]), "已调用其他工具");
assert.equal(summarizeToolActivities([tool(1, "edit"), tool(2, "write")]), "已修改文件并写入文件");
assert.equal(currentToolActivity(tool(1, "bash")), "运行命令");
console.log("streaming tool layout and activity summary tests passed");

// Open activity lives at the bottom; completed segments remain beside their messages.
const { moveCurrentToolGroupToBottom } = await import("../lib/streaming-tool-layout.ts");
const mixed = buildStreamingToolLayout([user, assistant(tool(1), text("说明"), tool(2))], null, true);
const placed = moveCurrentToolGroupToBottom(mixed);
assert.equal(placed.bottomGroup?.id, "t2");
assert.equal(placed.byMessage.get(1)!.groups.has("t2"), false);
assert.equal(placed.byMessage.get(1)!.groups.has("t1"), true);
assert.equal(placed.byMessage.get(1)!.hiddenToolIds.has("t2"), true);
assert.equal(placed.hiddenMessageIndexes.has(1), false, "保留原消息的正文及用量");
assert.equal(mixed.byMessage.get(1)!.groups.has("t2"), true, "不修改原布局");
assert.equal(moveCurrentToolGroupToBottom(buildStreamingToolLayout([user], null, false)).bottomGroup, undefined);
const persisted = moveCurrentToolGroupToBottom(after);
assert.equal(persisted.bottomGroup?.id, moveCurrentToolGroupToBottom(before).bottomGroup?.id);
assert.equal(moveCurrentToolGroupToBottom(buildStreamingToolLayout([user, assistant(tool(1), text("完成"))], null, true)).bottomGroup, undefined);
console.log("bottom tool activity placement tests passed");
