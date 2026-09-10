/**
 * 微信 iLink Bot 服务
 *
 * 零外部依赖，直接调用 iLink API (ilinkai.weixin.qq.com)。
 * 扫码登录 → 长轮询接收消息 → 路由到 AgentSession → 收集回复 → 发回微信。
 *
 * 协议参考: https://github.com/corespeed-io/wechatbot/blob/main/docs/protocol.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { WeChatTypingIndicators } from "./wechat-typing";
import { randomUUID } from "node:crypto";
import { getAgentEventStore } from "./agent-runtime/event-store";
import { WeChatSessionMirror, WECHAT_MESSAGE_PREFIX, type WeChatToolProgress } from "./wechat-session-mirror";
import { getAgentDir, resolveSessionPath } from "./session-reader";
import { startRpcSession, getRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { ensureRpcSession } from "./agent-runtime/session-service";

// ============================================================================
// 配置
// ============================================================================

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3"; // AI bot 类型
const CHANNEL_VERSION = " ";

function getWechatDataDir(): string {
  const dir = join(getAgentDir(), "wechat");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getScheduledTasksCwd(): string {
  const dir = join(getAgentDir(), "scheduled-tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getCredentialsPath(): string {
  return join(getWechatDataDir(), "credentials.json");
}

function getSyncBufPath(): string {
  return join(getWechatDataDir(), "sync-buf.txt");
}

function getUserSessionsPath(): string {
  return join(getWechatDataDir(), "user-sessions.json");
}

function getContextTokensPath(): string {
  return join(getWechatDataDir(), "context-tokens.json");
}

// ============================================================================
// 类型
// ============================================================================

export interface WeChatCredentials {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
}

export interface WeChatStatus {
  connected: boolean;
  polling: boolean;
  accountId?: string;
  qrcodeUrl?: string;
  loginStatus?: "wait" | "scaned" | "confirmed" | "expired" | "error";
  loginError?: string;
  activeUserCount?: number;
  lastError?: string;
  lastPollAt?: string;
  lastReceivedAt?: string;
  lastRepliedAt?: string;
  desktopSyncEnabled?: boolean;
}

/** iLink 入站消息 */
interface WeixinMessage {
  from_user_id: string;
  to_user_id: string;
  msg_id: string;
  message_type: number;
  context_token: string;
  item_list: MessageItem[];
}

interface MessageItem {
  type: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text: string };
  image_item?: CDNMedia;
  voice_item?: CDNMedia & { recognize_text?: string };
  file_item?: CDNMedia & { file_name?: string };
  video_item?: CDNMedia;
}

interface CDNMedia {
  aes_key: string;
  cdn_media_buf: string;
  file_size?: number;
}

// ============================================================================
// 工具函数
// ============================================================================

function randomUint32(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": base64Encode(String(randomUint32())),
  };
}

function extractText(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
    // 语音消息：使用识别文本
    if (item.type === 3 && item.voice_item?.recognize_text) {
      return item.voice_item.recognize_text;
    }
  }
  return "";
}

function buildMessageDedupKey(msg: WeixinMessage, text: string): string | null {
  const msgId = typeof msg.msg_id === "string" ? msg.msg_id.trim() : "";
  const contextToken = typeof msg.context_token === "string" ? msg.context_token.trim() : "";

  // Some iLink responses do not provide a per-message-unique msg_id. Treat a
  // bare/missing msg_id as unsafe for de-duplication; the server cursor is the
  // primary guard against replay.
  if (!msgId) return null;

  return [
    msgId,
    msg.from_user_id,
    contextToken,
    text,
  ].join("\0");
}

function rememberSeenKey(seen: Map<string, number>, key: string, now = Date.now()): boolean {
  const lastSeenAt = seen.get(key);
  if (lastSeenAt && now - lastSeenAt < 60_000) return false;
  seen.set(key, now);
  return true;
}

// ============================================================================
// 凭证持久化
// ============================================================================

function loadCredentials(): WeChatCredentials | null {
  try {
    const raw = readFileSync(getCredentialsPath(), "utf-8");
    const data = JSON.parse(raw);
    if (data.botToken && data.accountId) return data;
  } catch {
    // 文件不存在或格式错误
  }
  return null;
}

