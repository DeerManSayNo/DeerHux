/**
 * 在传输边界按 session/run/turn 合并累计完整的 message_update，
 * 同时保留跨流事件和所有顺序屏障。
 */
export interface CoalescableEvent {
  sessionId: string;
  runId: string;
  turnId?: string;
  globalSeq: number;
  event: { type: string };
}

function streamKey(value: CoalescableEvent): string {
  return `${value.sessionId}\0${value.runId}\0${value.turnId ?? ""}`;
}

export class MessageUpdateCoalescer<T extends CoalescableEvent> {
  private readonly pendingByStream = new Map<string, T>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly emit: (value: T) => void;
  private readonly delayMs: number;

  constructor(emit: (value: T) => void, delayMs = 32) {
    this.emit = emit;
    this.delayMs = delayMs;
  }

  push(value: T): void {
    if (value.event.type === "message_update") {
      this.pendingByStream.set(streamKey(value), value);
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.flush();
        }, this.delayMs);
      }
      return;
    }

    // 非 message_update 是全局顺序屏障。先提交各流的最新正文，
    // 再发送工具、结束等事件，避免终态越过累计快照。
    this.flush();
    this.emit(value);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pending = [...this.pendingByStream.values()]
      .sort((a, b) => a.globalSeq - b.globalSeq);
    this.pendingByStream.clear();

    for (const event of pending) this.emit(event);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingByStream.clear();
  }
}
