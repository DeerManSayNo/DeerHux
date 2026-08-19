export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "deerhux-theme";
export const LEGACY_THEME_STORAGE_KEY = "pi-theme";
export const THEME_CHANNEL_NAME = "deerhux://theme";
export const THEME_TAURI_EVENT = "deerhux://theme/change";

export type ThemeChannelMessage = {
  type: "theme";
  theme: Theme;
};

export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveStoredTheme(currentValue: unknown, legacyValue: unknown): Theme | null {
  return parseTheme(currentValue) ?? parseTheme(legacyValue);
}

export function isThemeChannelMessage(value: unknown): value is ThemeChannelMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ThemeChannelMessage>;
  return message.type === "theme" && parseTheme(message.theme) !== null;
}
