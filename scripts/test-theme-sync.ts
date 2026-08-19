import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isThemeChannelMessage,
  parseTheme,
  resolveStoredTheme,
} from "../lib/theme.ts";

assert.equal(parseTheme("dark"), "dark");
assert.equal(parseTheme("light"), "light");
assert.equal(parseTheme("system"), null);
assert.equal(parseTheme(null), null);
assert.equal(resolveStoredTheme("dark", "light"), "dark");
assert.equal(resolveStoredTheme(null, "light"), "light");
assert.equal(resolveStoredTheme("invalid", "dark"), "dark");
assert.equal(resolveStoredTheme("invalid", "invalid"), null);
assert.equal(isThemeChannelMessage({ type: "theme", theme: "dark" }), true);
assert.equal(isThemeChannelMessage({ type: "theme", theme: "system" }), false);
assert.equal(isThemeChannelMessage({ type: "state", theme: "dark" }), false);

const previewWindow = readFileSync("components/FilePreviewWindow.tsx", "utf8");
const themeHook = readFileSync("hooks/useTheme.ts", "utf8");
assert.match(previewWindow, /useTheme\(\)/, "detached preview window must initialize the theme hook");
assert.match(themeHook, /new BroadcastChannel\(THEME_CHANNEL_NAME\)/, "theme hook must sync browser windows");
assert.match(themeHook, /listen<unknown>\(THEME_TAURI_EVENT/, "theme hook must sync Tauri windows");
assert.doesNotMatch(themeHook, /FILE_PREVIEW_(?:TAURI|CHANNEL)/, "theme sync must not reuse file preview events");

console.log("theme synchronization tests passed");
