"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Grow for edits, restored drafts and wrapping changes when a window is resized. */
export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, enabled = true) {
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!enabled || !textarea) return;
    const resize = () => {
      if (!textarea.clientWidth) return;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [ref, value, enabled]);
}
