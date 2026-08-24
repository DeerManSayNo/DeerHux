import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { DeerLoopEngine, type AnyModel, type StreamFn } from "../lib/engine/deer-loop.ts";
import type { TurnContextSnapshot } from "../lib/engine/turn-context.ts";
import type { AnyToolDefinition } from "../lib/engine/tool-registry.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const model = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  contextWindow: 100_000,
  maxTokens: 4_096,
} as unknown as AnyModel;

const tool = {
  name: "subagent",
  label: "subagent",
  description: "subagent",
  parameters: {},
  executionMode: "parallel",
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
} as unknown as AnyToolDefinition;

const assistant = (content: AssistantMessage["content"] = [{ type: "text", text: "ok" }], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "test",
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  timestamp: Date.now(),
});

const doneStream = (message: AssistantMessage) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    stream.end(message);
  });
  return stream;
};

const snapshot = (turnId: string, activeToolNames: string[], prompt: string, skillUserPrompt?: string): TurnContextSnapshot => Object.freeze({
  turnId,
  effectiveSystemPrompt: prompt,
  ...(skillUserPrompt ? { skillUserPrompt } : {}),
  activeToolNames: Object.freeze([...activeToolNames]),
  roleId: null,
  agentMode: "agent",
  references: Object.freeze([]),
  createdAt: Date.now(),
});

