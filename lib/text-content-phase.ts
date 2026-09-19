import type { AssistantContentBlock, TextContent } from "./types";

export type TextContentPhase = "commentary" | "final_answer";

export function getTextContentPhase(block: TextContent): TextContentPhase | null {
  const signature = block.textSignature;
  if (!signature?.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
    if (parsed.v !== 1) return null;
    return parsed.phase === "commentary" || parsed.phase === "final_answer"
      ? parsed.phase
      : null;
  } catch {
    return null;
  }
}

export function hasExplicitFinalAnswerStarted(content: readonly AssistantContentBlock[]): boolean {
  const textBlocks = content.filter(
    (block): block is TextContent => block.type === "text" && Boolean(block.text.trim()),
  );
  return textBlocks.some((block) => getTextContentPhase(block) === "final_answer");
}
