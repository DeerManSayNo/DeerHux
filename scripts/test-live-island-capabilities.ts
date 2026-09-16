import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readCapability(name: string): {
  windows: string[];
  permissions: string[];
  remote?: { urls?: string[] };
} {
  return JSON.parse(readFileSync(resolve(root, "src-tauri/capabilities", name), "utf8"));
}

const main = readCapability("default.json");
for (const permission of [
  "allow-get-live-island-setting-command",
  "allow-set-live-island-setting",
  "allow-get-live-island-scale-command",
  "allow-set-live-island-scale",
]) {
  assert.ok(main.permissions.includes(permission), `main window lacks ${permission}`);
}

const island = readCapability("live-island-commands.json");
assert.deepEqual(island.windows, ["live-island"]);
for (const permission of [
  "core:default",
  "allow-live-island-push-events",
  "allow-mark-live-island-ready",
  "allow-set-live-island-drawer-height",
  "allow-dismiss-live-island-row",
  "allow-focus-live-island-row",
]) {
  assert.ok(island.permissions.includes(permission), `live-island window lacks ${permission}`);
}
assert.ok(
  island.remote?.urls?.some((url) => url === "http://localhost:30141"),
  "live-island dev origin is not allowed",
);
assert.ok(
  island.remote?.urls?.some((url) => url === "http://127.0.0.1:*"),
  "live-island packaged loopback origin is not allowed",
);

console.log("灵动岛 Tauri capability tests passed");
