import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appShell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const lazyPanels = [
  "ModelsConfig",
  "SkillsConfig",
  "SchedulerPanel",
  "RoleConfig",
  "MemoryConfig",
  "McpConfig",
  "ExtensionsConfig",
  "WeChatConfig",
] as const;

for (const panel of lazyPanels) {
  assert.doesNotMatch(
    appShell,
    new RegExp(`^import\\s*(?!\\()[^\\n]*["']\\./${panel}["'];?\\s*$`, "m"),
    `${panel} must not be a top-level static import`,
  );
  assert.match(
    appShell,
    new RegExp(
      `const\\s+${panel}\\s*=\\s*dynamic\\(\\(\\)\\s*=>\\s*import\\(["']\\./${panel}["']\\)\\.then\\(\\(module\\)\\s*=>\\s*module\\.${panel}\\),\\s*\\{\\s*loading:\\s*ConfigurationPanelLoading,?\\s*\\}\\)`,
    ),
    `${panel} must use a named dynamic import`,
  );
}

assert.doesNotMatch(
  appShell,
  /const\s+(?:ModelsConfig|SkillsConfig|SchedulerPanel|RoleConfig|MemoryConfig|McpConfig|ExtensionsConfig|WeChatConfig)\s*=\s*dynamic\([^;]*ssr\s*:\s*false/,
  "configuration panels must retain default SSR behavior",
);
assert.match(
  appShell,
  /function\s+ConfigurationPanelLoading\(\)/,
  "lazy configuration panels must render a themed loading fallback",
);
assert.match(
  appShell,
  /useEffect\(\(\)\s*=>\s*\{\s*const timer = window\.setTimeout\(preloadConfigurationPanels, 0\)/,
  "configuration panels must preload after the initial AppShell paint",
);
for (const panel of lazyPanels) {
  assert.match(
    appShell,
    new RegExp(`import\\(["']\\./${panel}["']\\)`),
    `${panel} must be included in background preloading`,
  );
}

console.log("AppShell lazy configuration panel tests passed");
