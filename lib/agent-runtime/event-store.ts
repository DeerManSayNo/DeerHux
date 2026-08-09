import type {
  AgentRuntimeEventBase,
  EventListener,
  GlobalEventListener,
  GlobalReplayResult,
  JournalCursor,
  ResumeDecision,
  SequencedAgentEvent,
  Unsubscribe,
} from "./types";

const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_MAX_EVENTS_PER_SESSION = 2_000;
const DEFAULT_MAX_EVENTS_PER_RUN = 1_000;
const DEFAULT_TTL_MS = 30 * 60_000;

interface EventBucket {
  events: SequencedAgentEvent[];
}

interface RunEventBucket extends EventBucket {
  nextSeq: number;
  listeners: Set<EventListener>;
}

export interface EventStoreOptions {
  epoch?: string;
  /** Preferred application-journal capacity option. */
  maxGlobalEvents?: number;
  /** Backward-compatible shorthand for maxGlobalEvents. */
  maxEvents?: number;
  maxEventsPerSession?: number;
  maxEventsPerRun?: number;
  ttlMs?: number;
  globalTtlMs?: number;
  sessionTtlMs?: number;
  runTtlMs?: number;
  now?: () => number;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createEpoch(now: number): string {
  return `epoch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-memory compatibility store and application event journal.
 *
 * `seq` remains scoped to runId for the legacy SSE API. `globalSeq` and
 * `sessionSeq` are application-journal cursors. Coalesced events retain the
 * beginning of the sequence range they cover, so a numeric jump caused by
 * replacing message_update snapshots is not confused with eviction.
 */
export class EventStore {
  readonly epoch: string;

  private readonly maxEvents: number;
  private readonly maxEventsPerSession: number;
  private readonly maxEventsPerRun: number;
  private readonly globalTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly runTtlMs: number;
  private readonly now: () => number;

  private readonly runs = new Map<string, RunEventBucket>();
  private readonly sessions = new Map<string, EventBucket>();
  private readonly nextSessionSeq = new Map<string, number>();
  private readonly allListeners = new Set<GlobalEventListener>();
  private globalEvents: SequencedAgentEvent[] = [];
  private nextGlobalSeq = 1;
  private globalEvictedThrough = 0;

  constructor(options: EventStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? createEpoch(this.now());
    this.maxEvents = positiveOrDefault(
      options.maxGlobalEvents ?? options.maxEvents,
      DEFAULT_MAX_EVENTS,
    );
    this.maxEventsPerSession = positiveOrDefault(
      options.maxEventsPerSession,
      DEFAULT_MAX_EVENTS_PER_SESSION,
    );
    this.maxEventsPerRun = positiveOrDefault(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN);
    const sharedTtl = positiveOrDefault(options.ttlMs, DEFAULT_TTL_MS);
    this.globalTtlMs = positiveOrDefault(options.globalTtlMs, sharedTtl);
    this.sessionTtlMs = positiveOrDefault(options.sessionTtlMs, sharedTtl);
    this.runTtlMs = positiveOrDefault(options.runTtlMs, sharedTtl);
  }

  append(input: {
    sessionId: string;
    runId: string;
    turnId?: string;
    event: AgentRuntimeEventBase;
  }): SequencedAgentEvent {
    const createdAt = this.now();
    this.prune(createdAt);

    const run = this.getOrCreateRun(input.runId);
    const globalSeq = this.nextGlobalSeq++;
    const sessionSeq = this.nextSessionSeq.get(input.sessionId) ?? 1;
    this.nextSessionSeq.set(input.sessionId, sessionSeq + 1);

    const next: SequencedAgentEvent = {
      seq: run.nextSeq++,
      seqStart: run.nextSeq - 1,
      eventId: `${this.epoch}:${globalSeq}`,
      epoch: this.epoch,
      globalSeq,
      globalSeqStart: globalSeq,
      sessionSeq,
      sessionSeqStart: sessionSeq,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      topic: input.event.type,
      createdAt,
      payload: input.event,
      event: input.event,
    };

    // message_update 是累计完整消息。只合并同一 session/run/turn 的连续快照，
    // 并保留被替换事件覆盖的 cursor 起点。这样回放可压缩内存，同时明确
    // [*SeqStart, *Seq] 是一个连续覆盖区间，而不是事件缺口。
    this.storeInBucket(run, next, "seqStart");

    let session = this.sessions.get(input.sessionId);
    if (!session) {
      session = { events: [] };
      this.sessions.set(input.sessionId, session);
    }
    this.storeInBucket(session, next, "sessionSeqStart");
    this.storeInGlobal(next);

    this.trimBucket(run, this.maxEventsPerRun);
    this.trimBucket(session, this.maxEventsPerSession);
    this.trimGlobal();

    this.notify(run.listeners, next);
    this.notify(this.allListeners, next);
    return next;
  }

  /** Legacy run-scoped replay API. */
  getSince(runId: string, afterSeq?: number): SequencedAgentEvent[] {
    this.prune(this.now());
    const bucket = this.runs.get(runId);
    if (!bucket) return [];
    if (afterSeq === undefined || afterSeq <= 0) return [...bucket.events];
    return bucket.events.filter((event) => event.seq > afterSeq);
  }

  getLastSeq(runId: string): number {
    const bucket = this.runs.get(runId);
    return bucket ? bucket.nextSeq - 1 : 0;
  }

  subscribe(runId: string, listener: EventListener): Unsubscribe {
    const bucket = this.getOrCreateRun(runId);
    bucket.listeners.add(listener);
    return this.unsubscribeFrom(bucket.listeners, listener);
  }

  /** Subscribe to every event in strict append order, across all sessions. */
  subscribeAll(listener: GlobalEventListener): Unsubscribe {
    this.allListeners.add(listener);
    return this.unsubscribeFrom(this.allListeners, listener);
  }

  /**
   * Decide whether an application cursor can be resumed without a snapshot.
   * Coalescing does not advance `globalEvictedThrough`; only TTL/capacity/clear
   * eviction invalidates cursors.
   */
  canResume(cursor: JournalCursor): ResumeDecision;
  canResume(epoch: string, globalSeq: number): ResumeDecision;
  canResume(cursorOrEpoch: JournalCursor | string, globalSeq?: number): ResumeDecision {
    const cursor = typeof cursorOrEpoch === "string"
      ? { epoch: cursorOrEpoch, globalSeq: globalSeq ?? Number.NaN }
      : cursorOrEpoch;
    this.prune(this.now());
    const latestGlobalSeq = this.nextGlobalSeq - 1;
    const base = {
      epoch: this.epoch,
      earliestGlobalSeq: this.globalEvictedThrough + 1,
      latestGlobalSeq,
    };

    if (cursor.epoch !== this.epoch) {
      return { ...base, canResume: false, snapshotRequired: true, reason: "epoch_mismatch" };
    }
    if (!Number.isSafeInteger(cursor.globalSeq) || cursor.globalSeq < 0) {
      return { ...base, canResume: false, snapshotRequired: true, reason: "invalid_cursor" };
    }
    if (cursor.globalSeq > latestGlobalSeq) {
      return { ...base, canResume: false, snapshotRequired: true, reason: "cursor_ahead" };
    }
    if (cursor.globalSeq < this.globalEvictedThrough) {
      return { ...base, canResume: false, snapshotRequired: true, reason: "cursor_evicted" };
    }
    return { ...base, canResume: true, snapshotRequired: false, reason: "ok" };
  }

  /** Return application-level replay plus an explicit resume decision. */
  getGlobalSince(cursor?: JournalCursor): GlobalReplayResult;
  getGlobalSince(afterGlobalSeq?: number, epoch?: string): GlobalReplayResult;
  getGlobalSince(cursorOrSeq?: JournalCursor | number, epoch = this.epoch): GlobalReplayResult {
    const effectiveCursor = typeof cursorOrSeq === "number"
      ? { epoch, globalSeq: cursorOrSeq }
      : cursorOrSeq ?? { epoch: this.epoch, globalSeq: 0 };
    const decision = this.canResume(effectiveCursor);
    return {
      ...decision,
      events: decision.canResume
        ? this.globalEvents.filter((event) => event.globalSeq > effectiveCursor.globalSeq)
        : [],
    };
  }

  /** Session-scoped journal view, primarily for snapshots and diagnostics. */
  getSessionSince(sessionId: string, afterSessionSeq?: number): SequencedAgentEvent[] {
    this.prune(this.now());
    const bucket = this.sessions.get(sessionId);
    if (!bucket) return [];
    if (afterSessionSeq === undefined || afterSessionSeq <= 0) return [...bucket.events];
    return bucket.events.filter((event) => event.sessionSeq > afterSessionSeq);
  }

  getLastGlobalSeq(): number {
    return this.nextGlobalSeq - 1;
  }

  getLastSessionSeq(sessionId: string): number {
    return (this.nextSessionSeq.get(sessionId) ?? 1) - 1;
  }

  clearRun(runId: string): void {
    // The application journal deliberately outlives a run/wrapper bucket.
    this.runs.delete(runId);
  }

  clearAll(): void {
    this.runs.clear();
    this.sessions.clear();
    this.nextSessionSeq.clear();
    // Global sequence stays monotonic for the lifetime of this epoch, even
    // when retained event payloads are explicitly cleared.
    this.globalEvents = [];
    this.globalEvictedThrough = this.nextGlobalSeq - 1;
    this.allListeners.clear();
  }

  private getOrCreateRun(runId: string): RunEventBucket {
    let bucket = this.runs.get(runId);
    if (!bucket) {
      bucket = { events: [], nextSeq: 1, listeners: new Set() };
      this.runs.set(runId, bucket);
    }
    return bucket;
  }

  private canCoalesce(previous: SequencedAgentEvent | undefined, next: SequencedAgentEvent): boolean {
    return next.event.type === "message_update"
      && previous?.event.type === "message_update"
      && previous.sessionId === next.sessionId
      && previous.runId === next.runId
      && previous.turnId === next.turnId;
  }

  private storeInBucket(
    bucket: EventBucket,
    next: SequencedAgentEvent,
    rangeStart: "seqStart" | "sessionSeqStart",
  ): void {
    const previous = bucket.events[bucket.events.length - 1];
    if (this.canCoalesce(previous, next)) {
      next[rangeStart] = previous[rangeStart];
      bucket.events[bucket.events.length - 1] = next;
    } else {
      bucket.events.push(next);
    }
  }

  private storeInGlobal(next: SequencedAgentEvent): void {
    const previous = this.globalEvents[this.globalEvents.length - 1];
    if (this.canCoalesce(previous, next)) {
      next.globalSeqStart = previous.globalSeqStart;
      this.globalEvents[this.globalEvents.length - 1] = next;
    } else {
      this.globalEvents.push(next);
    }
  }

  private prune(now: number): void {
    const globalCutoff = now - this.globalTtlMs;
    while (this.globalEvents[0]?.createdAt < globalCutoff) {
      this.recordGlobalEviction(this.globalEvents.shift()!);
    }

    this.pruneBuckets(this.sessions, now - this.sessionTtlMs);
    this.pruneBuckets(this.runs, now - this.runTtlMs);
  }

  private pruneBuckets<T extends EventBucket>(buckets: Map<string, T>, cutoff: number): void {
    for (const [id, bucket] of buckets) {
      while (bucket.events[0]?.createdAt < cutoff) bucket.events.shift();
      const listeners = "listeners" in bucket ? bucket.listeners : undefined;
      const hasListeners = listeners instanceof Set && listeners.size > 0;
      if (bucket.events.length === 0 && !hasListeners) buckets.delete(id);
    }
  }

  private trimBucket(bucket: EventBucket, maxEvents: number): void {
    if (bucket.events.length > maxEvents) {
      bucket.events.splice(0, bucket.events.length - maxEvents);
    }
  }

  private trimGlobal(): void {
    while (this.globalEvents.length > this.maxEvents) {
      this.recordGlobalEviction(this.globalEvents.shift()!);
    }
  }

  private recordGlobalEviction(event: SequencedAgentEvent): void {
    this.globalEvictedThrough = Math.max(this.globalEvictedThrough, event.globalSeq);
  }

  private unsubscribeFrom<T>(listeners: Set<T>, listener: T): Unsubscribe {
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      listeners.delete(listener);
    };
  }

  private notify(listeners: Set<EventListener>, event: SequencedAgentEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One broken listener must not break append or other subscribers.
      }
    }
  }
}

declare global {
  var __deerhuxAgentEventStore: EventStore | undefined;
}

export function getAgentEventStore(): EventStore {
  if (!globalThis.__deerhuxAgentEventStore) {
    globalThis.__deerhuxAgentEventStore = new EventStore();
  }
  return globalThis.__deerhuxAgentEventStore;
}

export type {
  AgentRuntimeEventBase,
  EventListener,
  GlobalEventListener,
  GlobalReplayResult,
  JournalCursor,
  ResumeDecision,
  SequencedAgentEvent,
  Unsubscribe,
};
