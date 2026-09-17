/**
 * 灵动岛 bridge concurrency tests.
 *
 * DeerHux runs many sessions in one Node process, so the bridge must:
 *   - keep per-session state isolated while sessions interleave,
 *   - coalesce bursts into a bounded number of IPC pushes,
 *   - send absolute timestamps (never host-computed elapsed),
 *   - drop rows when a session is destroyed,
 *   - emit `remove` before a restarted run so stale retract deadlines clear.
 *
 * A recording transport stands in for Tauri IPC: every batch the bridge would
 * have pushed is captured verbatim, so the assertions run against the real
 * flush path rather than a stubbed one.
 */

import assert from "node:assert/strict";
import { LiveIslandBridge } from "../lib/live-island-client.ts";

interface Message {
  id: string;
  type: string;
  project?: string;
  status?: string;
  detail?: string;
  startedAt?: number;
  detailStartedAt?: number;
  frozenElapsed?: number | null;
  frozenDetailElapsed?: number | null;
  delayMs?: number;
}

/** Captures the `live_island_push_events` batches and settings reads. */
function recorder(): {
  transport: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  events: () => Message[];
  batches: () => Message[][];
} {
  const batches: Message[][] = [];
  return {
    transport: async (cmd, args) => {
      if (cmd === "live_island_push_events") {
        const events = (args?.events ?? []) as Message[];
        if (events.length) batches.push(events);
        return null;
      }
      // Report the island as enabled so `init()` does not short-circuit.
      if (cmd === "get_live_island_setting_command") return true;
      return null;
    },
    events: () => batches.flat(),
    batches: () => batches,
  };
}

// ---------------------------------------------------------------------------
// 1. Concurrent sessions stay isolated
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();

  for (const [id, cwd] of [
    ["sess-a", "/work/alpha"],
    ["sess-b", "/work/beta"],
    ["sess-c", "/work/gamma"],
  ] as const) {
    bridge.trackSession(id, cwd);
  }

  // Interleave start + first tool across all three sessions.
  bridge.handleEvent("sess-a", "/work/alpha", { type: "agent_start" });
  bridge.handleEvent("sess-b", "/work/beta", { type: "agent_start" });
  bridge.handleEvent("sess-c", "/work/gamma", { type: "agent_start" });

  bridge.handleEvent("sess-a", "/work/alpha", {
    type: "tool_execution_start",
    toolName: "read",
    input: { file_path: "/work/alpha/src/index.ts" },
  });
  bridge.handleEvent("sess-b", "/work/beta", {
    type: "tool_execution_start",
    toolName: "bash",
    input: { command: "npm test" },
  });
  bridge.handleEvent("sess-c", "/work/gamma", {
    type: "tool_execution_start",
    toolName: "edit",
    input: { file_path: "/work/gamma/lib/x.ts" },
  });

  await bridge.flushNow();

  const byId = new Map<string, Message>();
  for (const message of rec.events()) byId.set(message.id, message);

  assert.equal(byId.size, 3, "三个并发 session 必须各占一行");
  assert.equal(byId.get("sess-a")?.project, "alpha", "sess-a 项目名不得被其他 session 覆盖");
  assert.equal(byId.get("sess-b")?.project, "beta");
  assert.equal(byId.get("sess-c")?.project, "gamma");
  assert.equal(byId.get("sess-a")?.status, "reading");
  assert.equal(byId.get("sess-b")?.status, "running");
  assert.equal(byId.get("sess-c")?.status, "editing");
  assert.equal(byId.get("sess-a")?.detail, "Read · index.ts", "详情应取文件 basename");

  // Absolute timestamps: the renderer computes elapsed from them, so startedAt
  // must be epoch ms.
  const startedAt = Number(byId.get("sess-a")?.startedAt);
  assert.ok(
    Number.isFinite(startedAt) && startedAt > 1_600_000_000_000,
    "startedAt 必须是绝对时间戳，而不是相对耗时",
  );
  assert.equal(
    byId.get("sess-a")?.frozenElapsed,
    null,
    "运行中的行不得冻结总耗时，否则计时器会停住",
  );
  assert.ok(
    Number.isFinite(byId.get("sess-a")?.detailStartedAt),
    "每一步（模型轮次 / 工具调用）都必须带自己的起始时间戳",
  );
  assert.equal(
    byId.get("sess-a")?.frozenDetailElapsed,
    null,
    "进行中的步骤不得冻结，否则灵动岛上的秒表不会走",
  );
}

