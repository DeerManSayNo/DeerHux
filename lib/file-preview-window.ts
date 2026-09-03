export const FILE_PREVIEW_WINDOW_LABEL = "file-preview";
export const FILE_PREVIEW_CHANNEL_NAME = "deerhux.file-preview";
export const FILE_PREVIEW_TAURI_STATE_EVENT = "deerhux://file-preview/state";
export const FILE_PREVIEW_TAURI_COMMAND_EVENT = "deerhux://file-preview/command";
export const FILE_PREVIEW_STATE_STORAGE_KEY = "deerhux.file-preview-state";

export interface FilePreviewTab {
  id: string;
  label: string;
  filePath: string;
  kind?: "file" | "web";
}

export interface FilePreviewState {
  tabs: FilePreviewTab[];
  activeTabId: string | null;
  cwd?: string | null;
  viewerCwd?: string | null;
}

export type FilePreviewChannelMessage =
  | { type: "ready" }
  | { type: "state"; state: FilePreviewState }
  | { type: "select"; tabId: string }
  | { type: "open"; filePath: string; fileName: string }
  | { type: "close"; tabId: string }
  | { type: "closeMany"; tabIds: string[] }
  | { type: "closed" };

export function sanitizeFilePreviewState(value: unknown): FilePreviewState {
  if (!value || typeof value !== "object") {
    return { tabs: [], activeTabId: null, cwd: null, viewerCwd: null };
  }

  const state = value as Partial<FilePreviewState>;
  const tabs = Array.isArray(state.tabs)
    ? state.tabs.filter((tab): tab is FilePreviewTab => (
      Boolean(tab) &&
      typeof tab.id === "string" &&
      typeof tab.label === "string" &&
      typeof tab.filePath === "string" &&
      (tab.kind === undefined || tab.kind === "file" || tab.kind === "web")
    ))
    : [];
  const activeTabId = typeof state.activeTabId === "string" && tabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : tabs[0]?.id ?? null;

  return {
    tabs,
    activeTabId,
    cwd: typeof state.cwd === "string" ? state.cwd : null,
    viewerCwd: typeof state.viewerCwd === "string" ? state.viewerCwd : null,
  };
}
