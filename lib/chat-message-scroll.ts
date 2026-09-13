export function getChatMessageScrollTop(container: HTMLElement, message: HTMLElement): number | null {
  if (!container.contains(message)) return null;
  // Cross the viewport boundary so the existing scroll-based prompt selector advances.
  const top = container.scrollTop + message.getBoundingClientRect().top
    - container.getBoundingClientRect().top - container.clientTop + 2;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  // At the end, the prompt is already visible but start alignment may be unreachable.
  // Move backward within existing content so the scroll-based selector can respond.
  if (top > maxTop && maxTop > 0 && container.scrollTop >= maxTop - 1) {
    return Math.max(0, Math.min(container.scrollTop, maxTop) - 2);
  }
  return Math.max(0, Math.min(top, maxTop));
}

