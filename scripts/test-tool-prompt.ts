import assert from "node:assert/strict";
import { buildLiveToolsSection, orderToolNames } from "../lib/engine/tool-prompt.ts";
import { composeSystemPrompt, decomposeSystemPrompt } from "../lib/system-prompt-decomposer.ts";

const tools = [
  { name: "read", description: "Detailed read schema instructions", promptSnippet: "read: Read current files." },
  { name: "bash", description: "Detailed shell description", promptSnippet: "Run commands." },
  { name: "mcp__example", description: "External tool description" },
  { name: "write", description: "Write files", promptSnippet: " " },
];
// Only active, actually registered tools appear; MCP tools without snippets remain visible.
assert.equal(buildLiveToolsSection(tools, ["read", "missing", "mcp__example", "read"]),
  "Available tools:\n- read: Read current files.\n- mcp__example: External tool description");
assert.equal(buildLiveToolsSection(tools, ["bash", "write"]),
  "Available tools:\n- bash: Run commands.\n- write: Write files\nPrefer the available read/edit/write tools over shell commands for file operations.");
assert.equal(buildLiveToolsSection(tools, []), null);
assert.equal(buildLiveToolsSection(tools, ["missing"]), null);
assert.equal(buildLiveToolsSection([{ name: "x", description: "" }], ["x"]), "Available tools:\n- x: Available tool");
const withCwd = buildLiveToolsSection(tools, ["read"], "/tmp/project with spaces");
assert.ok(withCwd?.includes('Workspace (cwd): "/tmp/project with spaces"'));
assert.ok(withCwd?.includes("Resolve relative tool-result paths"));
assert.ok(!withCwd?.includes("Detailed read schema instructions"));
assert.equal(buildLiveToolsSection(tools, [], "/tmp/project"), null);
// Role-config reconstruction used to silently discard metadata after a blank line.
const rebuilt = composeSystemPrompt(decomposeSystemPrompt(`Identity\n\n${withCwd}\n\nGuidelines:\n- Be concise.`));
assert.ok(rebuilt.includes('Workspace (cwd): "/tmp/project with spaces"'));
assert.ok(rebuilt.includes("Resolve relative tool-result paths"));
assert.ok(rebuilt.includes("- read: Read current files."));
const withFileTools = buildLiveToolsSection(tools, ["read", "bash", "write"], "/tmp/project");
const rebuiltFileTools = composeSystemPrompt(decomposeSystemPrompt(`Identity\n\n${withFileTools}\n\nGuidelines:\n- Be concise.`));
assert.equal((rebuiltFileTools.match(/Prefer the available read\/edit\/write/g) || []).length, 1);
const discoveryTools = [...tools,
  { name: "code_search", description: "Find relevant files" },
  { name: "codegraph", description: "Query symbols and calls" },
];
assert.deepEqual(orderToolNames(["bash", "codegraph", "read", "code_search", "read", "mcp__example"]),
  ["code_search", "codegraph", "bash", "read", "mcp__example"]);
const discovery = buildLiveToolsSection(discoveryTools, ["read", "bash", "codegraph", "code_search"], "/tmp/project");
assert.ok(discovery?.startsWith("Available tools:\n- code_search: Find relevant files\n- codegraph: Query symbols and calls\n- read:"));
const rebuiltDiscovery = composeSystemPrompt(decomposeSystemPrompt(`Identity\n\n${discovery}\n\nGuidelines:\n- Be concise.`));
assert.ok(!rebuiltDiscovery.includes("For code discovery"));
assert.ok(!rebuiltDiscovery.includes("Read known paths directly."));
assert.ok(rebuiltDiscovery.includes("- code_search: Find relevant files"));
const graphOnly = buildLiveToolsSection(discoveryTools, ["read", "codegraph"]);
assert.ok(graphOnly?.startsWith("Available tools:\n- codegraph:"));
assert.ok(!graphOnly?.includes("code_search"));
assert.ok(!buildLiveToolsSection(discoveryTools, ["read", "bash"])?.includes("For code discovery"));
console.log("tool prompt tests passed");
