"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  isThemeChannelMessage,
  LEGACY_THEME_STORAGE_KEY,
  parseTheme,
  resolveStoredTheme,
  THEME_CHANNEL_NAME,
  THEME_STORAGE_KEY,
  THEME_TAURI_EVENT,
  type Theme,
  type ThemeChannelMessage,
} from "@/lib/theme";

type ThemeRuntime = {
  listeners: Set<() => void>;
  initialized: boolean;
  syncStarted: boolean;
  channel: BroadcastChannel | null;
  nativeDesiredTheme: Theme | null;
  nativeAppliedTheme: Theme | null;
  nativeSyncing: boolean;
  nativeRetryTimer: ReturnType<typeof setTimeout> | null;
  nativeRetryUsed: boolean;
};

const globalForTheme = globalThis as unknown as {
  __deerhuxThemeRuntime?: ThemeRuntime;
};

/**
 * Theme state must survive Fast Refresh together with its cross-window listeners.
 * `useTheme()` is also used by every rendered code block, so all instances in
 * one webview share a single listener store, sync channel and native update.
 */
function getThemeRuntime(): ThemeRuntime {
  if (!globalForTheme.__deerhuxThemeRuntime) {
    globalForTheme.__deerhuxThemeRuntime = {
      listeners: new Set(),
      initialized: false,
      syncStarted: false,
      channel: null,
      nativeDesiredTheme: null,
      nativeAppliedTheme: null,
      nativeSyncing: false,
      nativeRetryTimer: null,
      nativeRetryUsed: false,
    };
  }
  return globalForTheme.__deerhuxThemeRuntime;
}

function subscribe(cb: () => void): () => void {
  const listeners = getThemeRuntime().listeners;
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notifyListeners() {
  getThemeRuntime().listeners.forEach((cb) => cb());
}

function getSnapshot(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function applyTheme(theme: Theme) {
  const changed = getSnapshot() !== theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (changed) notifyListeners();
}

function readStoredTheme(): Theme | null {
  try {
    return resolveStoredTheme(
      localStorage.getItem(THEME_STORAGE_KEY),
      localStorage.getItem(LEGACY_THEME_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

function persistTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

function ensureThemeSyncChannels() {
  const runtime = getThemeRuntime();
  if (runtime.syncStarted) return;
  runtime.syncStarted = true;

  const applyExternalTheme = (nextTheme: Theme) => applyTheme(nextTheme);

  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== LEGACY_THEME_STORAGE_KEY) return;
    const nextTheme = readStoredTheme();
    if (nextTheme) applyExternalTheme(nextTheme);
  });

  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(THEME_CHANNEL_NAME);
    runtime.channel = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isThemeChannelMessage(event.data)) applyExternalTheme(event.data.theme);
    };
  }

  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<unknown>(THEME_TAURI_EVENT, (event) => {
      const nextTheme = parseTheme(event.payload);
      if (nextTheme) applyExternalTheme(nextTheme);
    }))
    .catch(() => {});
}

function broadcastTheme(theme: Theme) {
  getThemeRuntime().channel?.postMessage({ type: "theme", theme } satisfies ThemeChannelMessage);
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(THEME_TAURI_EVENT, theme))
    .catch(() => {});
}

function initializeTheme() {
  const runtime = getThemeRuntime();
  ensureThemeSyncChannels();
  if (runtime.initialized) return;
  runtime.initialized = true;

  const storedTheme = readStoredTheme();
  if (storedTheme) {
    applyTheme(storedTheme);
    persistTheme(storedTheme);
  }
}

function syncNativeTheme(theme: Theme) {
  const runtime = getThemeRuntime();
  runtime.nativeDesiredTheme = theme;
  if (runtime.nativeSyncing || runtime.nativeAppliedTheme === theme) return;

  runtime.nativeSyncing = true;
  let failed = false;
  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      // Serialize native changes: a stale asynchronous completion must be
      // followed by the newest desired value rather than winning the race.
      while (runtime.nativeDesiredTheme && runtime.nativeAppliedTheme !== runtime.nativeDesiredTheme) {
        const target = runtime.nativeDesiredTheme;
        await getCurrentWindow().setTheme(target);
        runtime.nativeAppliedTheme = target;
      }
      runtime.nativeRetryUsed = false;
    })
    .catch(() => {
      failed = true;
      // Browser mode has no native bridge. Retry once in case a Tauri bridge
      // initializes late, without retaining an infinite background timer.
      if (!runtime.nativeRetryUsed && runtime.nativeRetryTimer === null) {
        runtime.nativeRetryUsed = true;
        runtime.nativeRetryTimer = globalThis.setTimeout(() => {
          runtime.nativeRetryTimer = null;
          if (runtime.nativeDesiredTheme) {
            runtime.nativeAppliedTheme = null;
            syncNativeTheme(runtime.nativeDesiredTheme);
          }
        }, 1_000);
      }
    })
    .finally(() => {
      runtime.nativeSyncing = false;
      if (!failed && runtime.nativeDesiredTheme && runtime.nativeAppliedTheme !== runtime.nativeDesiredTheme) {
        syncNativeTheme(runtime.nativeDesiredTheme);
      }
    });
}

type ToggleOrigin = { x: number; y: number };

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    initializeTheme();
  }, []);

  useEffect(() => {
    // One native update per webview/theme value, even with many CodeBlock users.
    syncNativeTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    const next: Theme = getSnapshot() === "dark" ? "light" : "dark";

    const apply = () => {
      applyTheme(next);
      persistTheme(next);
      broadcastTheme(next);
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(apply);
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 450,
            easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  return { theme, toggleTheme, isDark: theme === "dark" };
}
