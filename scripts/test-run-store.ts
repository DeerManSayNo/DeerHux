import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunStore } from "../lib/agent-runtime/run-store.ts";
import { isTerminalAgentRunStatus } from "../lib/agent-runtime/run-types.ts";

const dir = mkdtempSync(path.join(tmpdir(), "deerhux-run-store-"));
try {
  // ── Phase A（epoch_alpha，模拟进程崩溃前）────────────────────────
  const store = new AgentRunStore(dir, "epoch_alpha");

  // 1. create → accepted，字段完整落盘。
  const record = store.create({
    runId: "run_sess1_t1",
    sessionId: "sess1",
    turnId: "sess1:t1",
    clientMessageId: "cmid-1",
    model: { provider: "zenmux", modelId: "test-model" },
  });
  assert.equal(record.status, "accepted");
  assert.equal(record.ownerEpoch, "epoch_alpha");
  assert.equal(record.ownerProcessId, process.pid);

  // 2. 生命周期推进：accepted → preparing → running → succeeded。
  store.transition("run_sess1_t1", { status: "preparing", lastEventType: "prompt_preparing" });
  const running = store.transition("run_sess1_t1", { status: "running", lastEventType: "agent_start" });
  assert.ok(running.startedAt, "running transition should stamp startedAt");
  const succeeded = store.transition("run_sess1_t1", {
    status: "succeeded",
    lastEventType: "agent_end",
  });
  assert.ok(succeeded.endedAt, "terminal transition should stamp endedAt");
  assert.ok(isTerminalAgentRunStatus(succeeded.status));

  // 3. 终态后禁止再次转移。
  assert.throws(
    () => store.transition("run_sess1_t1", { status: "failed" }),
    /Cannot transition terminal agent run/,
  );

  // 4. failed 转移记录 errorCode / error。
  store.create({ runId: "run_sess1_t2", sessionId: "sess1", turnId: "sess1:t2" });
  store.transition("run_sess1_t2", { status: "running", lastEventType: "agent_start" });
  const failedTerminal = store.transition("run_sess1_t2", {
    status: "failed",
    lastEventType: "agent_end",
    errorCode: "SESSION_PERSIST_FAILED",
    error: "append_message failed",
  });
  assert.equal(failedTerminal.errorCode, "SESSION_PERSIST_FAILED");
  assert.equal(failedTerminal.error, "append_message failed");

  // 5. 模拟进程崩溃：t3 停留在 running（非终态）。
  store.create({ runId: "run_sess1_t3", sessionId: "sess1", turnId: "sess1:t3" });
  store.transition("run_sess1_t3", { status: "running", lastEventType: "message_update" });
  assert.equal(store.getLatestForSession("sess1")?.runId, "run_sess1_t3");

  // ── Phase B（epoch_beta，进程重启后接管）──────────────────────────
  const restarted = new AgentRunStore(dir, "epoch_beta");
  // 当前 epoch 自己的新 run 不应被 reconcile 误伤。
  restarted.create({ runId: "run_sess1_t4", sessionId: "sess1", turnId: "sess1:t4" });
  restarted.transition("run_sess1_t4", { status: "running", lastEventType: "message_update" });

  const reconciled = restarted.reconcileInterruptedRuns();
  assert.deepEqual(
    reconciled.map((item) => item.runId),
    ["run_sess1_t3"],
  );
  const interrupted = restarted.get("run_sess1_t3");
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.errorCode, "RUNTIME_RESTARTED");
  assert.ok(interrupted?.error?.includes("restarted"));
  // 旧 epoch 的终态 run 与新 epoch 的运行中 run 均保持原状。
  assert.equal(restarted.get("run_sess1_t1")?.status, "succeeded");
  assert.equal(restarted.get("run_sess1_t2")?.status, "failed");
  assert.equal(restarted.get("run_sess1_t4")?.status, "running");

  // 二次 reconcile 幂等：已收敛为 interrupted 的不再重复转移。
  assert.equal(restarted.reconcileInterruptedRuns().length, 0);

  // ── Phase C（epoch_gamma，按 sessionId 过滤收敛）──────────────────
  restarted.create({ runId: "run_sess2_t1", sessionId: "sess2", turnId: "sess2:t1" });
  restarted.transition("run_sess2_t1", { status: "running", lastEventType: "message_update" });
  const scoped = new AgentRunStore(dir, "epoch_gamma").reconcileInterruptedRuns("sess2");
  assert.deepEqual(
    scoped.map((item) => item.runId),
    ["run_sess2_t1"],
  );
  assert.equal(
    new AgentRunStore(dir, "epoch_delta").get("run_sess2_t1")?.status,
    "interrupted",
  );

  // 7. 写入是原子替换：目录中不残留 .tmp 文件，目标文件是合法 JSON。
  const files = readdirSync(path.join(dir, "runs"));
  assert.equal(files.filter((file) => file.endsWith(".tmp")).length, 0);
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(path.join(dir, "runs", file), "utf8"));
    assert.equal(parsed.version, 1);
  }

  // 8. 损坏文件读取返回 null 而不是抛错。
  writeFileSync(
    path.join(dir, "runs", "run_corrupt.json"),
    "{not-valid-json",
    "utf8",
  );
  assert.equal(new AgentRunStore(dir, "epoch_epsilon").get("run_corrupt"), null);

  // 9. TTL 清理：终态且 endedAt 超过 TTL 的被删除；新近终态与非终态保留。
  {
    const ttlStore = new AgentRunStore(dir, "epoch_zeta");
    ttlStore.create({ runId: "run_old_done", sessionId: "sess9", turnId: "sess9:t1" });
    ttlStore.transition("run_old_done", { status: "succeeded", lastEventType: "agent_end" });
    // 手工把 endedAt 改到 8 天前（TTL 默认 7 天）。
    const aged = { ...ttlStore.get("run_old_done")!, endedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() };
    writeFileSync(path.join(dir, "runs", "run_old_done.json"), JSON.stringify(aged), "utf8");
    ttlStore.create({ runId: "run_fresh_done", sessionId: "sess9", turnId: "sess9:t2" });
    ttlStore.transition("run_fresh_done", { status: "succeeded", lastEventType: "agent_end" });
    ttlStore.create({ runId: "run_old_active", sessionId: "sess9", turnId: "sess9:t3" });
    // 非终态但 updatedAt 老：不清理（reconcile 负责），且 run_old_active 本 epoch 创建不收敛。
    const removed = ttlStore.pruneExpiredRuns();
    assert.equal(removed, 1);
    assert.equal(ttlStore.get("run_old_done"), null);
    assert.equal(ttlStore.get("run_fresh_done")?.status, "succeeded");
    assert.equal(ttlStore.get("run_old_active")?.status, "accepted");
  }

  console.log("agent run store tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
