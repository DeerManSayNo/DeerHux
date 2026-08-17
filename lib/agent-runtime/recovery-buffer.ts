export interface RecoveryBufferedEvent {
  epoch: string;
  globalSeq: number;
}

export function eligibleRecoveryEvents<T extends RecoveryBufferedEvent>(
  events: readonly T[],
  epoch: string,
  afterGlobalSeq: number,
): T[] {
  return events
    .filter((event) => event.epoch === epoch && event.globalSeq > afterGlobalSeq)
    .sort((a, b) => a.globalSeq - b.globalSeq);
}

export function businessRecoveryDelayMs(attempt: number, maximumMs = 15_000): number {
  return attempt <= 0 ? 0 : Math.min(500 * 2 ** (attempt - 1), maximumMs);
}
