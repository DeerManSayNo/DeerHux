import assert from "node:assert/strict";
import path from "node:path";
import { createMcpRuntimeFromServers, getMcpProcessDiagnostics } from "../lib/mcp-runtime.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";
import { ToolRegistry, type AnyToolDefinition } from "../lib/engine/tool-registry.ts";

const before = getMcpProcessDiagnostics().activeProcesses;
const runtime = await createMcpRuntimeFromServers(process.cwd(), [{
  id: "result-test", name: "result-test", enabled: true, transport: "stdio", stdioFraming: "newline",
  command: process.execPath, args: [path.resolve("scripts/fixtures/mock-mcp-stdio.mjs"), "newline", "--result-contract"],
}]);
try {
  assert.equal(runtime.serverStatuses[0].status, "connected");
  const registry = new ToolRegistry();
  runtime.tools.forEach(tool => registry.register(tool as AnyToolDefinition));
  registry.setActive(runtime.toolNames);
  const executor = new ToolExecutor(registry);
  for (const supportsImages of [true, false]) {
    const events: Array<{ type: string; isError?: boolean }> = [];
    const outputs = await executor.executeBatch(
      [{ type: "toolCall", id: `result-${supportsImages}`, name: runtime.toolNames[0], arguments: {} }],
      new AbortController().signal,
      { model: { input: supportsImages ? ["text", "image"] : ["text"] } } as never,
      event => events.push(event),
    );
    assert.equal(outputs[0].isError, true);
    assert.equal(events.find(event => event.type === "tool_execution_end")?.isError, true);
    const content = outputs[0].result.content as Array<{ type: string }>;
    assert.equal(content.some(block => block.type === "image"), supportsImages);
    assert.equal(content[0].type, "text");
    assert.ok(!JSON.stringify(outputs[0].result.details).includes("iVBOR"), "no duplicate image in details");
  }
} finally {
  runtime.close();
  for (let attempt = 0; attempt < 50 && getMcpProcessDiagnostics().activeProcesses !== before; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
assert.equal(getMcpProcessDiagnostics().activeProcesses, before);
console.log("MCP process -> runtime -> executor image/error integration passed");
