import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sliceCase = (text: string, name: string, nextName: string) => {
  const start = text.indexOf(`case "${name}"`);
  const end = text.indexOf(`case "${nextName}"`, start + 1);
  assert.ok(start >= 0 && end > start, `missing ${name} command case`);
  return text.slice(start, end);
};
const assertOrder = (text: string, needles: string[]) => {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `expected ${needle} after offset ${cursor}`);
    cursor = next;
  }
};

const hook = source("hooks/useAgentSession.ts");
const rpc = source("lib/rpc-manager.ts");
const composition = source("lib/engine/deer-loop-composition.ts");
const runner = source("lib/parallel-agent/subagent-runner.ts");
const messageView = source("components/MessageView.tsx");

// Every UI command that can create a model context carries the current capability snapshot.
for (const command of ["prompt", "recover", "follow_up", "steer"]) {
  const re = new RegExp(`type: "${command}"`, "g");
  for (const match of hook.matchAll(re)) {
    const commandBody = hook.slice(match.index, hook.indexOf("});", match.index) + 3);
    assert.match(commandBody, /capabilities: getTurnCapabilities\(\)/, `${command} at ${match.index} lacks capabilities`);
  }
}
assert.match(hook, /set_subagent_enabled/); // mount/toggle prewarm remains, but is not the correctness path.

// Prompt retries and rejected busy requests cannot mutate capability state.
const promptCase = sliceCase(rpc, "prompt", "set_role");
assertOrder(promptCase, [
  "pendingPromptAdmissions.get",
  "findAcceptedPrompt",
  "this.isTurnBusy() || this._stopRequested",
  "this.captureTurnAdmission(command)",
  "this.commitAndTrackPromptTurn(",
]);

// Recover reserves fresh-turn admission before settling the old turn, then snapshots before async preparation.
const recoverCase = sliceCase(rpc, "recover", "get_state");
assertOrder(recoverCase, [
  "this.reserveFreshTurnAdmission(",
  "await this.abortAndSettleCurrentTurn()",
  "this.captureTurnAdmission(command)",
  "this.commitAndTrackPromptTurn(",
]);

for (const [name, next] of [["steer", "follow_up"], ["follow_up", "mcp_reload"]] as const) {
  const commandCase = sliceCase(rpc, name, next);
  assertOrder(commandCase, ["this.captureTurnAdmission(command)", "this.buildFrozenTurnContext("]);
}

assert.match(rpc, /const shouldEnable = this\._subagentEnabled && !isReadOnlyAgentMode\(this\.agentMode\)/);
assert.match(rpc, /capabilities: \{ subagent: this\._subagentEnabled \}/);
assert.match(rpc, /activeToolNames: this\.inner\.getActiveToolNames\(\)/);
assert.match(composition, /subagentTool \? \[SUBAGENT_TOOL_NAME\] : \[\]/);
assert.match(runner, /allowSubagentTool: false/);
assert.match(messageView, /当前系统提示词/);
assert.match(messageView, /不一定等于该历史回合发送时使用的系统提示词和工具集合/);

console.log("subagent capability contracts passed");
