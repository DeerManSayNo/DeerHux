import assert from "node:assert/strict";
import { createStandardCodingTools } from "../lib/engine/coding-tools.ts";
import { StdioMcpClient } from "../lib/mcp-runtime.ts";
import { createSubagentTool } from "../lib/parallel-agent/subagent-tool.ts";

const SETTLE_DEADLINE_MS = 2_000;

async function mustSettleQuickly<T>(promise: Promise<T>, label: string): Promise<void> {
  const startedAt = Date.now();
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not settle within ${SETTLE_DEADLINE_MS}ms`)), SETTLE_DEADLINE_MS);
    }),
  ]);
  assert.ok(Date.now() - startedAt < SETTLE_DEADLINE_MS, `${label} should settle quickly after abort`);
}

async function testBashAbort(): Promise<void> {
  const bash = createStandardCodingTools(process.cwd()).find((tool) => tool.name === "bash");
  assert.ok(bash, "bash tool must exist");
  const controller = new AbortController();
  const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 10000)"`;
  const run = bash.execute("bash-abort-test", { command }, controller.signal, undefined, undefined as never);
  setTimeout(() => controller.abort(), 50);
  await mustSettleQuickly(run, "bash tool");
}

async function testMcpAbort(): Promise<void> {
  const writes: string[] = [];
  const client = new StdioMcpClient({
    id: "test",
    name: "test",
    command: "unused",
    transport: "stdio",
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    sourcePath: "test",
    priority: 0,
  }, process.cwd());
  (client as unknown as { proc: { stdin: { destroyed: boolean; writable: boolean; write: (value: string) => void } } }).proc = {
    stdin: { destroyed: false, writable: true, write: (value: string) => { writes.push(value); } },
  };

  const controller = new AbortController();
  const run = client.callTool("slow_tool", {}, controller.signal);
  controller.abort();
  await assert.rejects(run, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.ok(writes.some((value) => value.includes("notifications/cancelled")), "MCP abort must send protocol cancellation");
}

async function testSubagentPreAbort(): Promise<void> {
  const tool = createSubagentTool(process.cwd());
  const controller = new AbortController();
  controller.abort();
  const run = tool.execute("subagent-abort-test", { message: "should not start" }, controller.signal, undefined, undefined as never);
  await assert.rejects(run, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
}

async function main(): Promise<void> {
  await testBashAbort();
  await testMcpAbort();
  await testSubagentPreAbort();
  console.log("tool abort tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
