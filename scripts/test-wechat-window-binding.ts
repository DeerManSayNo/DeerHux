import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-wechat-binding-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { WeChatBotService, WeChatBindingError } = await import("../lib/wechat-bot.ts");
const { POST } = await import("../app/api/remote-connections/route.ts");
try {
  const dir = path.join(root, "wechat");
  await fs.mkdir(dir, { recursive: true });
  const sessionDir = path.join(root, "sessions", "--fixture--");
  await fs.mkdir(sessionDir, { recursive: true });
  const records = [];
  for (const id of ["window-a", "window-b"]) {
    const file = path.join(sessionDir, `${id}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n");
    records.push({ id, path: file, cwd: root, created: "2026-01-01", modified: "2026-01-01", messageCount: 0, firstMessage: "", sizeBytes: 100, indexedAt: "2026-01-01" });
  }
  await fs.writeFile(path.join(root, "session-index.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), records }));
  await fs.writeFile(path.join(dir, "credentials.json"), JSON.stringify({ botToken: "fixture", baseUrl: "http://127.0.0.1:1", accountId: "bot", userId: "owner" }));
  await fs.writeFile(path.join(dir, "context-tokens.json"), JSON.stringify({ "bot:alice": "fixture", "bot:bob": "fixture", "other:charlie": "fixture" }));
  const bot = new WeChatBotService(root);
  let starts = 0;
  bot.startPolling = async () => { starts++; };
  assert.deepEqual(bot.getConnections(), { alice: "", bob: "" });
  await bot.bindSession("alice", "window-a", "");
  assert.equal(bot.getConnections().alice, "window-a");
  assert.equal(starts, 1, "binding automatically starts the receiver");
  await assert.rejects(bot.bindSession("unknown", "window-b", ""), (e) => e instanceof WeChatBindingError && e.status === 404);
  await assert.rejects(bot.bindSession("alice", "missing", "window-a"), (e) => e instanceof WeChatBindingError && e.status === 404);
  await assert.rejects(bot.bindSession("alice", "window-b", ""), (e) => e instanceof WeChatBindingError && e.status === 409);
  await assert.rejects(bot.bindSession("bob", "window-a", ""), (e) => e instanceof WeChatBindingError && e.status === 409);
  const state = bot as unknown as { processingUsers: Set<string>; messageQueues: Map<string, unknown[]> };
  state.processingUsers.add("alice");
  await assert.rejects(bot.bindSession("alice", "window-b", "window-a"), /正在处理/);
  assert.throws(() => bot.unbindSession("alice", "window-a"), /正在处理/);
  state.processingUsers.clear();
  state.messageQueues.set("alice", [{}]);
  await assert.rejects(bot.bindSession("alice", "window-b", "window-a"), /正在处理/);
  state.messageQueues.clear();
  await bot.bindSession("alice", "window-b", "window-a");
  assert.equal(new WeChatBotService(root).getConnections().alice, "window-b", "bindings survive service restart");
  assert.throws(() => bot.unbindSession("alice", "window-a"), /绑定已变化/);
  bot.unbindSession("alice", "window-b");
  assert.equal(bot.getConnections().alice, "", "unbinding retains selectable endpoint");
  const results = await Promise.allSettled([bot.bindSession("alice", "window-a", ""), bot.bindSession("alice", "window-b", "")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "concurrent stale writes cannot overwrite one another");
  for (const body of [null, {}, { action: "bind", userId: 1, sessionId: "x" }]) {
    const response = await POST(new Request("http://localhost/api/remote-connections", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
  assert.equal((await POST(new Request("http://localhost/api/remote-connections", { method: "POST", body: "{" }))).status, 400);
  console.log("微信窗口绑定验证通过：绑定、切换、解除、恢复、未知端、缺失会话、重复窗口、忙碌队列、并发冲突和接口参数。");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
