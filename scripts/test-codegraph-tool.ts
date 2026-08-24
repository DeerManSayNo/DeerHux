import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCodeGraphArgs,
  CODEGRAPH_TOOL_NAME,
  LEGACY_CODEGRAPH_TOOL_NAMES,
  normalizeCodeGraphToolNames,
} from "../lib/codegraph/tools.ts";

assert.equal(CODEGRAPH_TOOL_NAME, "codegraph");
assert.deepEqual(normalizeCodeGraphToolNames([
  "read",
  "codegraph_search",
  "codegraph_callers",
  "codegraph",
  "write",
]), ["read", "codegraph", "write"]);
assert.deepEqual(normalizeCodeGraphToolNames(LEGACY_CODEGRAPH_TOOL_NAMES), ["codegraph"]);
assert.deepEqual(normalizeCodeGraphToolNames(["read", "write"]), ["read", "write"]);

assert.deepEqual(buildCodeGraphArgs({ action: "status" }), ["status", "--json"]);
assert.deepEqual(buildCodeGraphArgs({ action: "search", query: "AgentSession", limit: 999, kind: "class" }), [
  "query", "AgentSession", "--json", "--limit", "50", "--kind", "class",
]);
assert.deepEqual(buildCodeGraphArgs({ action: "callers", symbol: "prompt" }), [
  "callers", "prompt", "--json", "--limit", "20",
]);
assert.deepEqual(buildCodeGraphArgs({ action: "callees", symbol: "prompt", limit: 0 }), [
  "callees", "prompt", "--json", "--limit", "1",
]);
assert.deepEqual(buildCodeGraphArgs({ action: "impact", symbol: "prompt", depth: 99 }), [
  "impact", "prompt", "--json", "--depth", "5",
]);
assert.throws(() => buildCodeGraphArgs({ action: "search" }), /requires `query`/);
assert.throws(() => buildCodeGraphArgs({ action: "impact" }), /requires `symbol`/);

const tools = readFileSync("lib/codegraph/tools.ts", "utf8");
assert.match(tools, /name: CODEGRAPH_TOOL_NAME/);
for (const action of ["status", "search", "callers", "callees", "impact"]) {
  assert.match(tools, new RegExp(`Type\\.Literal\\("${action}"\\)`));
}
assert.match(tools, /required\(params\.query, "query", params\.action\)/);
assert.match(tools, /required\(params\.symbol, "symbol", params\.action\)/);

for (const file of [
  "lib/agent-modes.ts",
  "components/ToolPanel.tsx",
  "lib/parallel-agent/subagent-runner.ts",
]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /"codegraph"/, `${file} must expose the dispatcher`);
  for (const legacy of LEGACY_CODEGRAPH_TOOL_NAMES) {
    assert.equal(source.includes(`"${legacy}"`), false, `${file} still exposes ${legacy}`);
  }
}

console.log("codegraph dispatcher tests passed");
