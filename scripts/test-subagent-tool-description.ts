import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/parallel-agent/subagent-tool.ts", "utf8");

const description = source.match(/description: "(Delegate a focused,[^"]+)"/)?.[1];
assert.ok(description, "subagent tool description must be present");
assert.ok(description.length <= 260, `subagent description is too long: ${description.length}`);
assert.match(description, /self-contained/);
assert.match(description, /simple lookups or quick edits/);
assert.match(description, /do not share this conversation/);
assert.doesNotMatch(description, /code_search|auto-infer|keywords like|runs its own agent session in parallel/);

const messageDescription = source.match(/description: "(Complete, self-contained instructions for the workers\.[^"]+)"/)?.[1];
assert.ok(messageDescription, "message parameter description must be present");
assert.match(messageDescription, /goal, relevant context, constraints, and expected output/);

console.log("subagent tool description tests passed");
