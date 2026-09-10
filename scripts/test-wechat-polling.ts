import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-wechat-polling-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { WeChatBotService, getWeChatBotService, resetWeChatBotService } = await import("../lib/wechat-bot.ts");
type Update = { ret: number; errcode?: number; msgs?: unknown[] };
function mockApi(bot: InstanceType<typeof WeChatBotService>, getUpdates: () => Promise<Update>) {
  (bot as unknown as { api: unknown }).api = { getUpdates };
}
const creds = { botToken: "fixture", baseUrl: "http://127.0.0.1:1", accountId: "bot", userId: "user" };
try {
  const bot = new WeChatBotService(root);
  bot.loginWithCredentials(creds);
  mockApi(bot, async () => ({ ret: -14, errcode: -14 }));
  await bot.startPolling();
  assert.equal(bot.getStatus().connected, false, "expired credentials cannot report connected");
  assert.equal(bot.getStatus().polling, false);
  assert.match(bot.getStatus().lastError ?? "", /过期/);

  bot.loginWithCredentials(creds);
  let calls = 0;
  let resolveOld!: (update: Update) => void;
  let resolveNew!: (update: Update) => void;
  mockApi(bot, () => {
    calls++;
    return new Promise((resolve) => { if (calls === 1) resolveOld = resolve; else resolveNew = resolve; });
  });
  const oldLoop = bot.startPolling();
  await bot.startPolling();
  assert.equal(calls, 1, "starting an active receiver does not duplicate polling");
  bot.stopPolling();
  const newLoop = bot.startPolling();
  assert.equal(calls, 2);
  resolveOld({ ret: -14, errcode: -14 });
  await oldLoop;
  assert.equal(bot.getStatus().connected, true, "late expiration from stopped receiver cannot clear current credentials");
  assert.equal(bot.getStatus().polling, true);
  bot.stopPolling();
  resolveNew({ ret: 0 });
  await newLoop;

  // 仅拦截内存中的假凭证请求，不访问真实微信。
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json(url.endsWith("getconfig") ? { ret: 0, typing_ticket: "ticket" } : { ret: 0 });
  };
  try {
    const transportBot = new WeChatBotService(root);
    transportBot.loginWithCredentials(creds);
    const api = (transportBot as unknown as { api: { sendMessage: (user: string, text: string, context: string) => Promise<unknown>; sendTyping: (user: string, status: 1 | 2) => Promise<void> } }).api;
    await api.sendMessage("recipient", "reply", "context");
    assert.deepEqual(requests[0].body.msg && {
      from: (requests[0].body.msg as Record<string, unknown>).from_user_id,
      to: (requests[0].body.msg as Record<string, unknown>).to_user_id,
      context: (requests[0].body.msg as Record<string, unknown>).context_token,
    }, { from: "", to: "recipient", context: "context" });
    await api.sendTyping("recipient", 1);
    await api.sendTyping("recipient", 2);
    await api.sendTyping("other-recipient", 1);
    const configs = requests.filter((r) => r.url.endsWith("getconfig"));
    assert.equal(configs.length, 2, "typing tickets are cached per recipient");
    assert.equal(configs[0].body.ilink_user_id, "recipient");
    assert.equal(configs[1].body.ilink_user_id, "other-recipient");
  } finally { globalThis.fetch = originalFetch; }

  const first = getWeChatBotService(root);
  assert.equal(first, globalThis.__deerhuxWeChatBotService);
  assert.equal(first, getWeChatBotService(root), "all consumers share process-level service");
  resetWeChatBotService();
  assert.notEqual(first, getWeChatBotService(root));
  console.log("微信监听测试通过：登录过期、重复启动、重启后的迟到响应、进程级单例与重置。");
} finally {
  resetWeChatBotService();
  await fs.rm(root, { recursive: true, force: true });
}
