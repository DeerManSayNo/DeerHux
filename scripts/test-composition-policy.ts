import assert from "node:assert/strict";
import {
  computeActiveToolNames,
  selectModelRef,
  shouldLoadMcpRuntime,
} from "../lib/engine/composition-policy.ts";

const explicit = { provider: "explicit", modelId: "m" };
const restored = { provider: "restored", modelId: "m" };
const configuredDefault = { provider: "default", modelId: "m" };
assert.equal(selectModelRef({ explicit, restored, environment: "env/m", configuredDefault }), explicit);
assert.equal(selectModelRef({ restored, environment: "env/m", configuredDefault }), restored);
assert.deepEqual(selectModelRef({ environment: "env/m", configuredDefault }), { provider: "env", modelId: "m" });
assert.equal(selectModelRef({ configuredDefault }), configuredDefault);
assert.equal(selectModelRef({ environment: "invalid", configuredDefault }), configuredDefault);

assert.equal(shouldLoadMcpRuntime(["read", "bash", "edit", "write", "grep", "find", "ls"], false), true);
assert.equal(shouldLoadMcpRuntime(["mcp__server__tool"], true), true);
assert.equal(shouldLoadMcpRuntime(["read"], false), false);

const available = ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp__x"];
assert.deepEqual(computeActiveToolNames({
  requestedToolNames: [],
  availableToolNames: available,
  hasExplicitSelection: false,
  hasExplicitMode: false,
}), available);
assert.deepEqual(computeActiveToolNames({
  requestedToolNames: [],
  availableToolNames: available,
  hasExplicitSelection: true,
  hasExplicitMode: false,
}), []);
assert.deepEqual(computeActiveToolNames({
  requestedToolNames: ["read", "missing"],
  availableToolNames: available,
  hasExplicitSelection: true,
  hasExplicitMode: false,
}), ["read"]);
assert.deepEqual(computeActiveToolNames({
  requestedToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  availableToolNames: available,
  hasExplicitSelection: true,
  hasExplicitMode: false,
}), available);
console.log("composition policy tests passed");
