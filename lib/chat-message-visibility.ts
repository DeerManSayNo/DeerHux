import type { AgentMessage, AssistantMessage } from "./types";

export const MODEL_REQUEST_TIMEOUT_MESSAGE = "模型请求超时，请稍后重试。";

function isModelRequestTimeout(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant"
    && message.errorMessage === MODEL_REQUEST_TIMEOUT_MESSAGE;
}

function hasVisibleAssistantOutput(message: Partial<AgentMessage> | null | undefined): boolean {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
  const errorMessage = message.errorMessage;
  return message.content.some((block) => {
    if (block.type === "text") {
      const text = block.text?.trim();
      return Boolean(text && text !== errorMessage);
    }
    return block.type === "image" || block.type === "toolCall";
  });
}

/**
 * Hide retry timeout messages after the same user turn has visibly resumed.
 * A timeout remains visible when it is the final outcome of the turn.
 */
export function findSupersededTimeoutMessageIndexes(
  messages: readonly AgentMessage[],
  streamingMessage?: Partial<AgentMessage> | null,
): ReadonlySet<number> {
  const hidden = new Set<number>();
  let hasLaterOutput = hasVisibleAssistantOutput(streamingMessage);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      hasLaterOutput = false;
      continue;
    }
    if (message.role !== "assistant") continue;

    if (hasLaterOutput && isModelRequestTimeout(message)) hidden.add(index);
    if (hasVisibleAssistantOutput(message)) hasLaterOutput = true;
  }

  return hidden;
}
