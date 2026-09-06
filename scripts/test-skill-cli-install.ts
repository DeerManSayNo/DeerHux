import assert from "node:assert/strict";
import { createCliInstaller } from "../lib/skill-cli-install.ts";
import { cliInstallCommand } from "../lib/skill-cli-installers.ts";
import { POST } from "../app/api/skills/cli/install/route.ts";

assert.equal(cliInstallCommand("webcmd"), "npm install -g @agentrhq/webcmd");
assert.equal(cliInstallCommand("tvly", "win32"), undefined);
assert.equal(cliInstallCommand("webcmd; echo bad"), undefined);
let installed = false;
let executions = 0;
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const install = createCliInstaller(async () => {
  executions++;
  await gate;
  installed = true;
  return "installed";
}, async () => installed);
const first = install("webcmd");
const second = install("webcmd");
assert.equal(first, second, "concurrent requests share the same installation");
release();
assert.deepEqual(await first, { available: true, output: "installed" });
assert.equal(executions, 1);
await install("webcmd");
assert.equal(executions, 1, "already-installed CLI is not reinstalled");
await assert.rejects(install("unknown"), /不支持/);
let attempts = 0;
const retry = createCliInstaller(async () => {
  if (++attempts === 1) throw new Error("network failure");
  return "finished";
}, async () => false);
await assert.rejects(retry("webcmd"), /network failure/);
assert.deepEqual(await retry("webcmd"), { available: false, output: "finished" });
assert.equal(attempts, 2, "failed installs can be retried");
const forbidden = await POST(new Request("http://localhost:30141/api/skills/cli/install", {
  method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ command: "webcmd" }),
}));
assert.equal(forbidden.status, 403);
const invalid = await POST(new Request("http://localhost:30141/api/skills/cli/install", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "npm install arbitrary" }),
}));
assert.equal(invalid.status, 400);
console.log("CLI install concurrency, retry, detection and request validation passed (no real installation)");
