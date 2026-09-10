import type { SequencedAgentEvent } from "./agent-runtime/types";

export const WECHAT_MESSAGE_PREFIX = "wechat:";

export type WeChatToolProgress = { toolCallId: string; toolName: string; status?: "completed" | "failed" | "unknown" };

type Turn = { remote: boolean; tools: Map<string, { name: string; ended: boolean }>; turnId: string; recipients: string[]; text: string; error?: string; stopTyping: Array<() => void> };
type Dependencies = {
  recipients: (sessionId: string) => string[];
  send: (userId: string, text: string, sessionId: string) => Promise<void>;
  sendProgress?: (userId: string, progress: WeChatToolProgress, sessionId: string, runId: string) => Promise<void>;
  onError: (error: unknown) => void;
  beginTyping?: (userId: string) => () => void;
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : block?.type === "image" ? "[图片]" : "").join("");
}

/** 只订阅实时事件，不重放历史；同一微信端按顺序同步用户消息和最终回答。 */
export class WeChatSessionMirror {
  private turns = new Map<string, Turn>();
  private seen = new Set<string>();
  private remoteTurns = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  private stopped = false;
  private typingStops = new Set<() => void>();

  constructor(private readonly deps: Dependencies) {}

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private enqueue(sessionId: string, recipients: string[], text: string | WeChatToolProgress, runId?: string): void {
    for (const userId of recipients) {
      const previous = this.queues.get(userId) ?? Promise.resolve();
      const next = previous.then(async () => {
        // 排队期间可能解除绑定或切换窗口，不能把旧窗口消息发到新绑定。
        if (this.stopped || !this.deps.recipients(sessionId).includes(userId)) return;
        if (typeof text === "string") await this.deps.send(userId, text, sessionId);
        else await this.deps.sendProgress?.(userId, text, sessionId, runId!);
      }).catch(this.deps.onError);
      this.queues.set(userId, next);
      void next.finally(() => { if (this.queues.get(userId) === next) this.queues.delete(userId); });
    }
  }

  handle = (envelope: SequencedAgentEvent): void => {
    if (this.stopped || !envelope.turnId) return;
    const { sessionId, turnId, event } = envelope;
    const message = event.message as { role?: string; content?: unknown; clientMessageId?: string; errorMessage?: string } | undefined;
    if (event.type === "message_end" && message?.role === "user") {
      // 微信回合只转发工具进度，最终回答仍由原回复链路发送。
      const remote = Boolean(message.clientMessageId?.startsWith(WECHAT_MESSAGE_PREFIX));
      if (remote) {
        this.remoteTurns.set(sessionId, turnId);
        if (this.remoteTurns.size > 256) this.remoteTurns.delete(this.remoteTurns.keys().next().value!);
      }
      if (this.remoteTurns.get(sessionId) === turnId && !message.clientMessageId) return;
      if (!remote) this.remoteTurns.delete(sessionId);
      const existing = this.turns.get(sessionId);
      if (existing?.turnId === turnId) return;
      if (message.clientMessageId && !this.remember(`${sessionId}:${message.clientMessageId}`)) return;
      const recipients = this.deps.recipients(sessionId);
      if (!recipients.length) return;
      this.cancelSession(sessionId);
      const stopTyping = (remote ? [] : recipients).map((userId) => {
        const stop = this.deps.beginTyping?.(userId) ?? (() => {});
        this.typingStops.add(stop);
        return stop;
      });
      this.turns.set(sessionId, { remote, tools: new Map(), turnId, recipients, text: "", stopTyping });
      if (this.turns.size > 256) this.cancelSession(this.turns.keys().next().value!);
      const text = messageText(message.content).trim();
      if (text && !remote) this.enqueue(sessionId, recipients, `【电脑端】\n${text}`);
      return;
    }
    const turn = this.turns.get(sessionId);
    if (!turn || turn.turnId !== turnId) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return;
      const previous = turn.tools.get(id);
      const ended = event.type === "tool_execution_end";
      if (previous?.ended || (previous && !ended)) return;
      const name = typeof event.toolName === "string" ? event.toolName : previous?.name ?? "tool";
      turn.tools.set(id, { name, ended });
      this.enqueue(sessionId, turn.recipients, {
        toolCallId: id, toolName: name,
        ...(ended ? { status: event.isError === true ? "failed" : event.isError === false ? "completed" : "unknown" } : {}),
      }, turnId);
      return;
    }
    if (["message_start", "message_update", "message_end"].includes(event.type) && message?.role === "assistant") {
      turn.text = messageText(message.content).trim();
      turn.error = message.errorMessage;
    }
    if (event.type === "agent_end" && !event.willRetry) {
      for (const [id, tool] of turn.tools) {
        if (!tool.ended) this.enqueue(sessionId, turn.recipients, {
          toolCallId: id, toolName: tool.name, status: "unknown",
        }, turnId);
      }
      this.turns.delete(sessionId);
      const error = typeof event.error === "string" ? event.error : turn.error;
      const text = turn.text || (error ? `请求失败：${error}` : "（本轮未生成文本回复）");
      if (!turn.remote) this.enqueue(sessionId, turn.recipients, `【AI 回复】\n${text}`);
      // 最终回答仍可能在发送队列中，送出后再撤销输入状态。
      void Promise.all(turn.recipients.map((userId) => this.queues.get(userId))).then(() => this.releaseTyping(turn));
    }
  };

  async drainUser(userId: string): Promise<void> { await this.queues.get(userId); }

  async drain(): Promise<void> { await Promise.all(this.queues.values()); }

  private releaseTyping(turn: Turn): void {
    for (const stop of turn.stopTyping) {
      if (this.typingStops.delete(stop)) stop();
    }
  }

  cancelSession(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (turn) this.releaseTyping(turn);
    this.turns.delete(sessionId);
  }

  stop(): void {
    for (const stop of this.typingStops) stop();
    this.typingStops.clear();
    this.stopped = true;
    this.turns.clear();
    this.seen.clear();
    this.remoteTurns.clear();
  }
}