// ---------------------------------------------------------------------------
// 2. Bursts coalesce into few pushes
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.trackSession("hot", "/work/hot");
  bridge.handleEvent("hot", "/work/hot", { type: "agent_start" });
  for (let i = 0; i < 200; i++) {
    bridge.handleEvent("hot", "/work/hot", {
      type: "tool_execution_start",
      toolName: "read",
      input: { file_path: `/work/hot/file-${i}.ts` },
    });
  }
  await bridge.flushNow();

  const batches = rec.batches();
  assert.ok(
    batches.length <= 3,
    `200 次工具事件必须合并成少量批次，实际 ${batches.length} 批`,
  );
  const messages = rec.events();
  const last = messages[messages.length - 1];
  assert.equal(last.id, "hot");
  assert.equal(last.detail, "Read · file-199.ts", "合并后应保留最新状态");
}

// ---------------------------------------------------------------------------
// 2b. Each model round and tool call restarts the step clock
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.trackSession("step", "/work/step");
  bridge.handleEvent("step", "/work/step", { type: "agent_start" });
  await bridge.flushNow();

  const turnStart = rec.events().filter((m) => m.id === "step" && m.type === "update").pop();
  assert.equal(turnStart?.detail, "Thinking · DeerHux", "回合开始应计时模型思考");

  bridge.handleEvent("step", "/work/step", { type: "message_start" });
  await bridge.flushNow();
  const roundStart = rec.events().filter((m) => m.id === "step").pop();
  assert.ok(
    typeof roundStart?.detailStartedAt === "number",
    "每个模型轮次必须有独立的起始时间戳",
  );

  bridge.handleEvent("step", "/work/step", { type: "message_end" });
  await bridge.flushNow();
  const roundEnd = rec.events().filter((m) => m.id === "step").pop();
  assert.ok(
    typeof roundEnd?.frozenDetailElapsed === "number",
    "模型轮次结束时必须冻结该轮计时（工具调用前的等待不计入）",
  );

  const beforeTool = rec.events().length;
  bridge.handleEvent("step", "/work/step", {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    input: { file_path: "/work/step/a.ts" },
  });
  await bridge.flushNow();
  const toolStart = rec.events().slice(beforeTool).filter((m) => m.id === "step").pop();
  assert.equal(toolStart?.detail, "Read · a.ts");
  assert.equal(
    toolStart?.frozenDetailElapsed,
    null,
    "新的工具调用必须让计时从 0 重新开始，而不是沿用上一段",
  );
  assert.ok(
    typeof toolStart?.detailStartedAt === "number",
    "工具调用也必须带自己的起始时间戳",
  );

  const beforeDone = rec.events().length;
  bridge.handleEvent("step", "/work/step", {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
  });
  await bridge.flushNow();
  const toolEnd = rec.events().slice(beforeDone).filter((m) => m.id === "step").pop();
  assert.ok(
    typeof toolEnd?.frozenDetailElapsed === "number",
    "工具结束后必须冻结该工具调用的耗时，直到下一步开始",
  );

  const beforeNext = rec.events().length;
  bridge.handleEvent("step", "/work/step", { type: "message_start" });
  await bridge.flushNow();
  const nextRound = rec.events().slice(beforeNext).filter((m) => m.id === "step").pop();
  assert.equal(nextRound?.frozenDetailElapsed, null, "下一个模型轮次必须重新计时");
  assert.equal(nextRound?.detail, "Thinking · DeerHux");
}

