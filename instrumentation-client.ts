import { installShareDevClient } from "./lib/sharing/dev-client";
import {
  DEFAULT_THEME,
  LEGACY_THEME_STORAGE_KEY,
  resolveStoredTheme,
  THEME_STORAGE_KEY,
} from "./lib/theme";

// Next runs this entry before client bootstrap/hydration. No script elements
// are rendered through React, including during client navigation/Fast Refresh.
if (process.env.NODE_ENV === "development") installShareDevClient();

try {
  const theme = resolveStoredTheme(
    localStorage.getItem(THEME_STORAGE_KEY),
    localStorage.getItem(LEGACY_THEME_STORAGE_KEY),
  ) ?? DEFAULT_THEME;
  document.documentElement.classList.toggle("dark", theme === "dark");
} catch {
  document.documentElement.classList.toggle("dark", DEFAULT_THEME === "dark");
}
