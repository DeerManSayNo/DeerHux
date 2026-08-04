/**
 * 在传输边界合并携带累计完整消息的 message_update，同时保留所有顺序屏障。
 */
export class MessageUpdateCoalescer<T extends { event: { type: string } }> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly emit: (value: T) => void;
  private readonly delayMs: number;

  constructor(emit: (value: T) => void, delayMs = 32) {
    this.emit = emit;
    this.delayMs = delayMs;
  }

  push(value: T): void {
    if (value.event.type === "message_update") {
      this.pending = value;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.flush();
        }, this.delayMs);
      }
      return;
    }
    this.flush();
    this.emit(value);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) this.emit(pending);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = null;
  }
}
