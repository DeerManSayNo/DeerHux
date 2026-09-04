/** Map thumb travel (not content pixels) to a bounded content scroll offset. */
export function scrollbarOffset(position: number, travel: number, maximumOffset: number): number {
  if (travel <= 0 || maximumOffset <= 0) return 0;
  return Math.max(0, Math.min(maximumOffset, position / travel * maximumOffset));
}
