import assert from "node:assert/strict";
import {
  findSupersededTimeoutMessageIndexes,
  MODEL_REQUEST_TIMEOUT_MESSAGE,
} from "../lib/chat-message-visibility.ts";
import type { AgentMessage, AssistantMessage } from "../lib/types.ts";

function assistant(text: string, errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "test",
    model: "test",
    ...(errorMessage ? { errorMessage, stopReason: "error" } : { stopReason: "stop" }),
  };
}

const user: AgentMessage = { role: "user", content: "hello" };
const timeout = assistant(MODEL_REQUEST_TIMEOUT_MESSAGE, MODEL_REQUEST_TIMEOUT_MESSAGE);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([user, timeout])],
  [],
  "a terminal timeout must remain visible",
);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([user, timeout], assistant("正在继续输出"))],
  [1],
  "live output should hide an earlier timeout in the same turn",
);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([user, timeout, assistant("最终回复")])],
  [1],
  "completed output should hide an earlier timeout in the same turn",
);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([user, timeout, timeout, assistant("最终回复")])],
  [2, 1],
  "completed output should hide every earlier retry timeout in the same turn",
);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([user, timeout, { role: "user", content: "new turn" }, assistant("new reply")])],
  [],
  "output from a later user turn must not hide an earlier terminal timeout",
);

assert.deepEqual(
  [...findSupersededTimeoutMessageIndexes([
    user,
    assistant("网络中断", "模型连接中断，请稍后重试或切换模型。"),
    assistant("恢复输出"),
  ])],
  [],
  "other error messages must not be hidden",
);

console.log("chat message visibility tests passed");
