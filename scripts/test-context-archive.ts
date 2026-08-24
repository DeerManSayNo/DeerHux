/**
 * Dynamic Context Discovery —— context-archive 单元验收。
 *
 * 运行：npx tsx scripts/test-context-archive.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  appendHistoryArchiveFooter,
  deleteContextArchive,
  getContextDir,
  spillLargeText,
  writeHistoryTranscript,
  writeToolOutput,
} from "../lib/engine/context-archive.ts";
import { createStandardCodingTools } from "../lib/engine/coding-tools.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";
import { ToolRegistry } from "../lib/engine/tool-registry.ts";
import type { AnyToolDefinition } from "../lib/engine/tool-registry.ts";
import type { AgentToolResult } from "../lib/engine/loop-event.ts";

const SESSION_ID = `test-ctx-archive-${Date.now()}`;

function cleanup(): void {
  deleteContextArchive(SESSION_ID);
}

async function testHistoryTranscript(): Promise<void> {
  const historyFile = writeHistoryTranscript({
    sessionId: SESSION_ID,
    compactionId: "abc123def456",
    fromEntryId: "e1",
    toEntryId: "e9",
    messages: [
      { role: "user", content: "hello world secret-token-xyz" },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will help" }, { type: "toolCall", toolCallId: "t1", toolName: "bash", input: { command: "echo hi" } }],
      },
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "hi\n" }] },
    ],
  });
  assert.ok(fs.existsSync(historyFile), "history file must exist");
  const body = fs.readFileSync(historyFile, "utf8");
  assert.ok(body.includes("secret-token-xyz"), "history must keep original detail");
  assert.ok(body.includes("### [1] user"), "history must include role headers");
  assert.ok(body.includes("toolCall bash"), "history must serialize tool calls");

  const summary = appendHistoryArchiveFooter("Short summary of the chat.", historyFile, SESSION_ID);
  assert.ok(summary.includes("[DeerHux History Archive]"), "footer marker required");
  assert.ok(summary.includes(historyFile), "footer must include absolute path");

  // 第二次压缩：即使模型丢掉旧 footer，也应重写为「全部 history 列表」
  const historyFile2 = writeHistoryTranscript({
    sessionId: SESSION_ID,
    compactionId: "abc123def457",
    messages: [{ role: "user", content: "second-wave" }],
  });
  const rolled = appendHistoryArchiveFooter(
    "Summary two (model dropped prior footer)",
    historyFile2,
    SESSION_ID,
  );
  assert.ok(rolled.includes(historyFile), "multi-compact footer must keep first archive path");
  assert.ok(rolled.includes(historyFile2), "multi-compact footer must include latest archive path");
  assert.equal(
    (rolled.match(/\[DeerHux History Archive\]/g) ?? []).length,
    1,
    "footer must be rewritten once, not stacked",
  );

  const manifestPath = path.join(getContextDir(SESSION_ID), "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "manifest must exist");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { entries: unknown[] };
  assert.ok(manifest.entries.length >= 1, "manifest should record history entry");
}

async function testSpillLargeText(): Promise<void> {
  const long = Array.from({ length: 400 }, (_, i) => `line-${i} unique-${i}-marker`).join("\n");
  const spilled = spillLargeText(long, {
    sessionId: SESSION_ID,
    toolCallId: "call-spill-1",
    toolName: "bash",
  });
  assert.equal(spilled.spilled, true);
  assert.ok(spilled.path && fs.existsSync(spilled.path), "spill file must exist");
  assert.ok(spilled.preview.includes("[Output truncated. Full output:"), "preview must point to full file");
  assert.ok(spilled.preview.length < long.length, "preview must be shorter than full text");
  const full = fs.readFileSync(spilled.path!, "utf8");
  assert.ok(full.includes("unique-399-marker"), "full file must keep tail content");

  const again = spillLargeText(spilled.preview, {
    sessionId: SESSION_ID,
    toolCallId: "call-spill-2",
    toolName: "bash",
  });
  assert.equal(again.spilled, false, "already-spilled preview must not re-spill");
}

async function testCodingToolsCanReadArchive(): Promise<void> {
  const toolOut = writeToolOutput({
    sessionId: SESSION_ID,
    toolCallId: "readable-1",
    toolName: "bash",
    content: "recoverable-detail-42\n",
  });
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-readable-workspace-"));
  const tools = createStandardCodingTools(workspaceDir, { sessionId: SESSION_ID });
  const read = tools.find((t) => t.name === "read");
  assert.ok(read);
  const result = await read!.execute(
    "read-test",
    { filePath: toolOut },
    undefined,
    undefined,
    undefined as never,
  );
  const text = (result.content[0] as { text: string }).text;
  assert.ok(text.includes("recoverable-detail-42"), "read must access session context archive");

  const externalFile = path.join(os.tmpdir(), `deerhux-readable-external-${Date.now()}.txt`);
  fs.writeFileSync(externalFile, "outside-workspace-readable\n", "utf8");
  try {
    const externalResult = await read!.execute(
      "read-external-test",
      { filePath: externalFile },
      undefined,
      undefined,
      undefined as never,
    );
    assert.ok(
      (externalResult.content[0] as { text: string }).text.includes("outside-workspace-readable"),
      "read must access files outside the workspace",
    );
  } finally {
    fs.rmSync(externalFile, { force: true });
  }

  // 被动 Skill 的绝对路径来自 system prompt，标准文件工具必须能直接维护全局 Skill。
  const skillDir = path.join(getAgentDir(), "skills", `test-readable-${Date.now()}`);
  const skillFile = path.join(skillDir, "SKILL.md");
  const write = tools.find((t) => t.name === "write");
  const edit = tools.find((t) => t.name === "edit");
  assert.ok(write && edit);
  try {
    await write!.execute(
      "write-skill-test",
      { filePath: skillFile, content: "# passive-skill-readable\n" },
      undefined,
      undefined,
      undefined as never,
    );
    const skillResult = await read!.execute(
      "read-skill-test",
      { filePath: skillFile },
      undefined,
      undefined,
      undefined as never,
    );
    const skillText = (skillResult.content[0] as { text: string }).text;
    assert.ok(skillText.includes("passive-skill-readable"), "read/write must access global Skill files");

    await edit!.execute(
      "edit-skill-test",
      { filePath: skillFile, oldString: "readable", newString: "editable" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.ok(fs.readFileSync(skillFile, "utf8").includes("passive-skill-editable"), "edit must update global Skill files");
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  // context archive 保持只读。
  await assert.rejects(
    () => write!.execute(
      "write-test",
      { filePath: path.join(getContextDir(SESSION_ID), "evil.txt"), content: "nope" },
      undefined,
      undefined,
      undefined as never,
    ),
    /allowed resource root/,
  );
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

async function testDefaultCwdHasUnrestrictedWriteAccess(): Promise<void> {
  const defaultCwd = path.join(os.homedir(), "deerhux-cwd");
  fs.mkdirSync(defaultCwd, { recursive: true });
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-unrestricted-write-"));
  const externalFile = path.join(externalDir, "outside.txt");
  const tools = createStandardCodingTools(defaultCwd);
  const write = tools.find((t) => t.name === "write");
  const edit = tools.find((t) => t.name === "edit");
  assert.ok(write && edit);
  try {
    await write!.execute(
      "default-cwd-write-test",
      { filePath: externalFile, content: "outside-before\n" },
      undefined,
      undefined,
      undefined as never,
    );
    await edit!.execute(
      "default-cwd-edit-test",
      { filePath: externalFile, oldString: "before", newString: "after" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(fs.readFileSync(externalFile, "utf8"), "outside-after\n");
  } finally {
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
}

async function testToolExecutorSpill(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register({
    name: "loud",
    label: "Loud",
    description: "returns a long string",
    parameters: {},
    execute: async (): Promise<AgentToolResult> => ({
      content: [{ type: "text" as const, text: "X".repeat(20_000) }],
      details: {},
    }),
  } as unknown as AnyToolDefinition);
  registry.setActive(["loud"]);
  const executor = new ToolExecutor(registry, { sessionId: SESSION_ID });
  const outputs = await executor.executeBatch(
    [{ id: "tc-loud", name: "loud", arguments: {} }] as never,
    new AbortController().signal,
    {} as never,
    () => {},
  );
  const text = (outputs[0].result.content[0] as { text: string }).text;
  assert.ok(text.includes("[Output truncated. Full output:"), "executor must spill large results");
  assert.ok(text.length < 20_000, "executor preview must be shorter");
}

async function testDeleteCascade(): Promise<void> {
  const dir = getContextDir(SESSION_ID);
  assert.ok(fs.existsSync(dir));
  deleteContextArchive(SESSION_ID);
  assert.ok(!fs.existsSync(dir), "deleteContextArchive must remove session context dir");
}

async function main(): Promise<void> {
  cleanup();
  try {
    await testHistoryTranscript();
    await testSpillLargeText();
    await testCodingToolsCanReadArchive();
    await testDefaultCwdHasUnrestrictedWriteAccess();
    await testToolExecutorSpill();
    await testDeleteCascade();
    console.log("context-archive tests passed");
  } finally {
    cleanup();
  }
}

void main().catch((error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});
