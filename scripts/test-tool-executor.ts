import assert from "node:assert/strict";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "../lib/engine/loop-event.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";
import { ToolRegistry, type AnyToolDefinition } from "../lib/engine/tool-registry.ts";
import {
  MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
  SUBAGENT_TOOL_NAME,
} from "../lib/parallel-agent/subagent-concurrency.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} } as ToolCall;
}

function makeTool(
  name: string,
  starts: string[],
  gates: Map<string, ReturnType<typeof deferred>>,
  executionMode: "parallel" | "sequential",
): AnyToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    executionMode,
    execute: async (toolCallId: string): Promise<AgentToolResult> => {
      starts.push(toolCallId);
      await gates.get(toolCallId)?.promise;
      return { content: [{ type: "text" as const, text: toolCallId }], details: undefined };
    },
  } as unknown as AnyToolDefinition;
}

function outputTexts(outputs: Awaited<ReturnType<ToolExecutor["executeBatch"]>>): string[] {
  return outputs.map((output) => {
    const block = output.result.content[0] as { text?: string } | undefined;
    return block?.text ?? "";
  });
}

function createExecutor(starts: string[], gates: Map<string, ReturnType<typeof deferred>>): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(makeTool("read", starts, gates, "parallel"));
  registry.register(makeTool("edit", starts, gates, "sequential"));
  return new ToolExecutor(registry);
}

function createSubagentExecutor(starts: string[], gates: Map<string, ReturnType<typeof deferred>>): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(makeTool(SUBAGENT_TOOL_NAME, starts, gates, "parallel"));
  return new ToolExecutor(registry);
}

{
  const starts: string[] = [];
  const gates = new Map([
    ["read-1", deferred()],
    ["edit-1", deferred()],
  ]);
  const executor = createExecutor(starts, gates);
  const run = executor.executeBatch(
    [makeCall("read-1", "read"), makeCall("edit-1", "edit")],
    new AbortController().signal,
    {} as never,
    () => {},
  );

  await tick();
  assert.deepEqual(starts, ["read-1"], "read before edit must not be reversed");
  gates.get("read-1")?.resolve();
  await tick();
  assert.deepEqual(starts, ["read-1", "edit-1"], "edit starts only after prior read segment");
  gates.get("edit-1")?.resolve();
  const outputs = await run;
  assert.deepEqual(outputTexts(outputs), ["read-1", "edit-1"]);
}

{
  const starts: string[] = [];
  const gates = new Map([
    ["read-1", deferred()],
    ["edit-1", deferred()],
    ["read-2", deferred()],
  ]);
  const executor = createExecutor(starts, gates);
  const run = executor.executeBatch(
    [makeCall("read-1", "read"), makeCall("edit-1", "edit"), makeCall("read-2", "read")],
    new AbortController().signal,
    {} as never,
    () => {},
  );

  await tick();
  assert.deepEqual(starts, ["read-1"]);
  gates.get("read-1")?.resolve();
  await tick();
  assert.deepEqual(starts, ["read-1", "edit-1"]);
  gates.get("edit-1")?.resolve();
  await tick();
  assert.deepEqual(starts, ["read-1", "edit-1", "read-2"]);
  gates.get("read-2")?.resolve();
  const outputs = await run;
  assert.deepEqual(outputTexts(outputs), ["read-1", "edit-1", "read-2"]);
}

{
  const starts: string[] = [];
  const gates = new Map([
    ["read-1", deferred()],
    ["read-2", deferred()],
  ]);
  const executor = createExecutor(starts, gates);
  const run = executor.executeBatch(
    [makeCall("read-1", "read"), makeCall("read-2", "read")],
    new AbortController().signal,
    {} as never,
    () => {},
  );

  await tick();
  assert.deepEqual(starts, ["read-1", "read-2"], "continuous parallel segment starts together");
  gates.get("read-2")?.resolve();
  await tick();
  gates.get("read-1")?.resolve();
  const outputs = await run;
  assert.deepEqual(outputTexts(outputs), ["read-1", "read-2"]);
}

{
  const starts: string[] = [];
  const gates = new Map([
    ["subagent-1", deferred()],
    ["subagent-2", deferred()],
  ]);
  const executor = createSubagentExecutor(starts, gates);
  const run = executor.executeBatch(
    [makeCall("subagent-1", SUBAGENT_TOOL_NAME), makeCall("subagent-2", SUBAGENT_TOOL_NAME)],
    new AbortController().signal,
    {} as never,
    () => {},
    {
      callLimits: [{
        toolName: SUBAGENT_TOOL_NAME,
        maxCallsPerTurn: MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
        usedCalls: 0,
      }],
    },
  );

  await tick();
  assert.deepEqual(starts, ["subagent-1"], "same batch should reject the second subagent call");
  gates.get("subagent-1")?.resolve();
  const outputs = await run;
  assert.equal(outputs[0].isError, false);
  assert.equal(outputs[1].isError, true);
  assert.match(outputTexts(outputs)[1], /assistant tool-call batch limit/);
}

{
  const starts: string[] = [];
  const gates = new Map([
    ["subagent-1", deferred()],
    ["subagent-2", deferred()],
  ]);
  const executor = createSubagentExecutor(starts, gates);
  const makeFreshBatchLimit = () => ({
    callLimits: [{
      toolName: SUBAGENT_TOOL_NAME,
      maxCallsPerTurn: MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
      usedCalls: 0,
    }],
  });

  const firstRun = executor.executeBatch(
    [makeCall("subagent-1", SUBAGENT_TOOL_NAME)],
    new AbortController().signal,
    {} as never,
    () => {},
    makeFreshBatchLimit(),
  );
  await tick();
  gates.get("subagent-1")?.resolve();
  const firstOutputs = await firstRun;
  assert.equal(firstOutputs[0].isError, false);

  const secondRun = executor.executeBatch(
    [makeCall("subagent-2", SUBAGENT_TOOL_NAME)],
    new AbortController().signal,
    {} as never,
    () => {},
    makeFreshBatchLimit(),
  );
  await tick();
  assert.deepEqual(starts, ["subagent-1", "subagent-2"], "fresh batch limit allows serial subagent calls");
  gates.get("subagent-2")?.resolve();
  const secondOutputs = await secondRun;
  assert.equal(secondOutputs[0].isError, false);
}

console.log("tool-executor tests passed");
