import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentToolResult, LoopEvent } from "../lib/engine/loop-event.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";
import { ToolRegistry, type AnyToolDefinition } from "../lib/engine/tool-registry.ts";
import {
  WorkspaceMutationCoordinator,
  diffWorkspaceSnapshots,
  mayMutateWorkspace,
  readWorkspaceSnapshot,
  runTrackedWorkspaceMutation,
} from "../lib/engine/workspace-mutation-coordinator.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-changed-files-"));
const runGit = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

try {
  runGit(["init"]);
  runGit(["config", "user.email", "test@example.com"]);
  runGit(["config", "user.name", "DeerHux Test"]);
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(root, "pre-dirty.txt"), "base\n");
  fs.writeFileSync(path.join(root, "restore-me.txt"), "base\n");
  fs.writeFileSync(path.join(root, "sub", "nested.txt"), "base\n");
  runGit(["add", "."]);
  runGit(["commit", "-m", "initial"]);

  const baseline = await readWorkspaceSnapshot(root);
  assert.ok(baseline, "clean Git repository must return an empty snapshot");
  assert.equal(baseline.size, 0);

  fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "generated file.txt"), "generated\n");
  const current = await readWorkspaceSnapshot(root);
  assert.ok(current, "Git status must be readable after modifications");
  const changed = new Set(diffWorkspaceSnapshots(baseline, current));
  assert.ok(changed.has(path.join(root, "tracked.txt")), "modified tracked file must be detected");
  assert.ok(changed.has(path.join(root, "generated file.txt")), "untracked file with spaces must be detected");

  const nestedBefore = await readWorkspaceSnapshot(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "nested.txt"), "nested change\n");
  const nestedAfter = await readWorkspaceSnapshot(path.join(root, "sub"));
  assert.ok(
    diffWorkspaceSnapshots(nestedBefore, nestedAfter).includes(path.join(root, "sub", "nested.txt")),
    "nested session cwd must resolve porcelain paths inside that cwd",
  );

  fs.writeFileSync(path.join(root, "pre-dirty.txt"), "dirty once\n");
  const dirtyBefore = await readWorkspaceSnapshot(root);
  fs.writeFileSync(path.join(root, "pre-dirty.txt"), "dirty twice\n");
  const dirtyAfter = await readWorkspaceSnapshot(root);
  assert.ok(
    diffWorkspaceSnapshots(dirtyBefore, dirtyAfter).includes(path.join(root, "pre-dirty.txt")),
    "content fingerprint must detect a second edit while porcelain status remains M",
  );

  fs.writeFileSync(path.join(root, "restore-me.txt"), "dirty\n");
  const restoreBefore = await readWorkspaceSnapshot(root);
  fs.writeFileSync(path.join(root, "restore-me.txt"), "base\n");
  const restoreAfter = await readWorkspaceSnapshot(root);
  assert.ok(
    diffWorkspaceSnapshots(restoreBefore, restoreAfter).includes(path.join(root, "restore-me.txt")),
    "restoring a dirty file to clean must still be attributed to the tool",
  );

  const first = runTrackedWorkspaceMutation({
    cwd: root,
    signal: new AbortController().signal,
    operation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.writeFileSync(path.join(root, "session-a.txt"), "A\n");
      return "A";
    },
  });
  const second = runTrackedWorkspaceMutation({
    cwd: root,
    signal: new AbortController().signal,
    operation: async () => {
      fs.writeFileSync(path.join(root, "session-b.txt"), "B\n");
      return "B";
    },
  });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.changedFiles, [path.join(root, "session-a.txt")]);
  assert.deepEqual(b.changedFiles, [path.join(root, "session-b.txt")]);

  const coordinator = new WorkspaceMutationCoordinator();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const holding = coordinator.runExclusive(root, new AbortController().signal, async () => {
    await firstGate;
  });
  const waitingAbort = new AbortController();
  let waitingExecuted = false;
  const waiting = coordinator.runExclusive(root, waitingAbort.signal, async () => {
    waitingExecuted = true;
  });
  waitingAbort.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(waiting, /cancelled|aborted/i);
  releaseFirst();
  await holding;
  assert.equal(waitingExecuted, false, "aborted waiter must never execute its operation");
  let nextExecuted = false;
  await coordinator.runExclusive(root, new AbortController().signal, async () => {
    nextExecuted = true;
  });
  assert.equal(nextExecuted, true, "aborted waiter must not leave the workspace queue locked");

  assert.equal(mayMutateWorkspace("read"), false);
  assert.equal(mayMutateWorkspace("codegraph_search"), false);
  assert.equal(mayMutateWorkspace("bash"), true);
  assert.equal(mayMutateWorkspace("unknown_mcp_tool"), true, "unknown tools must fail closed as potential writers");

  const registry = new ToolRegistry();
  registry.register({
    name: "unknown_mcp_writer",
    label: "unknown_mcp_writer",
    description: "test writer",
    parameters: {},
    executionMode: "parallel",
    execute: async (): Promise<AgentToolResult> => {
      fs.writeFileSync(path.join(root, "executor-owned.txt"), "owned\n");
      throw new Error("failed after writing");
    },
  } as unknown as AnyToolDefinition);
  registry.setActive(["unknown_mcp_writer"]);
  const toolEvents: LoopEvent[] = [];
  const executorOutput = await new ToolExecutor(registry, { sessionId: "session-a", cwd: root }).executeBatch(
    [{ id: "tool-a", name: "unknown_mcp_writer", arguments: {} } as ToolCall],
    new AbortController().signal,
    {} as never,
    (event) => toolEvents.push(event),
  );
  assert.equal(executorOutput[0].isError, true);
  assert.deepEqual(executorOutput[0].changedFiles, [path.join(root, "executor-owned.txt")]);
  const endEvent = toolEvents.find((event) => event.type === "tool_execution_end");
  assert.ok(endEvent && endEvent.type === "tool_execution_end");
  assert.deepEqual(endEvent.changedFiles, [path.join(root, "executor-owned.txt")]);

  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-non-git-"));
  try {
    assert.equal(await readWorkspaceSnapshot(nonGit), null, "non-Git workspace must degrade to explicit paths");
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }

  console.log("turn changed files tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
