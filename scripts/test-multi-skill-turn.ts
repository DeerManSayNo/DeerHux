import assert from "node:assert/strict";
import { AgentSessionWrapper } from "../lib/rpc-manager.ts";
import type { AgentEnginePort } from "../lib/engine/port.ts";
import type { AgentTurnInput } from "../lib/engine/turn-context.ts";
import type { AgentSessionPort } from "../lib/session/port.ts";
import type { ModelCatalogPort } from "../lib/model/port.ts";
import type { ProjectResourcePort } from "../lib/project-resource/port.ts";
const promptInputs: AgentTurnInput[] = [];
const steerInputs: AgentTurnInput[] = [];
const followInputs: AgentTurnInput[] = [];
let activeToolNames = ["read"];
let systemPrompt = "BASE";
let streaming = false;
let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

const engine = {
  get model() { return { id: "test-model", provider: "test", contextWindow: 100_000 }; },
  get systemPrompt() { return systemPrompt; },
  get thinkingLevel() { return "off"; },
  get isStreaming() { return streaming; },
  get isCompacting() { return false; },
  get autoCompactionEnabled() { return true; },
  get autoRetryEnabled() { return false; },
  get autoRecoveryMode() { return "off"; },
  subscribe(callback: typeof listener) { listener = callback; return () => { listener = undefined; }; },
  getAllTools: () => [
    { name: "read", description: "read" },
    { name: "subagent", description: "subagent" },
  ],
  getActiveToolNames: () => [...activeToolNames],
  setActiveToolsByName(names: string[]) { activeToolNames = [...names]; },
  setSystemPromptPersistent(prompt: string) { systemPrompt = prompt; },
  prompt: async (input: AgentTurnInput) => {
    promptInputs.push(input);
    listener?.({ type: "agent_start" });
    listener?.({ type: "agent_end", willRetry: false });
  },
  steer: async (input: AgentTurnInput) => { steerInputs.push(input); },
  followUp: async (input: AgentTurnInput) => { followInputs.push(input); },
  getContextUsage: () => undefined,
  abort: async () => {
    streaming = false;
  },
  abortCompaction: () => {},
  dispose: () => {},
} as unknown as AgentEnginePort;

const session = {
  id: `test-admission-${Date.now()}`,
  cwd: process.cwd(),
  persisted: false,
  getCustomEntries: () => [],
  appendModelChange: () => undefined,
  appendThinkingLevelChange: () => undefined,
  appendCustomEntry: () => undefined,
  navigate: () => ({ messages: [] }),
  fork: () => undefined,
} as AgentSessionPort;

const models = {
  resolve: () => undefined,
} as unknown as ModelCatalogPort;

const resolvedNames: string[] = [];
const resources = {
  resolveSkill: async (_cwd: string, name: string) => {
    resolvedNames.push(name);
    return { name, content: `instructions-for-${name}` };
  },
} as ProjectResourcePort;

const wrapper = new AgentSessionWrapper(engine, session, models, resources, null, null, "agent");
wrapper.start();
try {
  await wrapper.send({ type: "prompt", message: "正文", skillNames: ["alpha", "beta", "alpha", " "] });
  assert.deepEqual(resolvedNames, ["alpha", "beta"], "resolve every selected skill exactly once");
  const context = promptInputs[0].context!;
  assert.deepEqual(context.skill, { name: "alpha", names: ["alpha", "beta"] });
  assert.match(context.skillUserPrompt!, /instructions-for-alpha[\s\S]*instructions-for-beta/);
  assert.doesNotMatch(context.effectiveSystemPrompt, /instructions-for-/);
  assert.ok(Object.isFrozen(context.skill?.names));
  assert.equal(promptInputs[0].text, "正文");

  streaming = true;
  listener?.({ type: "agent_start" });
  await wrapper.send({ type: "steer", message: "追加", skillNames: ["beta", "gamma"] });
  await wrapper.send({ type: "follow_up", message: "排队", skillNames: ["alpha", "gamma"] });
  assert.deepEqual(steerInputs[0]?.context?.skill?.names, ["beta", "gamma"]);
  assert.match(steerInputs[0]?.context?.skillUserPrompt ?? "", /instructions-for-beta[\s\S]*instructions-for-gamma/);
  assert.deepEqual(followInputs[0]?.context?.skill?.names, ["alpha", "gamma"]);
  assert.match(followInputs[0]?.context?.skillUserPrompt ?? "", /instructions-for-alpha[\s\S]*instructions-for-gamma/);
  streaming = false;
  listener?.({ type: "agent_end", willRetry: false });

  await wrapper.send({ type: "prompt", message: "", skillNames: ["alpha", "beta"] });
  assert.equal(promptInputs[1].text, "Use the selected skill: alpha、beta.");
  await wrapper.send({ type: "prompt", message: "/skill:legacy request" });
  assert.deepEqual(promptInputs[2].context?.skill, { name: "legacy" });
  assert.equal(promptInputs[2].text, "request");
  await wrapper.send({ type: "prompt", message: "old client", skillName: "single" });
  assert.deepEqual(promptInputs[3].context?.skill, { name: "single" });
} finally {
  wrapper.destroy();
}
console.log("multi-skill turn integration tests passed");
