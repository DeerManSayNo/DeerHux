/**
 * 在传输边界按 session/run/turn 合并累计完整的 message_update，
 * 同时保留跨流事件和所有顺序屏障。
 */
export interface MessageUpdateCoalescerDiagnostics {
  messageUpdatesReceivedTotal: number;
  messageUpdatesEmittedTotal: number;
  messageUpdatesCoalescedTotal: number;
  flushesTotal: number;
  timerFlushesTotal: number;
  barrierFlushesTotal: number;
  pendingStreams: number;
  pendingStreamsPeak: number;
  flushBatchSizeMax: number;
}

function initialDiagnostics(): MessageUpdateCoalescerDiagnostics {
  return {
    messageUpdatesReceivedTotal: 0,
    messageUpdatesEmittedTotal: 0,
    messageUpdatesCoalescedTotal: 0,
    flushesTotal: 0,
    timerFlushesTotal: 0,
    barrierFlushesTotal: 0,
    pendingStreams: 0,
    pendingStreamsPeak: 0,
    flushBatchSizeMax: 0,
  };
}

declare global {
  var __deerhuxCoalescerDiagnostics: MessageUpdateCoalescerDiagnostics | undefined;
}

function diagnostics(): MessageUpdateCoalescerDiagnostics {
  return globalThis.__deerhuxCoalescerDiagnostics ??= initialDiagnostics();
}

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
  private reportedPending = 0;

  constructor(emit: (value: T) => void, delayMs = 32) {
    this.emit = emit;
    this.delayMs = delayMs;
  }

  push(value: T): void {
    const metrics = diagnostics();
    if (value.event.type === "message_update") {
      metrics.messageUpdatesReceivedTotal += 1;
      const key = streamKey(value);
      if (this.pendingByStream.has(key)) metrics.messageUpdatesCoalescedTotal += 1;
      this.pendingByStream.set(key, value);
      const pendingDelta = this.pendingByStream.size - this.reportedPending;
      metrics.pendingStreams += pendingDelta;
      this.reportedPending = this.pendingByStream.size;
      metrics.pendingStreamsPeak = Math.max(metrics.pendingStreamsPeak, metrics.pendingStreams);
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          diagnostics().timerFlushesTotal += 1;
          this.flush();
        }, this.delayMs);
      }
      return;
    }

    // 非 message_update 是全局顺序屏障。先提交各流的最新正文，
    // 再发送工具、结束等事件，避免终态越过累计快照。
    if (this.pendingByStream.size > 0) metrics.barrierFlushesTotal += 1;
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
    const metrics = diagnostics();
    metrics.pendingStreams = Math.max(0, metrics.pendingStreams - this.reportedPending);
    this.reportedPending = 0;
    if (pending.length > 0) {
      metrics.flushesTotal += 1;
      metrics.flushBatchSizeMax = Math.max(metrics.flushBatchSizeMax, pending.length);
      metrics.messageUpdatesEmittedTotal += pending.length;
    }

    for (const event of pending) this.emit(event);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingByStream.clear();
    const metrics = diagnostics();
    metrics.pendingStreams = Math.max(0, metrics.pendingStreams - this.reportedPending);
    this.reportedPending = 0;
  }
}

export function getMessageUpdateCoalescerDiagnostics(): MessageUpdateCoalescerDiagnostics {
  return { ...diagnostics() };
}

/** Test-only reset; production code must not call this. */
export function resetMessageUpdateCoalescerDiagnosticsForTests(): void {
  globalThis.__deerhuxCoalescerDiagnostics = initialDiagnostics();
}
