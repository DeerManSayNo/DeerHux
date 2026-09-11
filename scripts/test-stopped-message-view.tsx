import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageView } from "../components/MessageView";
import type { AssistantMessage } from "../lib/types";

const stopped: AssistantMessage = {
  role: "assistant", model: "test-model", provider: "test", stopReason: "aborted", content: [],
};
assert.equal(renderToStaticMarkup(<MessageView message={stopped} showTimestamp showTurnDuration />), "");
assert.equal(renderToStaticMarkup(<MessageView message={{ ...stopped, content: [{ type: "text", text: "  " }] }} />), "");
assert.match(renderToStaticMarkup(<MessageView message={{ ...stopped, content: [{ type: "text", text: "保留已经输出的内容" }] }} />), /保留已经输出的内容/);
assert.match(renderToStaticMarkup(<MessageView message={{ ...stopped, stopReason: "error", errorMessage: "真实调用失败" }} />), /真实调用失败/);
assert.match(renderToStaticMarkup(<MessageView message={{ ...stopped, errorMessage: "意外中断" }} />), /意外中断/);
console.log("stopped message rendering tests passed");
