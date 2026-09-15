export interface ReloadResult { ok: boolean; skipped?: boolean }

/** Coalesce configuration changes without changing tools during an active turn. */
export class DeferredMcpReload<T extends ReloadResult> {
  private pending = false;
  private disposed = false;
  private running: Promise<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ready: () => boolean,
    private readonly reload: () => Promise<T>,
    private readonly onError: (error: unknown) => void,
    private readonly delayMs = 250,
  ) {}

  async request(): Promise<T | ReloadResult> {
    if (this.disposed) return { ok: false, skipped: true };
    this.pending = true;
    if (this.running || !this.ready()) {
      this.schedule();
      return { ok: false, skipped: true };
    }
    return this.flush();
  }

  private async flush(): Promise<T> {
    this.pending = false;
    const operation = Promise.resolve().then(this.reload);
    this.running = operation;
    try {
      const result = await operation;
      if (result.skipped) this.pending = true;
      return result;
    } finally {
      this.running = null;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.disposed || !this.pending || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || !this.pending || this.running) return;
      if (!this.ready()) { this.schedule(); return; }
      void this.flush().catch(this.onError);
    }, this.delayMs);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
