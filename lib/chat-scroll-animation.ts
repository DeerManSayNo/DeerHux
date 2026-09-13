export function getPromptScrollDuration(distance: number): number {
  return Math.min(1200, Math.max(700, 500 + Math.sqrt(Math.abs(distance)) * 18));
}

export function easeOutPromptScroll(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return 1 - (1 - t) ** 3;
}

export function animatePromptScroll(
  container: Pick<HTMLElement, "scrollTop" | "scrollTo">,
  top: number,
  reducedMotion: boolean,
): () => void {
  const start = container.scrollTop;
  const distance = top - start;
  if (reducedMotion || Math.abs(distance) < 1) {
    container.scrollTo({ top, behavior: "instant" });
    return () => {};
  }
  // Stop any browser-managed scroll before driving the easing ourselves.
  container.scrollTo({ top: start, behavior: "instant" });
  const duration = getPromptScrollDuration(distance);
  let startedAt: number | null = null;
  let frame: number | null = null;
  let cancelled = false;
  const step = (time: number) => {
    if (cancelled) return;
    startedAt ??= time;
    const progress = Math.min(1, (time - startedAt) / duration);
    container.scrollTo({ top: start + distance * easeOutPromptScroll(progress), behavior: "instant" });
    frame = progress < 1 ? requestAnimationFrame(step) : null;
  };
  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
