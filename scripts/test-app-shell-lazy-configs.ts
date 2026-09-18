import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appShell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const panelHost = readFileSync(new URL("../components/ConfigurationPanelHost.tsx", import.meta.url), "utf8");
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
    panelHost,
    new RegExp(
      `const\\s+${panel}\\s*=\\s*dynamic\\(\\(\\)\\s*=>\\s*import\\(["']\\./${panel}["']\\)\\.then\\(\\(module\\)\\s*=>\\s*module\\.${panel}\\),\\s*\\{\\s*loading:\\s*\\(\\)\\s*=>\\s*null,?\\s*\\}\\)`,
    ),
    `${panel} must use a named dynamic import`,
  );
}

assert.doesNotMatch(
  panelHost,
  /const\s+(?:ModelsConfig|SkillsConfig|SchedulerPanel|RoleConfig|MemoryConfig|McpConfig|ExtensionsConfig|WeChatConfig)\s*=\s*dynamic\([^;]*ssr\s*:\s*false/,
  "configuration panels must retain default SSR behavior",
);
assert.doesNotMatch(
  panelHost,
  /正在打开|ConfigurationPanelLoading/,
  "lazy configuration panels must not render a centered loading fallback",
);
assert.match(
  panelHost,
  /useEffect\(\(\)\s*=>\s*\{\s*const timer = window\.setTimeout\(preloadConfigurationPanels, 0\)/,
  "configuration panels must preload after the initial AppShell paint",
);
for (const panel of lazyPanels) {
  assert.match(
    panelHost,
    new RegExp(`import\\(["']\\./${panel}["']\\)`),
    `${panel} must be included in background preloading`,
  );
}

assert.match(
  appShell,
  /<ConfigurationPanelHost[\s\S]*ref=\{configurationPanelHostRef\}/,
  "AppShell must delegate configuration state to the isolated panel host",
);
assert.match(
  panelHost,
  /import\("\.\/ModelsConfig"\)\.then\(\(module\)\s*=>\s*module\.preloadModelsConfigData\(\)\)/,
  "model configuration data must preload with its client chunk",
);

console.log("AppShell lazy configuration panel tests passed");
