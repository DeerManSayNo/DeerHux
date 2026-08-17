import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveWorkerOutcome } from "../lib/parallel-agent/subagent-outcome.ts";

const loopSource = readFileSync("lib/engine/deer-loop.ts", "utf8");
const loopEventSource = readFileSync("lib/engine/loop-event.ts", "utf8");
assert.doesNotMatch(loopSource, /type:\s*"agent_end"[\s\S]{0,120}messages:/);
const agentEndContract = loopEventSource.match(/type:\s*"agent_end";[\s\S]*?willRetry:\s*boolean;/)?.[0] ?? "";
assert.doesNotMatch(agentEndContract, /messages:/);

const assistant = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "done" }],
  stopReason: "stop",
};
assert.deepEqual(resolveWorkerOutcome(assistant, { willRetry: true }), { kind: "pending" });
assert.deepEqual(resolveWorkerOutcome(assistant, { error: "upstream failed" }), { kind: "reject", error: "upstream failed" });
assert.deepEqual(resolveWorkerOutcome({ ...assistant, stopReason: "error" }, {}), { kind: "reject", error: "Model response failed" });
assert.deepEqual(resolveWorkerOutcome({ ...assistant, stopReason: "aborted" }, {}), { kind: "reject", error: "Worker was aborted" });
assert.deepEqual(resolveWorkerOutcome(null, {}), {
  kind: "reject",
  error: "Worker produced no output (likely a model timeout or upstream error)",
});
assert.deepEqual(resolveWorkerOutcome(assistant, {}), { kind: "resolve", text: "done" });
console.log("runtime event weight tests passed");
