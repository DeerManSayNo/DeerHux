"use client";

import { useCallback, useEffect, useState } from "react";
import { appNotificationNames, notifyApp, subscribeToAppNotification } from "@/lib/app-notifications";
import { getLocalStorageItem } from "@/lib/client-storage";

const STORAGE_KEY = "deerhux.tool-terminal-enabled";

function readPreference(): boolean {
  return getLocalStorageItem(STORAGE_KEY) !== "false";
}

export function useToolTerminalPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    const refresh = () => setEnabledState(readPreference());
    const unsubscribe = subscribeToAppNotification(
      appNotificationNames.toolTerminalPreferenceUpdated,
      refresh,
    );
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };

    refresh();
    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Keep the current window responsive when storage is unavailable.
    }
    setEnabledState(next);
    notifyApp(appNotificationNames.toolTerminalPreferenceUpdated);
  }, []);

  return [enabled, setEnabled];
}