// ---------------------------------------------------------------------------
// 3. Restart clears the stale retract deadline; done freezes elapsed
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.trackSession("loop", "/work/loop");
  bridge.handleEvent("loop", "/work/loop", { type: "agent_start" });
  bridge.handleEvent("loop", "/work/loop", { type: "agent_end" });
  await bridge.flushNow();

  const afterEnd = rec.events();
  const doneMessage = afterEnd.find((m) => m.status === "done");
  assert.ok(doneMessage, "agent_end 后应发送 done 行");
  assert.ok(
    typeof doneMessage.frozenElapsed === "number",
    "done 行必须携带冻结耗时，避免继续走时",
  );
  assert.ok(
    typeof doneMessage.frozenDetailElapsed === "number",
    "done 行必须冻结最后一步的计时读数",
  );
  assert.ok(
    afterEnd.some((m) => m.type === "done-retract"),
    "agent_end 后应安排延迟回收",
  );

  const before = rec.events().length;
  bridge.handleEvent("loop", "/work/loop", { type: "agent_start" });
  await bridge.flushNow();
  const afterRestart = rec.events().slice(before);
  assert.equal(
    afterRestart[0]?.type,
    "remove",
    "同一 session 重新开始时必须先 remove，清除上一次的回收倒计时",
  );
}

// ---------------------------------------------------------------------------
// 4. Completed sessions are not resurrected by later reconnect baselines
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.trackSession("done", "/work/done");
  bridge.trackSession("active", "/work/active");
  bridge.handleEvent("done", "/work/done", { type: "agent_start" });
  bridge.handleEvent("active", "/work/active", { type: "agent_start" });
  await bridge.flushNow();

  bridge.handleEvent("done", "/work/done", { type: "agent_end" });
  await bridge.flushNow();

  const before = rec.batches().length;
  bridge.handleEvent("active", "/work/active", {
    type: "tool_execution_start",
    toolName: "read",
    input: { file_path: "/work/active/index.ts" },
  });
  await bridge.flushNow();

  const laterBaseline = rec.batches().slice(before).flat();
  assert.ok(laterBaseline.some((event) => event.id === "active"));
  assert.ok(
    !laterBaseline.some((event) => event.id === "done"),
    "已完成 session 不得被后续基线重新创建",
  );
}

// ---------------------------------------------------------------------------
// 5. Destroyed sessions release their row
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  for (let i = 0; i < 50; i++) {
    bridge.trackSession(`temp-${i}`, `/work/temp-${i}`);
    bridge.handleEvent(`temp-${i}`, `/work/temp-${i}`, { type: "agent_start" });
  }
  bridge.releaseSession("temp-7");
  await bridge.flushNow();

  const removed = rec.events().filter((m) => m.id === "temp-7");
  assert.equal(
    removed[removed.length - 1]?.type,
    "remove",
    "销毁的 session 必须移除，避免长时间运行后行数泄漏",
  );
}

// ---------------------------------------------------------------------------
// 6. Unknown sessions auto-track instead of being dropped
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.handleEvent("resumed", "/work/resumed", {
    type: "tool_execution_start",
    toolName: "bash",
    input: { command: "ls" },
  });
  await bridge.flushNow();
  const message = rec.events().find((m) => m.id === "resumed");
  assert.ok(message, "未 track 的 session 应自动补登记");
  assert.equal(message.status, "running");
}

// ---------------------------------------------------------------------------
// 7. Each batch is a complete reconnect baseline
// ---------------------------------------------------------------------------

{
  const rec = recorder();
  const bridge = new LiveIslandBridge(rec.transport);
  await bridge.init();
  bridge.trackSession("base-a", "/work/base-a");
  bridge.trackSession("base-b", "/work/base-b");
  bridge.handleEvent("base-a", "/work/base-a", { type: "agent_start" });
  bridge.handleEvent("base-b", "/work/base-b", { type: "agent_start" });
  await bridge.flushNow();

  const before = rec.batches().length;
  bridge.handleEvent("base-a", "/work/base-a", {
    type: "tool_execution_start",
    toolName: "read",
    input: { file_path: "/work/base-a/only-a.ts" },
  });
  await bridge.flushNow();
  const reconnectBatch = rec.batches().slice(before).flat();
  assert.ok(reconnectBatch.some((event) => event.id === "base-a"), "基线必须包含变更行");
  assert.ok(reconnectBatch.some((event) => event.id === "base-b"), "基线必须包含未变更的并发行");
}

console.log("灵动岛 bridge concurrency tests passed");
