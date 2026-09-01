export interface VisibleProjectOption {
  cwd: string;
  displayName: string;
}

const STORAGE_KEY = "deerhux.sidebar-visible-projects";
const CHANNEL_NAME = "deerhux.sidebar-visible-projects";

function normalizeProjects(value: unknown): VisibleProjectOption[] | null {
  if (!Array.isArray(value)) return null;
  const projects: VisibleProjectOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<VisibleProjectOption>;
    if (typeof candidate.cwd !== "string" || typeof candidate.displayName !== "string") return null;
    projects.push({ cwd: candidate.cwd, displayName: candidate.displayName });
  }
  return projects;
}

export function readVisibleProjects(): VisibleProjectOption[] | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeProjects(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function publishVisibleProjects(projects: VisibleProjectOption[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Broadcast still keeps an already-open quick window in sync.
  }
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(projects);
  channel.close();
}

export function subscribeVisibleProjects(listener: (projects: VisibleProjectOption[]) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      const projects = normalizeProjects(JSON.parse(event.newValue ?? "null"));
      if (projects) listener(projects);
    } catch {
      // Ignore malformed snapshots.
    }
  };
  window.addEventListener("storage", handleStorage);

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const projects = normalizeProjects(event.data);
      if (projects) listener(projects);
    };
  }

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}