// A queued follow-up must use its own prompt and tool schema, not the root prompt's.
{
  const firstCall = deferred();
  const contexts: Context[] = [];
  let calls = 0;
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    calls++;
    if (calls === 1) {
      const stream = createAssistantMessageEventStream();
      void firstCall.promise.then(() => {
        const message = assistant();
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }
    return doneStream(assistant());
  };
  const engine = new DeerLoopEngine({ model, cwd: process.cwd(), tools: [tool], activeToolNames: ["subagent"], streamFn });
  const run = engine.prompt({ text: "root", context: snapshot("root", ["subagent"], "root prompt") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await engine.followUp({ text: "next", context: snapshot("follow", [], "follow prompt", "FOLLOW-UP SKILL BODY") });
  assert.equal(engine.followUpQueueLength, 1);
  firstCall.resolve();
  await run;

  assert.equal(engine.followUpQueueLength, 0);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0]?.systemPrompt, "root prompt");
  assert.deepEqual(contexts[0]?.tools?.map((item) => item.name), ["subagent"]);
  assert.equal(contexts[1]?.systemPrompt, "follow prompt");
  assert.equal(contexts[1]?.tools, undefined);
  const followUpUserMessage = contexts[1]?.messages.filter((message) => message.role === "user").at(-1);
  assert.equal(followUpUserMessage?.content, "next\n\nFOLLOW-UP SKILL BODY");
}

// An explicitly selected skill is injected into the root user message, not the system prompt.
{
  const contexts: Context[] = [];
  const engine = new DeerLoopEngine({
    model,
    cwd: process.cwd(),
    streamFn: (_model, context) => {
      contexts.push(context);
      return doneStream(assistant());
    },
  });
  await engine.prompt({ text: "do work", context: snapshot("skill", [], "base prompt", "ACTIVE SKILL BODY") });
  assert.equal(contexts[0]?.systemPrompt, "base prompt");
  const userMessage = contexts[0]?.messages.find((message) => message.role === "user");
  assert.equal(userMessage?.content, "do work\n\nACTIVE SKILL BODY");
}

// A queued steer applies its own execution environment to the next LLM round.
{
  const firstCall = deferred();
  const contexts: Context[] = [];
  let calls = 0;
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    calls++;
    if (calls === 1) {
      const stream = createAssistantMessageEventStream();
      void firstCall.promise.then(() => {
        const message = assistant([{ type: "toolCall", id: "call-1", name: "subagent", arguments: {} }], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      });
      return stream;
    }
    return doneStream(assistant());
  };
  const engine = new DeerLoopEngine({ model, cwd: process.cwd(), tools: [tool], activeToolNames: ["subagent"], streamFn });
  const run = engine.prompt({ text: "root", context: snapshot("root", ["subagent"], "root prompt") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await engine.steer({ text: "change", context: snapshot("steer", [], "steer prompt") });
  firstCall.resolve();
  await run;

  assert.equal(contexts.length, 2);
  assert.equal(contexts[1]?.systemPrompt, "steer prompt");
  assert.equal(contexts[1]?.tools, undefined);
}

// all mode merges adjacent follow-ups whose frozen execution environments are equivalent.
{
  const firstCall = deferred();
  const contexts: Context[] = [];
  let calls = 0;
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    calls++;
    if (calls === 1) {
      const stream = createAssistantMessageEventStream();
      void firstCall.promise.then(() => {
        const message = assistant();
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }
    return doneStream(assistant());
  };
  const engine = new DeerLoopEngine({ model, cwd: process.cwd(), tools: [tool], activeToolNames: ["subagent"], streamFn, followUpMode: "all" });
  const run = engine.prompt({ text: "root", context: snapshot("root", ["subagent"], "root prompt") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await engine.followUp({ text: "first", context: snapshot("first", ["subagent"], "same prompt") });
  await engine.followUp({ text: "second", context: snapshot("second", ["subagent"], "same prompt") });
  firstCall.resolve();
  await run;

  assert.equal(contexts.length, 2, "equivalent all-mode follow-ups should share one LLM call");
  assert.equal(contexts[1]?.systemPrompt, "same prompt");
  const queuedUserTexts = contexts[1]?.messages
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : "") ?? [];
  assert.deepEqual(queuedUserTexts.slice(-2), ["first", "second"]);
}

// all mode must not merge follow-ups with different execution environments.
{
  const firstCall = deferred();
  const contexts: Context[] = [];
  let calls = 0;
  const streamFn: StreamFn = (_model, context) => {
    contexts.push(context);
    calls++;
    if (calls === 1) {
      const stream = createAssistantMessageEventStream();
      void firstCall.promise.then(() => {
        const message = assistant();
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }
    return doneStream(assistant());
  };
  const engine = new DeerLoopEngine({ model, cwd: process.cwd(), tools: [tool], activeToolNames: ["subagent"], streamFn, followUpMode: "all" });
  const run = engine.prompt({ text: "root", context: snapshot("root", ["subagent"], "root prompt") });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await engine.followUp({ text: "off", context: snapshot("off", [], "off prompt") });
  await engine.followUp({ text: "on", context: snapshot("on", ["subagent"], "on prompt") });
  firstCall.resolve();
  await run;

  assert.equal(contexts.length, 3);
  assert.equal(contexts[1]?.systemPrompt, "off prompt");
  assert.equal(contexts[1]?.tools, undefined);
  assert.equal(contexts[2]?.systemPrompt, "on prompt");
  assert.deepEqual(contexts[2]?.tools?.map((item) => item.name), ["subagent"]);
}

// Engine 必须用结构化 stopReason 区分正常结束与用户 Abort。
{
  const normalEvents: Array<{ type: string; stopReason?: string }> = [];
  const normalEngine = new DeerLoopEngine({
    model,
    cwd: process.cwd(),
    streamFn: () => doneStream(assistant()),
  });
  normalEngine.subscribe((event) => normalEvents.push(event));
  await normalEngine.prompt("normal completion");
  assert.equal(normalEvents.findLast((event) => event.type === "agent_end")?.stopReason, "stop");

  const abortEvents: Array<{ type: string; stopReason?: string }> = [];
  const pendingStream = createAssistantMessageEventStream();
  const abortEngine = new DeerLoopEngine({
    model,
    cwd: process.cwd(),
    streamFn: () => pendingStream,
  });
  abortEngine.subscribe((event) => abortEvents.push(event));
  const run = abortEngine.prompt("abort completion");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await abortEngine.abort();
  await run;
  assert.equal(abortEvents.findLast((event) => event.type === "agent_end")?.stopReason, "aborted");
}

console.log("queued turn context behavior tests passed");
