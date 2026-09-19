export const SELECTION_ASSISTANT_WINDOW_LABEL = "selection-assistant";
export const SELECTION_ASSISTANT_STORAGE_PREFIX = "deerhux.selection-assistant.";
export const SELECTION_ASSISTANT_READY_EVENT = "deerhux://selection-assistant-ready";
export const SELECTION_ASSISTANT_REQUEST_EVENT = "deerhux://selection-assistant-request";

export type SelectionAssistantMode = "explain" | "ask";

export interface SelectionAssistantRequest {
  sessionId: string;
  mode: SelectionAssistantMode;
  text: string;
  question: string;
}

export function selectionAssistantStorageKey(id: string): string {
  return `${SELECTION_ASSISTANT_STORAGE_PREFIX}${id}`;
}
