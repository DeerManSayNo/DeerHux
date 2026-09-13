import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { AgentToolResult, LoopEvent } from "../lib/engine/loop-event.ts";
import { ToolExecutor } from "../lib/engine/tool-executor.ts";
import { ToolRegistry, type AnyToolDefinition } from "../lib/engine/tool-registry.ts";
import { createStandardCodingTools } from "../lib/engine/coding-tools.ts";
import { resolveChangedFilePath } from "../lib/changed-file-path.ts";
import { fileChangeKind, mergeFileChanges, readFileChanges } from "../lib/file-changes.ts";
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
    const outside = path.join(nonGit, "外部 file.txt");
    assert.equal(resolveChangedFilePath(outside, root), outside);
    assert.equal(resolveChangedFilePath(path.relative(root, outside), root), outside);
    assert.equal(resolveChangedFilePath("\0bad", root), null);
    assert.equal(resolveChangedFilePath(".", root), null);

    const standardRegistry = new ToolRegistry();
    for (const tool of createStandardCodingTools(root)) standardRegistry.register(tool);
    standardRegistry.setActive(["read", "write", "edit", "bash"]);
    const standardExecutor = new ToolExecutor(standardRegistry, { cwd: root });
    const execute = async (name: string, args: Record<string, unknown>) => {
      const events: LoopEvent[] = [];
      const [output] = await standardExecutor.executeBatch(
        [{ id: `external-${name}`, name, arguments: args } as ToolCall],
        new AbortController().signal, {} as never, (event) => events.push(event),
      );
      const end = events.find((event) => event.type === "tool_execution_end");
      assert.ok(end && end.type === "tool_execution_end");
      assert.deepEqual(end.changedFiles, output.changedFiles, "verified paths must reach the SSE source event");
      assert.deepEqual(end.fileChanges, output.fileChanges, "change kinds must reach the SSE source event");
      return output;
    };
    const addedOutput = await execute("write", { filePath: outside, content: "original" });
    assert.deepEqual(addedOutput.changedFiles, [outside]);
    assert.deepEqual(addedOutput.fileChanges?.map(fileChangeKind), ["added"]);
    const editedOutput = await execute("edit", { path: path.relative(root, outside), oldString: "original", newString: "updated" });
    assert.deepEqual(editedOutput.changedFiles, [outside]);
    assert.deepEqual(editedOutput.fileChanges?.map(fileChangeKind), ["modified"]);
    assert.deepEqual(mergeFileChanges(addedOutput.fileChanges!, editedOutput.fileChanges!).map(fileChangeKind), ["added"]);
    const failedEdit = await execute("edit", { filePath: outside, oldString: "not present", newString: "wrong" });
    assert.equal(failedEdit.isError, true);
    assert.equal(failedEdit.changedFiles, undefined, "failed edit must not claim its target");
    assert.equal((await execute("read", { filePath: outside })).changedFiles, undefined);

    const created = path.join(nonGit, "新增.txt");
    const unrelated = path.join(nonGit, "unrelated.txt");
    fs.writeFileSync(unrelated, "pre-existing dirty content");
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const mixed = await execute("bash", {
      command: `printf created > ${quote(created)}; rm ${quote(outside)}`,
      affectedFiles: [created, outside, unrelated, created],
    });
    assert.deepEqual(new Set(mixed.changedFiles), new Set([created, outside]), "shell creation/deletion exclude unchanged and unrelated files");
    assert.deepEqual(new Map(mixed.fileChanges?.map((change) => [change.filePath, fileChangeKind(change)])), new Map([[created, "added"], [outside, "deleted"]]));
    assert.equal(fileChangeKind(mergeFileChanges(
      [{ filePath: outside, beforeExists: true, afterExists: false }],
      [{ filePath: outside, beforeExists: false, afterExists: true }],
    )[0]), "modified", "delete then recreate an original file remains modified");
    assert.deepEqual(readFileChanges([null, {}, { filePath: outside, beforeExists: "false", afterExists: true }]), []);
    assert.equal(resolveChangedFilePath(outside, root), outside, "deleted files remain valid list entries");
    assert.equal((await execute("bash", { command: "true", affectedFiles: [created, outside] })).changedFiles, undefined);
    const moved = path.join(nonGit, "renamed.txt");
    assert.deepEqual(new Set((await execute("bash", {
      command: `mv ${quote(created)} ${quote(moved)}`,
      affectedFiles: [created, moved],
    })).changedFiles), new Set([created, moved]));
    assert.deepEqual((await execute("bash", {
      command: `printf partial > ${quote(moved)}; exit 1`, affectedFiles: [moved],
    })).changedFiles, [moved], "nonzero shell exit must retain actual changes");

    const partialRegistry = new ToolRegistry();
    partialRegistry.register({ name: "write", parameters: {}, execute: async () => {
      fs.writeFileSync(outside, "partial");
      throw new Error("failed after external write");
    } } as unknown as AnyToolDefinition);
    partialRegistry.setActive(["write"]);
    const [partial] = await new ToolExecutor(partialRegistry, { cwd: nonGit }).executeBatch(
      [{ type: "toolCall", id: "partial", name: "write", arguments: { filePath: outside } } as ToolCall],
      new AbortController().signal, {} as never, () => {},
    );
    assert.equal(partial.isError, true);
    assert.deepEqual(partial.changedFiles, [outside], "partial failures are detected even without Git");

    // 不同项目同时声明同一外部文件：第二个只读操作不能认领第一个的修改。
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const writer = runTrackedWorkspaceMutation({ cwd: root, filePaths: [outside], signal: new AbortController().signal, operation: async () => {
      entered();
      await mayFinish;
      fs.writeFileSync(outside, "only writer");
    } });
    await firstEntered;
    const reader = runTrackedWorkspaceMutation({ cwd: nonGit, filePaths: [outside], signal: new AbortController().signal, operation: async () => {} });
    release();
    const [writerResult, readerResult] = await Promise.all([writer, reader]);
    assert.deepEqual(writerResult.changedFiles, [outside]);
    assert.deepEqual(readerResult.changedFiles, []);

    // 目标所在项目的普通 shell 快照（不显式声明文件）也不能认领外部写入。
    execFileSync("git", ["init"], { cwd: nonGit, stdio: "ignore" });
    let snapshotEntered!: () => void;
    const snapshotReady = new Promise<void>((resolve) => { snapshotEntered = resolve; });
    let endSnapshot!: () => void;
    const snapshotMayEnd = new Promise<void>((resolve) => { endSnapshot = resolve; });
    const otherProject = runTrackedWorkspaceMutation({ cwd: nonGit, signal: new AbortController().signal, operation: async () => {
      snapshotEntered();
      await snapshotMayEnd;
    } });
    await snapshotReady;
    const externalWriter = runTrackedWorkspaceMutation({ cwd: root, filePaths: [outside], signal: new AbortController().signal, operation: async () => {
      fs.writeFileSync(outside, "external writer owns this");
    } });
    endSnapshot();
    const [otherProjectResult, externalWriterResult] = await Promise.all([otherProject, externalWriter]);
    assert.deepEqual(otherProjectResult.changedFiles, []);
    assert.deepEqual(externalWriterResult.changedFiles, [outside]);
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }

  console.log("turn changed files tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
