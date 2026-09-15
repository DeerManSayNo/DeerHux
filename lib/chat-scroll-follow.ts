// Input intent is separate from geometry: resizing must never resume tracking.
export function bindChatScrollFollow(
  container: HTMLElement,
  content: HTMLElement,
  callbacks: { pause: () => void; resume: () => void; followResize: () => void; interrupt: () => void },
) {
  let touchY: number | null = null;
  let downward: { top: number; height: number; viewport: number } | null = null;
  const ownsScroll = (target: EventTarget | null, delta: number) => {
    let element = target instanceof Element ? target : null;
    while (element && element !== container) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) {
        const canScroll = delta < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight;
        if (canScroll || /contain|none/.test(style.overscrollBehaviorY)) return false;
      }
      element = element.parentElement;
    }
    return element === container;
  };
  const intent = (delta: number, target: EventTarget | null) => {
    if (!delta || !ownsScroll(target, delta)) return;
    callbacks.interrupt();
    downward = null;
    if (delta < 0) callbacks.pause();
    else if (container.scrollHeight - container.clientHeight - container.scrollTop < 80) callbacks.resume();
    else downward = { top: container.scrollTop, height: container.scrollHeight, viewport: container.clientHeight };
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) intent(event.deltaY, event.target);
  };
  const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; };
  const touchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) { touchY = null; return; }
    const next = event.touches[0].clientY;
    if (touchY !== null) intent(touchY - next, event.target);
    touchY = next;
  };
  const touchEnd = () => { touchY = null; };
  const keyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]')) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) intent(-1, event.target);
    if (["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey)) intent(1, event.target);
  };
  const scroll = () => {
    const pending = downward;
    if (!pending) return;
    if (container.scrollHeight !== pending.height || container.clientHeight !== pending.viewport || container.scrollTop < pending.top) {
      downward = null;
      return;
    }
    // Passive wheel listeners may run after the compositor has moved scrollTop.
    if (container.scrollTop >= pending.top && container.scrollHeight - container.clientHeight - container.scrollTop < 80) {
      downward = null;
      callbacks.resume();
    } else pending.top = container.scrollTop;
  };
  const observer = new ResizeObserver(() => {
    downward = null;
    callbacks.followResize();
  });
  observer.observe(container);
  observer.observe(content);
  container.addEventListener("wheel", wheel, { passive: true });
  container.addEventListener("touchstart", touchStart, { passive: true });
  container.addEventListener("touchmove", touchMove, { passive: true });
  container.addEventListener("touchend", touchEnd, { passive: true });
  container.addEventListener("touchcancel", touchEnd, { passive: true });
  container.addEventListener("keydown", keyDown);
  container.addEventListener("scroll", scroll, { passive: true });
  return () => {
    observer.disconnect();
    container.removeEventListener("wheel", wheel);
    container.removeEventListener("touchstart", touchStart);
    container.removeEventListener("touchmove", touchMove);
    container.removeEventListener("touchend", touchEnd);
    container.removeEventListener("touchcancel", touchEnd);
    container.removeEventListener("keydown", keyDown);
    container.removeEventListener("scroll", scroll);
  };
}
