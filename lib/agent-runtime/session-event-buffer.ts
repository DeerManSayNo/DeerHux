export interface SessionBufferedEvent {
  sessionId: string;
  epoch: string;
  globalSeq: number;
}

export interface SessionBufferDiagnostics {
  size: number;
  maximum: number;
  sessionCount: number;
  largestSessionSize: number;
  peakSize: number;
  pushedTotal: number;
  drainedTotal: number;
  overflowsTotal: number;
}

/**
 * Bounded per-session buffers for events received while no view is mounted.
 * The application cursor may only advance after an event is either delivered or
 * retained here, so switching tabs can replay the complete ordered event set.
 */
export class SessionEventBuffer<T extends SessionBufferedEvent> {
  private readonly bySession = new Map<string, T[]>();
  private readonly maximum: number;
  private size = 0;
  private peakSize = 0;
  private pushedTotal = 0;
  private drainedTotal = 0;
  private overflowsTotal = 0;

  constructor(maximum: number) {
    this.maximum = maximum;
  }

  push(event: T): boolean {
    if (this.maximum <= 0 || this.size >= this.maximum) {
      this.overflowsTotal += 1;
      return false;
    }
    let events = this.bySession.get(event.sessionId);
    if (!events) this.bySession.set(event.sessionId, events = []);
    events.push(event);
    this.size += 1;
    this.pushedTotal += 1;
    this.peakSize = Math.max(this.peakSize, this.size);
    return true;
  }

  drain(sessionId: string): T[] {
    const events = this.bySession.get(sessionId) ?? [];
    if (events.length > 0) {
      this.bySession.delete(sessionId);
      this.size -= events.length;
      this.drainedTotal += events.length;
    }
    return events.sort((a, b) => a.globalSeq - b.globalSeq);
  }

  /** Release every retained event and report which sessions now require snapshots. */
  clear(): string[] {
    const sessionIds = [...this.bySession.keys()];
    this.bySession.clear();
    this.size = 0;
    return sessionIds;
  }

  diagnostics(): SessionBufferDiagnostics {
    let largestSessionSize = 0;
    for (const events of this.bySession.values()) largestSessionSize = Math.max(largestSessionSize, events.length);
    return {
      size: this.size,
      maximum: this.maximum,
      sessionCount: this.bySession.size,
      largestSessionSize,
      peakSize: this.peakSize,
      pushedTotal: this.pushedTotal,
      drainedTotal: this.drainedTotal,
      overflowsTotal: this.overflowsTotal,
    };
  }

  get length(): number {
    return this.size;
  }
}
