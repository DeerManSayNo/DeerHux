import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_THEME,
  isThemeChannelMessage,
  parseTheme,
  resolveStoredTheme,
} from "../lib/theme.ts";

assert.equal(DEFAULT_THEME, "dark");
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
const themeBootstrap = readFileSync("instrumentation-client.ts", "utf8");
const themeHook = readFileSync("hooks/useTheme.ts", "utf8");
const rootLayout = readFileSync("app/layout.tsx", "utf8");
const startupPage = readFileSync("src-tauri/placeholder-dist/index.html", "utf8");
const nativeHost = readFileSync("src-tauri/src/lib.rs", "utf8");
const capabilities = readFileSync("src-tauri/capabilities/default.json", "utf8");
assert.match(previewWindow, /useTheme\(\)/, "detached preview window must initialize the theme hook");
assert.match(themeBootstrap, /\?\? DEFAULT_THEME/, "theme bootstrap must use the default without a stored preference");
assert.match(themeHook, /new BroadcastChannel\(THEME_CHANNEL_NAME\)/, "theme hook must sync browser windows");
assert.match(themeHook, /listen<unknown>\(THEME_TAURI_EVENT/, "theme hook must sync Tauri windows");
assert.doesNotMatch(themeHook, /FILE_PREVIEW_(?:TAURI|CHANNEL)/, "theme sync must not reuse file preview events");
assert.match(themeHook, /invoke\("set_startup_theme", \{ theme \}\)/, "theme changes must persist for native startup");
assert.match(rootLayout, /className=\{`\$\{notoSansMono\.variable\} dark`\}/, "the first app frame must default to dark");
assert.match(rootLayout, /localStorage\.getItem\("deerhux-theme"\)/, "the saved web theme must be applied before first paint");
assert.match(rootLayout, /window\.__DEERHUX_STARTUP_THEME === "light"/, "the web page must fall back to the native startup theme");
assert.match(startupPage, /window\.__DEERHUX_STARTUP_THEME === 'light'/, "startup page must read the native preference");
assert.match(startupPage, /:root \{[\s\S]*color-scheme: dark/, "startup page must default to dark");
assert.doesNotMatch(startupPage, /prefers-color-scheme: dark/, "startup theme must not follow an unrelated OS preference");
assert.match(nativeHost, /load_startup_theme\(app\.handle\(\)\)/, "native window must load the saved startup theme");
assert.match(nativeHost, /\.background_color\(startup_theme\.background\(\)\)/, "native window background must match the startup theme");
assert.match(capabilities, /allow-set-startup-theme/, "loopback UI must be allowed to save the startup theme");

console.log("theme synchronization tests passed");
