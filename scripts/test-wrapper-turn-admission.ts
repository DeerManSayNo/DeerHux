import assert from "node:assert/strict";
import { AgentSessionWrapper } from "../lib/rpc-manager.ts";
import type { AgentEnginePort } from "../lib/engine/port.ts";
import type { AgentTurnInput } from "../lib/engine/turn-context.ts";
import type { AgentSessionPort } from "../lib/session/port.ts";
import type { ModelCatalogPort } from "../lib/model/port.ts";
import type { ProjectResourcePort } from "../lib/project-resource/port.ts";
import type { McpRuntime, McpRuntimeLease } from "../lib/mcp-runtime.ts";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const skillGate = gate();
let nextSkillGate: ReturnType<typeof gate> | null = skillGate;
const promptInputs: AgentTurnInput[] = [];
const steerInputs: AgentTurnInput[] = [];
let activeToolNames = ["read"];
let systemPrompt = "BASE";
let streaming = false;
let abortGate: ReturnType<typeof gate> | null = null;
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
  followUp: async () => {},
  getContextUsage: () => undefined,
  abort: async () => {
    await abortGate?.promise;
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

const resources = {
  resolveSkill: async () => {
    const currentGate = nextSkillGate;
    nextSkillGate = null;
    await currentGate?.promise;
    return { name: "slow-skill", content: "slow" };
  },
} as ProjectResourcePort;

const wrapper = new AgentSessionWrapper(engine, session, models, resources, null, null, "agent");
wrapper.start();
const prompt = wrapper.send({
  type: "prompt",
  message: "use skill",
  skillName: "slow-skill",
  clientMessageId: `client-${Date.now()}`,
  capabilities: { subagent: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));

// Simulate a delayed connectEvents prewarm arriving while input preparation is paused.
await wrapper.send({ type: "set_subagent_enabled", enabled: false });
skillGate.resolve();
await prompt;

assert.equal(promptInputs.length, 1);
assert.deepEqual(promptInputs[0]?.context?.activeToolNames, ["read", "subagent"]);
assert.match(promptInputs[0]?.context?.effectiveSystemPrompt ?? "", /subagent/);
assert.doesNotMatch(promptInputs[0]?.context?.effectiveSystemPrompt ?? "", /slow-skill/);
assert.match(promptInputs[0]?.context?.skillUserPrompt ?? "", /slow-skill/);
assert.match(promptInputs[0]?.context?.skillUserPrompt ?? "", /slow/);
assert.equal(activeToolNames.includes("subagent"), false, "later control command should still update future turns");

// Recover reserves fresh-turn admission before awaiting old-turn settlement.
abortGate = gate();
streaming = true;
const recover = wrapper.send({
  type: "recover",
  message: "recover",
  capabilities: { subagent: true },
});
await new Promise((resolve) => setTimeout(resolve, 0));
await assert.rejects(
  wrapper.send({ type: "prompt", message: "racing prompt", capabilities: { subagent: false } }),
  /AGENT_BUSY/,
);
assert.equal(activeToolNames.includes("subagent"), false, "rejected prompt must not mutate recover or future capability state");
abortGate.resolve();
await recover;
assert.equal(promptInputs.length, 2);
assert.deepEqual(promptInputs[1]?.context?.activeToolNames, ["read", "subagent"]);

// Steer 在异步准备期间根回合结束时，必须提升为 fresh prompt，不能残留在队列。
listener?.({ type: "agent_start" });
const steerSkillGate = gate();
nextSkillGate = steerSkillGate;
const steer = wrapper.send({
  type: "steer",
  message: "promote me",
  skillName: "slow-skill",
  capabilities: { subagent: false },
});
await new Promise((resolve) => setTimeout(resolve, 0));
listener?.({ type: "agent_end", willRetry: false });
steerSkillGate.resolve();
await steer;
assert.equal(steerInputs.length, 0, "settled root turn must not receive a queued steer");
assert.equal(promptInputs.length, 3, "prepared steer should be promoted to a fresh prompt");
assert.equal(promptInputs[2]?.text, "promote me");
assert.deepEqual(promptInputs[2]?.context?.activeToolNames, ["read"]);
assert.doesNotMatch(promptInputs[2]?.context?.effectiveSystemPrompt ?? "", /slow-skill/);
assert.match(promptInputs[2]?.context?.skillUserPrompt ?? "", /slow-skill/);

await assert.rejects(
  wrapper.send({ type: "steer", message: "idle steer" }),
  /AGENT_NOT_RUNNING/,
);

// Recover 的 deadline 必须覆盖 inner.abort() 自身，而不是在它返回后才计时。
abortGate = gate();
streaming = true;
const abortAndSettle = (wrapper as unknown as { abortAndSettleCurrentTurn(timeoutMs: number): Promise<void> })
  .abortAndSettleCurrentTurn.bind(wrapper);
const startedAt = Date.now();
await assert.rejects(abortAndSettle(40), /abort timeout.*40ms/);
assert.ok(Date.now() - startedAt < 500, "abort deadline should reject promptly");
abortGate.resolve();
streaming = false;

// 即使底层 Skill 永不返回，Abort 也必须让 Steer 立即退出并释放 reservation。
listener?.({ type: "agent_start" });
nextSkillGate = gate(); // intentionally never resolve
const stuckSteer = wrapper.send({ type: "steer", message: "stuck", skillName: "slow-skill" });
await new Promise((resolve) => setTimeout(resolve, 0));
await wrapper.send({ type: "abort" });
await assert.rejects(
  Promise.race([
    stuckSteer,
    new Promise((_, reject) => setTimeout(() => reject(new Error("steer cancellation timeout")), 250)),
  ]),
  /Abort|Stop requested/,
);
listener?.({ type: "agent_end", willRetry: false });
for (let i = 0; i < 50 && (wrapper as unknown as { changedFilesFinalizing: boolean }).changedFilesFinalizing; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await wrapper.send({ type: "prompt", message: "reservation released" });
assert.equal(promptInputs.at(-1)?.text, "reservation released");

// Engine 状态已空闲但旧 turn Promise 未完成时，总 deadline 仍必须拒绝。
const oldTurnGate = gate();
const internals = wrapper as unknown as {
  activeTurnId: number;
  activeTurnPromise: Promise<void> | null;
  abortAndSettleCurrentTurn(timeoutMs: number): Promise<void>;
};
internals.activeTurnPromise = oldTurnGate.promise;
const promiseWaitStartedAt = Date.now();
await assert.rejects(
  internals.abortAndSettleCurrentTurn(40),
  /current turn promise did not settle.*40ms/,
);
assert.ok(Date.now() - promiseWaitStartedAt < 500, "turn promise deadline should reject promptly");
oldTurnGate.resolve();
internals.activeTurnPromise = null;

wrapper.destroy();

// MCP 安装中途失败必须恢复旧 Registry、激活名单、Prompt，并保留旧 Lease。
{
  const readTool = { name: "read", description: "read", execute: async () => ({ content: [] }) };
  const oldTool = { name: "mcp__old", description: "old", execute: async () => ({ content: [] }) };
  const newTool = { name: "mcp__new", description: "new", execute: async () => ({ content: [] }) };
  const registry = new Map([[readTool.name, readTool], [oldTool.name, oldTool]]);
  let rollbackPhase = false;
  let active = ["read", oldTool.name];
  let promptText = "OLD PROMPT";
  let oldLeaseReleases = 0;
  const transactionEngine = {
    ...engine,
    get systemPrompt() { return promptText; },
    getAllTools: () => [...registry.values()],
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => { active = [...names]; },
    setSystemPromptPersistent: (value: string) => { promptText = value; },
    replaceCustomTools(options: { removeNames: readonly string[]; addTools: Array<typeof oldTool>; activeToolNames: readonly string[] }) {
      for (const name of options.removeNames) registry.delete(name);
      for (const toolDefinition of options.addTools) registry.set(toolDefinition.name, toolDefinition);
      active = options.activeToolNames.filter((name) => registry.has(name));
      rollbackPhase = options.addTools.some((item) => item === oldTool);
    },
    applyToolExecutionModes() {
      if (!rollbackPhase) throw new Error("execution mode install failed");
    },
  } as unknown as AgentEnginePort;
  const oldRuntime = { toolNames: [oldTool.name], tools: [oldTool] } as unknown as McpRuntime;
  const oldLease = { runtime: oldRuntime, release: () => { oldLeaseReleases++; } } as McpRuntimeLease;
  const transactionWrapper = new AgentSessionWrapper(transactionEngine, session, models, resources, null, oldLease, "agent");
  const promptBeforeInstall = promptText;
  const install = (transactionWrapper as unknown as { installMcpRuntime(runtime: McpRuntime, activate: boolean): void })
    .installMcpRuntime.bind(transactionWrapper);

  assert.throws(
    () => install({ toolNames: [newTool.name], tools: [newTool] } as unknown as McpRuntime, true),
    /execution mode install failed/,
  );
  assert.deepEqual([...registry.keys()], [readTool.name, oldTool.name]);
  assert.deepEqual(active, ["read", oldTool.name]);
  assert.equal(promptText, promptBeforeInstall);
  assert.equal(oldLeaseReleases, 0, "failed install must retain the old runtime lease");
  transactionWrapper.destroy();
}

// Abort / Destroy 后晚到的 MCP Lease 只能释放，不能安装或被 Wrapper 持有。
for (const invalidate of ["abort", "destroy"] as const) {
  const acquireGate = gate();
  let releases = 0;
  let installs = 0;
  const lateRuntime = {
    tools: [],
    toolNames: ["mcp__late"],
    serverStatuses: [],
    describeImages: async () => [],
    close: () => {},
  } as McpRuntime;
  const lateLease = {
    runtime: lateRuntime,
    release: () => { releases++; },
  } as McpRuntimeLease;
  const lateWrapper = new AgentSessionWrapper(engine, session, models, resources, null, null, "agent");
  const internals = lateWrapper as unknown as {
    mcpRuntimeLease: McpRuntimeLease | null | undefined;
    acquireMcpRuntimeLease(): Promise<McpRuntimeLease>;
    installMcpRuntime(runtime: McpRuntime, activate: boolean): void;
    ensureMcpRuntimeLoaded(options: { signal?: AbortSignal; canCommit?: () => boolean }): Promise<McpRuntime | null>;
  };
  internals.acquireMcpRuntimeLease = async () => {
    await acquireGate.promise;
    return lateLease;
  };
  internals.installMcpRuntime = () => { installs++; };
  const controller = new AbortController();
  const loading = internals.ensureMcpRuntimeLoaded({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (invalidate === "abort") controller.abort();
  else lateWrapper.destroy();
  acquireGate.resolve();
  await assert.rejects(loading, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(releases, 1, `${invalidate}: late lease must be released exactly once`);
  assert.equal(installs, 0, `${invalidate}: late runtime must not be installed`);
  assert.equal(internals.mcpRuntimeLease, null, `${invalidate}: wrapper must not retain late lease`);
  if (invalidate === "abort") lateWrapper.destroy();
}

// Run 终态优先读取结构化 stopReason；willRetry 临时事件不得提前终结。
{
  let runListener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
  const runEngine = {
    ...engine,
    subscribe(callback: typeof runListener) { runListener = callback; return () => { runListener = undefined; }; },
  } as unknown as AgentEnginePort;
  const runWrapper = new AgentSessionWrapper(runEngine, session, models, resources, null, null, "agent");
  const runInternals = runWrapper as unknown as {
    createPromptRun(turnKey: string): string;
    transitionCurrentRun(transition: { status: "running" }): void;
  };
  runWrapper.start();
  runInternals.createPromptRun(`${session.id}:run-status`);
  runInternals.transitionCurrentRun({ status: "running" });
  runListener?.({ type: "agent_end", willRetry: true, stopReason: "error", error: "temporary" });
  assert.equal(runWrapper.getLastRun()?.status, "running");
  runListener?.({ type: "agent_end", willRetry: false, stopReason: "aborted" });
  assert.equal(runWrapper.getLastRun()?.status, "cancelled");
  runWrapper.destroy();
}

console.log("wrapper turn admission behavior tests passed");
