export interface SessionBufferedEvent {
  sessionId: string;
  epoch: string;
  globalSeq: number;
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

  constructor(maximum: number) {
    this.maximum = maximum;
  }

  push(event: T): boolean {
    if (this.maximum <= 0 || this.size >= this.maximum) return false;
    let events = this.bySession.get(event.sessionId);
    if (!events) this.bySession.set(event.sessionId, events = []);
    events.push(event);
    this.size += 1;
    return true;
  }

  drain(sessionId: string): T[] {
    const events = this.bySession.get(sessionId) ?? [];
    if (events.length > 0) {
      this.bySession.delete(sessionId);
      this.size -= events.length;
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

  get length(): number {
    return this.size;
  }
}
