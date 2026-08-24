import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyModePrompt,
  getAgentModeConfig,
  stripModePrompt,
} from "../lib/agent-modes.ts";

const sharedGuideline = "回答和思考过程（thinking）全部使用中文";
for (const mode of ["ask", "plan", "agent"] as const) {
  const block = getAgentModeConfig(mode).promptBlock;
  assert.match(block, new RegExp(`Mode: ${mode[0].toUpperCase()}${mode.slice(1)}`));
  assert.equal(block.includes(sharedGuideline), false, `${mode} mode must not repeat shared guidelines`);
}

assert.match(getAgentModeConfig("ask").promptBlock, /Do not modify files/);
assert.match(getAgentModeConfig("plan").promptBlock, /produce an implementation plan/);
assert.match(getAgentModeConfig("agent").promptBlock, /Complete the user's task using the available tools/);

const switched = applyModePrompt(applyModePrompt("base", "ask"), "agent");
assert.equal(switched.match(/<deerhux_mode>/g)?.length, 1);
assert.match(switched, /Mode: Agent/);
assert.doesNotMatch(switched, /Mode: Ask/);
assert.equal(stripModePrompt(switched), "base");

const rpc = readFileSync("lib/rpc-manager.ts", "utf8");
assert.doesNotMatch(rpc, /Current turn mode:/, "turn context must not repeat the session mode block");
assert.match(rpc, /ctx\.references\.length === 0 && !ctx\.skill/);

console.log("agent mode prompt tests passed");
