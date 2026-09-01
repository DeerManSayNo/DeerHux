const STORAGE_KEY = "deerhux.quick-session.dismissed-session-ids";
const CHANNEL_NAME = "deerhux.quick-session.visibility";

function normalizeSessionIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0));
}

export function readDismissedQuickSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return normalizeSessionIds(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function publishDismissedSessionIds(sessionIds: Set<string>): void {
  if (typeof window === "undefined") return;
  const snapshot = [...sessionIds];
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Broadcast still keeps currently open windows synchronized.
  }
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(snapshot);
  channel.close();
}

export function dismissQuickSession(sessionId: string): void {
  const sessionIds = readDismissedQuickSessionIds();
  sessionIds.add(sessionId);
  publishDismissedSessionIds(sessionIds);
}

export function restoreQuickSessionVisibility(sessionId: string): void {
  const sessionIds = readDismissedQuickSessionIds();
  if (!sessionIds.delete(sessionId)) return;
  publishDismissedSessionIds(sessionIds);
}

export function subscribeDismissedQuickSessions(listener: (sessionIds: Set<string>) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      listener(normalizeSessionIds(JSON.parse(event.newValue ?? "[]")));
    } catch {
      listener(new Set());
    }
  };
  window.addEventListener("storage", handleStorage);

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => listener(normalizeSessionIds(event.data));
  }

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}