function saveCredentials(creds: WeChatCredentials): void {
  writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), "utf-8");
}

function clearCredentials(): void {
  try { unlinkSync(getCredentialsPath()); } catch { /* ignore */ }
}

function loadSyncBuf(): string | undefined {
  try {
    return readFileSync(getSyncBufPath(), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveSyncBuf(buf: string): void {
  writeFileSync(getSyncBufPath(), buf, "utf-8");
}

// ============================================================================
// 用户 → session 映射
// ============================================================================

function loadUserSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getUserSessionsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveUserSessions(map: Record<string, string>): void {
  writeFileSync(getUserSessionsPath(), JSON.stringify(map, null, 2), "utf-8");
}

function loadContextTokens(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getContextTokensPath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveContextTokens(map: Record<string, string>): void {
  writeFileSync(getContextTokensPath(), JSON.stringify(map, null, 2), "utf-8");
}

function clearContextTokens(): void {
  try { unlinkSync(getContextTokensPath()); } catch { /* ignore */ }
}

// ============================================================================
// iLink API 客户端
// ============================================================================

class ILlinkApiClient {
  private token: string;
  private baseUrl: string;
  private typingTickets = new Map<string, string>();

  constructor(token: string, baseUrl: string, _botId = "") {
    this.token = token;
    this.baseUrl = baseUrl || ILINK_BASE_URL;
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** 获取二维码 */
  async getQRCode(botType = BOT_TYPE): Promise<{ qrcode: string; qrcode_img_content: string }> {
    const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${botType}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`获取二维码失败: ${resp.status}`);
    return resp.json();
  }

  /** 轮询二维码状态 */
  async getQRCodeStatus(qrcode: string): Promise<{
    status: "wait" | "scaned" | "confirmed" | "expired";
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
    baseurl?: string;
  }> {
    const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const resp = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" } });
    if (!resp.ok) throw new Error(`查询二维码状态失败: ${resp.status}`);
    return resp.json();
  }

  /** 长轮询获取消息 */
  async getUpdates(syncBuf: string, timeoutMs = 35000): Promise<{
    ret: number;
    errcode?: number;
    msgs?: WeixinMessage[];
    get_updates_buf?: string;
  }> {
    const baseInfo = { channel_version: CHANNEL_VERSION };
    const body = JSON.stringify({ get_updates_buf: syncBuf, base_info: baseInfo });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 5000);

    try {
      const resp = await fetch(`${this.baseUrl}/ilink/bot/getupdates`, {
        method: "POST",
        headers: buildHeaders(this.token),
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`getUpdates 失败: ${resp.status}`);
      return resp.json();
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ret: 0, get_updates_buf: syncBuf };
      }
      throw err;
    }
  }

  /** 获取 typing ticket，用于向微信展示“正在输入中” */
  private async getTypingTicket(toUserId: string): Promise<string> {
    const cached = this.typingTickets.get(toUserId);
    if (cached) return cached;

    const body = JSON.stringify({
      ilink_user_id: toUserId,
      base_info: { channel_version: CHANNEL_VERSION },
    });
    const resp = await fetch(`${this.baseUrl}/ilink/bot/getconfig`, {
      method: "POST",
      headers: buildHeaders(this.token),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`获取 typing_ticket 失败: ${resp.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`);
    }

    const result = await resp.json() as { typing_ticket?: string; ret?: number; errcode?: number; errmsg?: string };
    if (!result.typing_ticket) {
      throw new Error(`获取 typing_ticket 失败: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg ?? ""}`);
    }

    this.typingTickets.set(toUserId, result.typing_ticket);
    return result.typing_ticket;
  }

  /** 发送“正在输入中”状态：1=开始，2=结束 */
  async sendTyping(toUserId: string, status: 1 | 2): Promise<void> {
    const typingTicket = await this.getTypingTicket(toUserId);
    const body = JSON.stringify({
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: CHANNEL_VERSION },
    });

    const resp = await fetch(`${this.baseUrl}/ilink/bot/sendtyping`, {
      method: "POST",
      headers: buildHeaders(this.token),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`发送 typing 状态失败: ${resp.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`);
    }

    const result = await resp.json() as { ret?: number; errcode?: number; errmsg?: string };
    if (result.ret !== 0 && result.ret !== undefined) {
      if (status === 1) this.typingTickets.delete(toUserId);
      throw new Error(`发送 typing 状态失败: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg ?? ""}`);
    }
  }

  async sendProgress(toUserId: string, progress: WeChatToolProgress, contextToken: string, runId: string): Promise<void> {
    // 原生 type 11/12 在部分微信客户端不可见，使用普通文本保证进度可见。
    const label = !progress.status ? "正在执行" : progress.status === "completed" ? "执行完成" : progress.status === "failed" ? "执行失败" : "执行已结束（结果未确认）";
    await this.sendItem(toUserId, {
      type: 1, text_item: { text: `【工具进度】${label}：${progress.toolName}` },
    }, contextToken, runId);
  }

  /** 发送文本消息 */
  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string,
  ): Promise<{ ret: number; errcode?: number; errmsg?: string }> {
    return this.sendItem(toUserId, { type: 1, text_item: { text } }, contextToken);
  }

  private async sendItem(toUserId: string, item: object, contextToken: string, runId?: string): Promise<{ ret: number; errcode?: number; errmsg?: string }> {
    const clientId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const body = JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [item],
        ...(runId ? { run_id: runId } : {}),
      },
      base_info: { channel_version: CHANNEL_VERSION },
    });

    const resp = await fetch(`${this.baseUrl}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: buildHeaders(this.token),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => "");
      throw new Error(`发送消息失败: ${resp.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`);
    }
    const responseText = await resp.text();
    let result: { ret: number; errcode?: number; errmsg?: string };
    try {
      result = JSON.parse(responseText);
      if (!result || typeof result !== "object") throw new Error("invalid response");
    } catch {
      throw new Error(`发送消息失败：HTTP ${resp.status}，${responseText.trim() ? "响应不是有效 JSON" : "响应为空"}`);
    }
    if (result.ret !== 0 && result.ret !== undefined) {
      throw new Error(`发送消息失败: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg ?? ""}`);
    }
    return result;
  }
}

// ============================================================================
// Agent 会话管理
// ============================================================================

function collectAgentReply(
  session: AgentSessionWrapper,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    let textBlocks: string[] = [];
    let modelError: string | undefined;
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const updateAssistantSnapshot = (event: Record<string, unknown>) => {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;

      if (typeof msg.errorMessage === "string") modelError = msg.errorMessage;
      // DeerHux 的 message_update 通常携带 assistant 消息快照，而不是纯 delta。
      // 因此这里保留“最新快照”，不要每次 push 累加，否则手机端回复会和 session 落盘内容不同步。
      textBlocks = (msg.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
    };

    const finish = (text: string) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      unsub();
      signal?.removeEventListener("abort", cancel);
      resolve(text);
    };

    const unsub = session.onEvent((event) => {
      if (resolved) return;

      if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
        updateAssistantSnapshot(event as Record<string, unknown>);
      }

      // agent 回合结束：使用最后一次 assistant 快照，确保和 DeerHux session 中展示的最终文本一致。
      if (event.type === "agent_end") {
        const text = textBlocks.join("").trim();
        finish(text || (modelError ? `（模型请求失败：${modelError}）` : "（未生成文本回复）"));
      }

      // 自动重试结束但未成功
      if (event.type === "auto_retry_end" && !(event as { success?: boolean }).success) {
        finish("（Agent 自动重试失败）");
      }
    });

    const cancel = () => finish("");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    timer = setTimeout(() => {
      const text = textBlocks.join("").trim();
      finish(text || "（Agent 回复超时）");
    }, timeoutMs);
  });
}

/** 获取或创建用户的 session */
async function getOrCreateUserSession(
  fromUserId: string,
  cwd: string,
): Promise<{ sessionId: string; isNew: boolean }> {
  const userSessions = loadUserSessions();
  const existingId = userSessions[fromUserId];

  if (existingId) {
    const existing = getRpcSession(existingId);
    if (existing?.isAlive()) {
      return { sessionId: existingId, isNew: false };
    }

    // 进程热重载/空闲超时后，wrapper 可能已销毁，但磁盘上的 session 仍然存在。
    // 不能直接新建 session，否则同一个微信用户第二次对话会丢上下文，且前端打开的旧会话无法实时同步。
    const existingPath = await resolveSessionPath(existingId);
    if (existingPath) {
      const session = await ensureRpcSession(existingId);
      return { sessionId: session.sessionId, isNew: false };
    }

    // 绑定已失效时拒绝静默创建，避免用户以为仍在原项目里工作。
    throw new Error("绑定的会话已删除，请在 DeerHux 窗口重新接入微信");
  }

  // 创建新 session
  const tempKey = `__wechat_${fromUserId}_${Date.now()}`;
  const { realSessionId } = await startRpcSession(tempKey, "", cwd);

  userSessions[fromUserId] = realSessionId;
  saveUserSessions(userSessions);

  return { sessionId: realSessionId, isNew: true };
}

// ============================================================================
// WeChatBotService 单例
// ============================================================================

export class WeChatBindingError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "WeChatBindingError"; }
}

export class WeChatBotService {
  private api: ILlinkApiClient | null = null;
  private creds: WeChatCredentials | null = null;
  private polling = false;
  private lastError: string | undefined;
  private lastPollAt: string | undefined;
  private lastReceivedAt: string | undefined;
  private lastRepliedAt: string | undefined;
  private syncError: string | undefined;
  private mirror: WeChatSessionMirror | undefined;
  private unsubscribeMirror: (() => void) | undefined;
  private outboundQueues = new Map<string, Promise<void>>();
  private abortController: AbortController | null = null;

  /** 当前正在处理的用户消息（防止同一 session 并发 prompt） */
  private processingUsers = new Set<string>();
  /** 用户消息队列 */
  private messageQueues = new Map<string, Array<{
    message: WeixinMessage;
    text: string;
  }>>();

  /** 登录流程中的二维码 URL */
  private currentQRCodeUrl: string | null = null;
  private loginAbortController: AbortController | null = null;

  private defaultCwd: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd ?? getScheduledTasksCwd();
    // 尝试恢复之前的凭证
    const saved = loadCredentials();
    if (saved) {
      this.creds = saved;
      this.api = new ILlinkApiClient(saved.botToken, saved.baseUrl, saved.accountId);
    }
  }

  /** 获取二维码 URL，开始扫码登录流程 */
  async getQRCode(): Promise<string> {
    // 先取消之前的登录流程
    this.loginAbortController?.abort();
    this.loginAbortController = new AbortController();

    const tempApi = new ILlinkApiClient("", ILINK_BASE_URL, "");
    const qrResp = await tempApi.getQRCode();
    this.currentQRCodeUrl = qrResp.qrcode_img_content;

    // 后台轮询扫码状态（不阻塞）
    this.pollQRCodeStatus(tempApi, qrResp.qrcode, this.loginAbortController.signal);

    return this.currentQRCodeUrl;
  }

  /** 后台轮询二维码状态，直到确认或过期 */
  private async pollQRCodeStatus(
    api: ILlinkApiClient,
    qrcode: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 480_000; // 8 分钟超时

    while (Date.now() < deadline) {
      if (signal.aborted) return;

      try {
        const status = await api.getQRCodeStatus(qrcode);

        switch (status.status) {
          case "confirmed":
            if (status.bot_token && status.ilink_bot_id) {
              this.creds = {
                botToken: status.bot_token,
                accountId: status.ilink_bot_id,
                baseUrl: status.baseurl ?? ILINK_BASE_URL,
                userId: status.ilink_user_id ?? "",
              };
              this.api = new ILlinkApiClient(status.bot_token, status.baseurl ?? ILINK_BASE_URL, status.ilink_bot_id ?? "");
              saveCredentials(this.creds);
              this.currentQRCodeUrl = null;
              // 自动开始轮询
              this.startPolling().catch((err) => {
                console.error("[WeChatBot] 自动启动轮询失败:", err);
              });
            }
            return;

          case "expired":
            this.currentQRCodeUrl = null;
            return;

          default:
            // "wait" 或 "scaned"，继续轮询
            break;
        }
      } catch (err) {
        console.error("[WeChatBot] 轮询二维码状态出错:", err);
      }

      await sleep(1000);
    }
  }

  /** 使用已有凭证直接登录（跳过扫码） */
  loginWithCredentials(creds: WeChatCredentials): void {
    this.creds = creds;
    this.api = new ILlinkApiClient(creds.botToken, creds.baseUrl, creds.accountId);
    saveCredentials(creds);
  }

  private getContextTokenKey(fromUserId: string): string {
    return `${this.creds?.accountId ?? "unknown"}:${fromUserId}`;
  }

  private rememberContextToken(fromUserId: string, contextToken: string | undefined): void {
    if (!contextToken?.trim()) return;
    const tokens = loadContextTokens();
    tokens[this.getContextTokenKey(fromUserId)] = contextToken;
    saveContextTokens(tokens);
  }

  private getCachedContextToken(fromUserId: string): string | undefined {
    const tokens = loadContextTokens();
    return tokens[this.getContextTokenKey(fromUserId)];
  }

  private typingIndicators: WeChatTypingIndicators | undefined;

  private startTypingIndicator(fromUserId: string): () => void {
    if (!this.api) return () => {};
    if (!this.typingIndicators) {
      const api = this.api;
      this.typingIndicators = new WeChatTypingIndicators(
        (userId, status) => api.sendTyping(userId, status),
        (error) => console.warn("[WeChatBot] 输入状态更新失败:", error),
      );
    }
    return this.typingIndicators.acquire(fromUserId);
  }

  /** 开始消息轮询 */
  async startPolling(): Promise<void> {
    if (!this.api || !this.creds) {
      throw new Error("尚未登录，请先扫码");
    }

    if (this.polling) return;
    const api = this.api;

    this.lastError = undefined;
    this.polling = true;
    this.mirror = new WeChatSessionMirror({
      recipients: (sessionId) => this.polling && this.creds
        ? Object.entries(loadUserSessions()).filter(([, id]) => id === sessionId).map(([userId]) => userId)
        : [],
      beginTyping: (userId) => this.startTypingIndicator(userId),
      send: async (userId, text, sessionId) => {
        const mirror = this.mirror;
        await this.sendReply({ from_user_id: userId, context_token: "" }, text,
          () => this.polling && this.mirror === mirror && loadUserSessions()[userId] === sessionId);
        this.lastRepliedAt = new Date().toISOString();
        this.syncError = undefined;
      },
      sendProgress: async (userId, progress, sessionId, runId) => {
        const mirror = this.mirror;
        await this.enqueueOutbound(userId, async () => {
          if (!this.polling || this.mirror !== mirror || loadUserSessions()[userId] !== sessionId) return;
          const token = this.getCachedContextToken(userId);
          if (!token) throw new Error("缺少 context_token，无法发送工具进度");
          await api.sendProgress(userId, progress, token, runId);
        });
      },
      onError: (error) => {
        this.syncError = `微信同步失败：${error instanceof Error ? error.message : String(error)}`;
        console.error("[WeChatBot] 桌面会话同步失败:", error);
      },
    });
    this.unsubscribeMirror = getAgentEventStore().subscribeAll(this.mirror.handle);
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let syncBuf = loadSyncBuf() ?? "";
    const seenMessages = new Map<string, number>();

    console.log("[WeChatBot] 开始消息轮询...");

    while (this.polling && !signal.aborted) {
      try {
        const resp = await api.getUpdates(syncBuf, 35000);
        // 停止或重启后，旧请求返回不得处理消息或清除新登录凭证。
        if (signal.aborted || this.abortController?.signal !== signal) break;

        this.lastPollAt = new Date().toISOString();
        // Session 过期
        if (resp.errcode === -14) {
          console.log("[WeChatBot] Session 过期，需要重新登录");
          this.stopPolling();
          this.creds = null;
          this.api = null;
          this.lastError = "微信登录已过期，请重新扫码连接";
          clearCredentials();
          clearContextTokens();
          return;
        }

        if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
          throw new Error(`微信收信失败（${resp.errcode ?? resp.ret}）`);
        }
        this.lastError = undefined;

        // 更新游标
        if (resp.get_updates_buf) {
          syncBuf = resp.get_updates_buf;
          saveSyncBuf(syncBuf);
        }

        // 处理新消息
        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          // 只处理来自用户的消息（message_type === 1 表示用户消息）
          if (msg.message_type !== 1) continue;

          const text = extractText(msg);
          if (!text) continue;

          const dedupKey = buildMessageDedupKey(msg, text);
          if (dedupKey && !rememberSeenKey(seenMessages, dedupKey)) {
            console.log(`[WeChatBot] 跳过重复消息 msg_id=${msg.msg_id} from=${msg.from_user_id}`);
            continue;
          }

          const fromUserId = msg.from_user_id;
          this.lastReceivedAt = new Date().toISOString();
          this.rememberContextToken(fromUserId, msg.context_token);
          console.log(`[WeChatBot] 收到消息 from=${fromUserId}: ${text.slice(0, 50)}...`);

          // 加入队列处理
          this.enqueueMessage(fromUserId, msg, text);
        }

        // 清理旧去重记录。去重只作为短时间防重放保护，不能永久屏蔽同一用户后续消息。
        if (seenMessages.size > 2000) {
          const cutoff = Date.now() - 60_000;
          for (const [key, seenAt] of seenMessages) {
            if (seenAt < cutoff) seenMessages.delete(key);
          }
        }

        // 如果本轮没有收到任何新消息（长轮询正常超时返回），稍等片刻再继续，
        // 避免服务器瞬间响应时造成 busy-polling。
        if (msgs.length === 0) {
          await sleep(500);
        }
      } catch (err: unknown) {
        if (!this.polling || signal.aborted) break;

        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        console.error("[WeChatBot] 轮询出错:", msg);

        // 短暂等待后重试
        await sleep(5000);
      }
    }

    console.log("[WeChatBot] 消息轮询已停止");
  }

  /** 停止轮询 */
  stopPolling(): void {
    this.unsubscribeMirror?.();
    this.unsubscribeMirror = undefined;
    this.mirror?.stop();
    this.mirror = undefined;
    this.polling = false;
    this.typingIndicators?.stop();
    this.typingIndicators = undefined;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** 将消息加入处理队列 */
  private enqueueMessage(
    fromUserId: string,
    msg: WeixinMessage,
    text: string,
  ): void {
    if (!this.messageQueues.has(fromUserId)) {
      this.messageQueues.set(fromUserId, []);
    }
    this.messageQueues.get(fromUserId)!.push({ message: msg, text });
    this.processNextMessage(fromUserId);
  }

  /** 处理队列中的下一条消息（保证同一 session 串行） */
  private async processNextMessage(fromUserId: string): Promise<void> {
    if (this.processingUsers.has(fromUserId)) return;

    const queue = this.messageQueues.get(fromUserId);
    if (!queue || queue.length === 0) return;

    this.processingUsers.add(fromUserId);

    let currentMsg: WeixinMessage | null = null;
    let stopTyping: (() => void) | null = null;

    try {
      const { message: msg, text } = queue.shift()!;
      currentMsg = msg;
      // 收到消息开始处理就显示状态，覆盖冷启动和等待桌面回合的阶段。
      stopTyping = this.startTypingIndicator(msg.from_user_id);

      // 获取或创建用户的 Agent session
      const { sessionId, isNew } = await getOrCreateUserSession(fromUserId, this.defaultCwd);
      const session = getRpcSession(sessionId);
      if (!session || !session.isAlive()) {
        console.error(`[WeChatBot] Session ${sessionId} 不可用`);
        await this.sendReply(msg, "（Agent 会话不可用，请稍后重试）");
        return;
      }

      if (isNew) {
        console.log(`[WeChatBot] 为新用户 ${fromUserId} 创建 session: ${sessionId}`);
      }

      // 等待桌面端当前回合结束，随后同步订阅并提交，避免收集到上一轮回复。
      const waitUntil = Date.now() + 10 * 60_000;
      while (session.getStatus().isRunning || session.getStatus().isStreaming || session.getStatus().isCompacting) {
        if (Date.now() >= waitUntil || !session.isAlive()) throw new Error("窗口持续忙碌，请稍后重试");
        await sleep(250);
      }

      console.log(`[WeChatBot] 发送到 Agent: "${text.slice(0, 50)}..."`);

      // 先订阅事件，再发送 prompt，避免 Agent 很快开始输出时漏掉开头事件。
      const replyController = new AbortController();
      const replyPromise = collectAgentReply(session, 300_000, replyController.signal);
      let reply: string;
      try {
        await session.send({ type: "prompt", message: text, clientMessageId: `${WECHAT_MESSAGE_PREFIX}${msg.msg_id || randomUUID()}` });
        reply = await replyPromise;
      } finally {
        replyController.abort();
      }
      console.log(`[WeChatBot] Agent 回复: "${reply.slice(0, 50)}..."`);

      // 等待本轮工具进度发送完毕，避免最终回答越过进度消息。
      await this.mirror?.drainUser(fromUserId);
      // 发送回复到微信
      await this.sendReply(msg, reply);
      this.lastRepliedAt = new Date().toISOString();
    } catch (err) {
      console.error(`[WeChatBot] 处理消息失败:`, err);
      if (currentMsg) {
        try {
          await this.sendReply(currentMsg, "（处理消息时出错，请重试）");
        } catch { /* ignore */ }
      }
    } finally {
      stopTyping?.();
      this.processingUsers.delete(fromUserId);
      // 继续处理队列中的下一条
      setTimeout(() => this.processNextMessage(fromUserId), 500);
    }
  }

  /** 通过 iLink API 发送回复 */
  private async sendReply(msg: Pick<WeixinMessage, "from_user_id" | "context_token">, reply: string, shouldSend = () => true): Promise<void> {
    await this.enqueueOutbound(msg.from_user_id, async () => {
      if (shouldSend()) await this.sendReplyNow(msg, reply, shouldSend);
    });
  }

  private async enqueueOutbound(userId: string, send: () => Promise<void>): Promise<void> {
    const previous = this.outboundQueues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(send);
    this.outboundQueues.set(userId, next);
    try { await next; }
    finally { if (this.outboundQueues.get(userId) === next) this.outboundQueues.delete(userId); }
  }

  private async sendReplyNow(msg: Pick<WeixinMessage, "from_user_id" | "context_token">, reply: string, shouldSend: () => boolean): Promise<void> {
    if (!this.api) throw new Error("微信已断开，请重新连接");

    const contextToken = msg.context_token || this.getCachedContextToken(msg.from_user_id);
    if (!contextToken) {
      throw new Error(`缺少 context_token，无法回复用户 ${msg.from_user_id}`);
    }

    // 消息太长时分段发送
    const maxLen = 2000;
    if (reply.length <= maxLen) {
      await this.api.sendMessage(msg.from_user_id, reply, contextToken);
      return;
    }

    // 分段发送
    const chunks = splitText(reply, maxLen);
    for (let i = 0; i < chunks.length; i++) {
      if (!shouldSend()) return;
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
      await this.api.sendMessage(msg.from_user_id, prefix + chunks[i], contextToken);
      if (i < chunks.length - 1) await sleep(500);
    }
  }

  /** 已收到消息的微信端；解除绑定后仍可再次选择。 */
  getConnections(): Record<string, string> {
    const bindings = loadUserSessions();
    const prefix = `${this.creds?.accountId ?? "unknown"}:`;
    const knownUsers = Object.keys(loadContextTokens())
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    return Object.fromEntries([...new Set([
      ...knownUsers, ...Object.keys(bindings),
    ])].map((userId) => [userId, bindings[userId] ?? ""]));
  }

  async bindSession(userId: string, sessionId: string, expectedSessionId: string): Promise<void> {
    if (!this.creds) throw new WeChatBindingError("请先扫码连接微信 Bot", 409);
    if (!Object.hasOwn(this.getConnections(), userId)) {
      throw new WeChatBindingError("未找到该微信端，请先给 Bot 发送一条消息", 404);
    }
    if (!getRpcSession(sessionId)?.isAlive() && !await resolveSessionPath(sessionId)) {
      throw new WeChatBindingError("窗口会话不存在，请重新打开窗口", 404);
    }
    // 在最后一个 await 后读取并校验，避免切换期间的消息和并发绑定覆盖。
    const bindings = loadUserSessions();
    if ((bindings[userId] ?? "") !== expectedSessionId) {
      throw new WeChatBindingError("微信端的绑定已变化，请刷新后重试", 409);
    }
    if (this.processingUsers.has(userId) || this.messageQueues.get(userId)?.length) {
      throw new WeChatBindingError("该微信端还有消息正在处理，请完成后再切换", 409);
    }
    if (Object.entries(bindings).some(([other, id]) => other !== userId && id === sessionId)) {
      throw new WeChatBindingError("该窗口已接入另一个微信端，请先解除绑定", 409);
    }
    const previousSessionId = bindings[userId];
    bindings[userId] = sessionId;
    saveUserSessions(bindings);
    if (previousSessionId && previousSessionId !== sessionId) this.mirror?.cancelSession(previousSessionId);
    void this.startPolling().catch((error) => {
      this.lastError = error instanceof Error ? error.message : "微信监听启动失败";
      console.error("[WeChatBot] 绑定后启动监听失败:", error);
    });
  }

  unbindSession(userId: string, sessionId: string): void {
    const bindings = loadUserSessions();
    if (bindings[userId] !== sessionId) throw new WeChatBindingError("绑定已变化，请刷新后重试", 409);
    if (this.processingUsers.has(userId) || this.messageQueues.get(userId)?.length) {
      throw new WeChatBindingError("微信消息正在处理，请完成后再解除", 409);
    }
    // 空映射保留已知端；下一次微信消息恢复为独立会话。
    bindings[userId] = "";
    saveUserSessions(bindings);
    this.mirror?.cancelSession(sessionId);
  }

  /** 获取当前状态 */
  getStatus(): WeChatStatus {
    const userSessions = loadUserSessions();
    return {
      connected: Boolean(this.creds),
      polling: this.polling,
      lastError: this.lastError ?? this.syncError,
      lastPollAt: this.lastPollAt,
      lastReceivedAt: this.lastReceivedAt,
      lastRepliedAt: this.lastRepliedAt,
      desktopSyncEnabled: Boolean(this.mirror && this.unsubscribeMirror && this.polling),
      accountId: this.creds?.accountId,
      qrcodeUrl: this.currentQRCodeUrl ?? undefined,
      activeUserCount: Object.keys(userSessions).length,
    };
  }

  /** 退出登录 */
  logout(): void {
    this.stopPolling();
    this.loginAbortController?.abort();
    this.creds = null;
    this.api = null;
    this.currentQRCodeUrl = null;
    clearCredentials();
    // 清除游标
    try { unlinkSync(getSyncBufPath()); } catch { /* ignore */ }
    clearContextTokens();
  }

  /** 更新默认工作目录 */
  setCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按自然边界拆分文本 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // 尝试在换行处断开
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      // 尝试在句号处断开
      splitAt = remaining.lastIndexOf("。", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      // 尝试在空格处断开
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ============================================================================
// 单例
// ============================================================================

// Next.js 会将多个路由打入不同模块；模块变量不保证跨路由唯一。
// 使用与 RPC Registry 相同的进程级存储，所有入口共享轮询、队列和绑定锁。
declare global {
  var __deerhuxWeChatBotService: WeChatBotService | undefined;
  var __deerhuxWeChatBotVersion: number | undefined;
}

export function getWeChatBotService(cwd?: string): WeChatBotService {
  if (globalThis.__deerhuxWeChatBotService && globalThis.__deerhuxWeChatBotVersion !== 8) {
    const wasPolling = globalThis.__deerhuxWeChatBotService.getStatus().polling;
    globalThis.__deerhuxWeChatBotService.stopPolling();
    globalThis.__deerhuxWeChatBotService = new WeChatBotService(cwd);
    if (wasPolling) void globalThis.__deerhuxWeChatBotService.startPolling().catch(console.error);
  }
  globalThis.__deerhuxWeChatBotVersion = 8;
  const instance = globalThis.__deerhuxWeChatBotService ??= new WeChatBotService(cwd);
  if (cwd) instance.setCwd(cwd);
  return instance;
}

/** 仅用于测试：重置单例 */
export function resetWeChatBotService(): void {
  globalThis.__deerhuxWeChatBotService?.stopPolling();
  delete globalThis.__deerhuxWeChatBotService;
}
