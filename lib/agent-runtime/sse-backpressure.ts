export const SSE_HIGH_WATER_MARK_BYTES = 1024 * 1024;
export const SSE_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export function isSseConsumerOverBudget(desiredSize: number | null): boolean {
  return desiredSize !== null && desiredSize <= -SSE_MAX_QUEUED_BYTES;
}

export function sseByteStrategy(): QueuingStrategy<Uint8Array> {
  return new ByteLengthQueuingStrategy({ highWaterMark: SSE_HIGH_WATER_MARK_BYTES });
}
