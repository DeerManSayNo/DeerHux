import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentSessionWrapper } from "../lib/rpc-manager.ts";
import type { AgentEnginePort } from "../lib/engine/port.ts";
import type { AgentSessionPort } from "../lib/session/port.ts";
import type { ModelCatalogPort } from "../lib/model/port.ts";
import type { ProjectResourcePort } from "../lib/project-resource/port.ts";
import { readIndex } from "../lib/code-index/database.ts";
import { getIndexPath } from "../lib/code-index/paths.ts";
import { createCodeSearchTool } from "../lib/code-index/tool.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-index-register-"));
const wrappers: AgentSessionWrapper[] = [];
const roots: string[] = [];
async function waitFor(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 8_000;
  while (!await check()) {
    assert.ok(Date.now() < end, "tool registration timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function make(cwd: string) {
  let prompt = "BASE";
  let active = ["read"];
  let streaming = false;
  const tools = new Map<string, { name: string; description: string; promptSnippet?: string }>([["read", { name: "read", description: "Read a file" }]]);
  const engine = {
    get systemPrompt() { return prompt; },
    get isStreaming() { return streaming; },
    isCompacting: false,
    getAllTools: () => [...tools.values()],
    getActiveToolNames: () => active,
    setActiveToolsByName: (names: string[]) => { active = names.filter(n => tools.has(n)); },
    setSystemPromptPersistent: (value: string) => { prompt = value; },
    replaceCustomTools: (options: { addTools: { name: string; description: string; promptSnippet?: string }[]; activeToolNames: string[] }) => {
      assert.equal(streaming, false, "must not change the registry during a running turn");
      for (const tool of options.addTools) tools.set(tool.name, tool);
      active = options.activeToolNames;
    },
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentEnginePort;
  const session = { id: randomUUID(), cwd, persisted: false } as AgentSessionPort;
  const wrapper = new AgentSessionWrapper(engine, session, {} as ModelCatalogPort, {} as ProjectResourcePort, null, null, "agent");
  wrappers.push(wrapper);
  roots.push(cwd);
  return { wrapper, tools, engine, stream: (value: boolean) => { streaming = value; } };
}
try {
  const cwd = path.join(root, "normal");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "hello.ts"), "export const hello = 'INDEX_READY';\n");
  const normal = make(cwd);
  assert.equal(normal.tools.has("code_search"), false);
  normal.stream(true);
  normal.wrapper.startCodeIndexing();
  await waitFor(async () => Boolean(await readIndex(cwd)));
  assert.equal(normal.tools.has("code_search"), false, "index readiness must not mutate an active turn");
  normal.stream(false);
  await normal.wrapper.send({ type: "get_tools" });
  assert.ok(normal.engine.getActiveToolNames().includes("code_search"));
  assert.equal(normal.engine.getActiveToolNames()[0], "code_search");
  assert.ok(normal.engine.systemPrompt.includes("code_search: Prefer indexed keyword search"));
  const tool = createCodeSearchTool(cwd);
  const result = await tool.execute("lookup", { query: "INDEX_READY" }, new AbortController().signal, undefined, {} as never);
  assert.ok(JSON.stringify(result).includes("hello.ts"));

  const customCwd = path.join(root, "custom");
  await fs.mkdir(customCwd);
  await fs.writeFile(path.join(customCwd, "file.txt"), "CUSTOM");
  const custom = make(customCwd);
  custom.wrapper.startCodeIndexing(false);
  await waitFor(() => custom.tools.has("code_search"));
  assert.deepEqual(custom.engine.getActiveToolNames(), ["read"], "explicitly disabled tools must stay disabled");
  assert.ok(!custom.engine.systemPrompt.includes("- code_search:"));
  await custom.wrapper.send({ type: "set_tools", toolNames: ["read", "code_search"] });
  assert.ok(custom.engine.getActiveToolNames().includes("code_search"));
  await custom.wrapper.send({ type: "set_tools", toolNames: ["read"] });
  await fs.writeFile(path.join(customCwd, "file.txt"), "CHANGED");
  await waitFor(async () => (await readIndex(customCwd))?.files[0]?.content === "CHANGED");
  await custom.wrapper.send({ type: "get_tools" });
  assert.deepEqual(custom.engine.getActiveToolNames(), ["read"]);
  console.log("code-index registration: same-session activation, prompt sync, real search, turn isolation and manual selection passed");
} finally {
  for (const wrapper of wrappers) wrapper.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  await fs.rm(root, { recursive: true, force: true });
  for (const cwd of roots) await fs.rm(getIndexPath(cwd), { force: true });
}
