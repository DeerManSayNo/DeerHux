export type AssistantSnapshot = {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

export function resolveWorkerOutcome(
  lastAssistant: AssistantSnapshot | null,
  event: { willRetry?: unknown; error?: unknown },
): { kind: "pending" } | { kind: "resolve"; text: string } | { kind: "reject"; error: string } {
  if (event.willRetry === true) return { kind: "pending" };
  if (event.error) return { kind: "reject", error: String(event.error) };
  if (lastAssistant?.errorMessage) return { kind: "reject", error: lastAssistant.errorMessage };
  if (lastAssistant?.stopReason === "error") return { kind: "reject", error: "Model response failed" };
  if (lastAssistant?.stopReason === "aborted") return { kind: "reject", error: "Worker was aborted" };
  const text = assistantText(lastAssistant);
  return text.trim()
    ? { kind: "resolve", text }
    : { kind: "reject", error: "Worker produced no output (likely a model timeout or upstream error)" };
}

function assistantText(message: AssistantSnapshot | null): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    const record = block as { type?: string; text?: string; thinking?: string };
    if (record.type === "text") return record.text ?? "";
    return "";
  }).join("");
}
