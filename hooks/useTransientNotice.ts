import { useEffect, useState } from "react";

const DEFAULT_TRANSIENT_NOTICE_DURATION_MS = 5_000;

/**
 * Show a keyed operational notice for a limited time without mutating the
 * underlying retry/error state. A new key starts a fresh visibility window.
 */
export function useTransientNotice(
  key: string | null,
  durationMs = DEFAULT_TRANSIENT_NOTICE_DURATION_MS,
): boolean {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!key) {
      setDismissedKey(null);
      return;
    }

    const timer = window.setTimeout(() => {
      setDismissedKey(key);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, key]);

  return Boolean(key && dismissedKey !== key);
}
