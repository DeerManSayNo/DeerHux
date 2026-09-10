/** 同一微信端的多个等待任务共用输入状态，最后一个任务完成才关闭。 */
export class WeChatTypingIndicators {
  private entries = new Map<string, { release: () => void; stop: () => void; count: number }>();
  constructor(
    private readonly send: (userId: string, status: 1 | 2) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly refreshMs = 15_000,
  ) {}

  acquire(userId: string): () => void {
    let entry = this.entries.get(userId);
    if (!entry) {
      let stopped = false;
      let pending: Promise<void> | undefined;
      const refresh = () => {
        if (stopped || pending) return;
        pending = this.send(userId, 1).catch(this.onError).finally(() => { pending = undefined; });
      };
      refresh();
      const timer = setInterval(refresh, this.refreshMs);
      timer.unref?.();
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        // 先等待在途 start 返回，避免 stop 先到、迟到的 start 又点亮状态。
        void (pending ?? Promise.resolve()).then(async () => {
          if (this.entries.has(userId)) return; // 已有新的等待任务接管
          await this.send(userId, 2);
        }).catch(this.onError);
      };
      entry = { count: 0, stop, release: () => {} };
      const owned = entry;
      entry.release = () => {
        owned.count--;
        if (owned.count > 0 || this.entries.get(userId) !== owned) return;
        this.entries.delete(userId);
        stop();
      };
      this.entries.set(userId, entry);
    }
    entry.count++;
    let released = false;
    return () => { if (!released) { released = true; entry.release(); } };
  }

  stop(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.stop();
  }
}
