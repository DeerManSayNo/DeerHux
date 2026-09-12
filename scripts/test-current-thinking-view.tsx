import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageView } from "../components/MessageView";
import type { AssistantMessage } from "../lib/types";

const thinking = { type: "thinking" as const, thinking: "当前思考内容" };
const message: AssistantMessage = { role: "assistant", model: "test", provider: "test", content: [thinking] };
const render = (value: AssistantMessage, streaming = false) => renderToStaticMarkup(<MessageView message={value} isStreaming={streaming} />);
assert.equal(render(message), "", "历史纯思考不留下消息占位");
assert.match(render(message, true), /当前思考内容/, "当前流式思考可见");
const multiple = { ...message, content: [{ ...thinking, thinking: "较早的思考内容" }, thinking] };
assert.doesNotMatch(render(multiple, true), /较早的思考内容/);
assert.match(render(multiple, true), /当前思考内容/);
const answer = { ...message, content: [thinking, { type: "text" as const, text: "正常回答内容" }] };
for (const streaming of [false, true]) {
  assert.doesNotMatch(render(answer, streaming), /当前思考内容|思考过程/);
  assert.match(render(answer, streaming), /正常回答内容/);
}
const tool = { ...message, content: [thinking, { type: "toolCall" as const, toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } }] };
assert.doesNotMatch(render(tool, true), /当前思考内容|思考过程/);
assert.match(render({ ...message, stopReason: "error", errorMessage: "真实错误" }), /真实错误/);
assert.equal(message.content[0], thinking, "仅改变展示，不改写会话数据");
console.log("current thinking rendering tests passed");
