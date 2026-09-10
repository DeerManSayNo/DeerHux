import { getLocalStorageItem } from "./client-storage";

export interface ExplorerProjectState {
  expandedPaths: string[];
  activePath: string | null;
  scrollTop?: number;
}

const FILE_EXPLORER_STATE_STORAGE_KEY = "deerhux.file-explorer-state";
export const EMPTY_EXPLORER_PROJECT_STATE: ExplorerProjectState = { expandedPaths: [], activePath: null };

export function sanitizeExplorerProjectState(value: unknown): ExplorerProjectState {
  if (!value || typeof value !== "object") return EMPTY_EXPLORER_PROJECT_STATE;
  const state = value as Partial<ExplorerProjectState>;
  return {
    expandedPaths: Array.isArray(state.expandedPaths)
      ? [...new Set(state.expandedPaths.filter((path): path is string => typeof path === "string" && path.length > 0))]
      : [],
    ...(typeof state.scrollTop === "number" && Number.isFinite(state.scrollTop) ? { scrollTop: Math.max(0, state.scrollTop) } : {}),
    activePath: typeof state.activePath === "string" && state.activePath.length > 0 ? state.activePath : null,
  };
}

export function areExplorerProjectStatesEqual(a: ExplorerProjectState, b: ExplorerProjectState): boolean {
  if (a.activePath !== b.activePath || a.expandedPaths.length !== b.expandedPaths.length) return false;
  return a.expandedPaths.every((path, index) => path === b.expandedPaths[index]);
}

export function readFileExplorerState(cwd: string): ExplorerProjectState {
  if (typeof window === "undefined") return EMPTY_EXPLORER_PROJECT_STATE;
  try {
    const parsedValue = JSON.parse(getLocalStorageItem(FILE_EXPLORER_STATE_STORAGE_KEY) ?? "{}") as unknown;
    const parsed = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};
    return sanitizeExplorerProjectState(parsed[cwd]);
  } catch {
    return EMPTY_EXPLORER_PROJECT_STATE;
  }
}

export function writeFileExplorerState(cwd: string, state: ExplorerProjectState) {
  if (typeof window === "undefined") return;
  try {
    const parsedValue = JSON.parse(getLocalStorageItem(FILE_EXPLORER_STATE_STORAGE_KEY) ?? "{}") as unknown;
    const parsed = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};
    parsed[cwd] = { ...sanitizeExplorerProjectState(parsed[cwd]), ...state, updatedAt: Date.now() };
    window.localStorage.setItem(FILE_EXPLORER_STATE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore quota / private mode errors
  }
}

