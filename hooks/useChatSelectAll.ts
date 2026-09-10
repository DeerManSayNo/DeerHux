"use client";

import { useEffect, type RefObject } from "react";

/** Keep Cmd/Ctrl+A within the session, preserving native editor selection. */
export function useChatSelectAll(messagesRef: RefObject<HTMLDivElement | null>, isFocused: boolean) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey)
        || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
      const messages = messagesRef.current;
      const chat = messages?.closest(".chat-window-wrap");
      if (!messages || !chat) {
        if (isFocused) {
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
        }
        return;
      }
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const sourceChat = target?.closest(".chat-window-wrap") ?? anchorElement?.closest(".chat-window-wrap");
      if (sourceChat ? sourceChat !== chat : !isFocused) return;
      // A selection in a separate file/editor pane belongs to that pane.
      if (!sourceChat && selection && !selection.isCollapsed && anchorElement && !chat.contains(anchorElement)) return;
      event.preventDefault();
      event.stopPropagation();
      const bodies = Array.from(messages.querySelectorAll<HTMLElement>("[data-message-body]")).filter((body) => body.getClientRects().length);
      if (!bodies.length) { selection?.removeAllRanges(); return; }
      const range = document.createRange();
      range.setStart(bodies[0], 0);
      const last = bodies[bodies.length - 1];
      range.setEnd(last, last.childNodes.length);
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    const copy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
      const selection = window.getSelection();
      const messages = messagesRef.current;
      if (!selection || selection.isCollapsed || !selection.rangeCount || !messages) return;
      const selected = selection.getRangeAt(0);
      if (!messages.contains(selected.commonAncestorContainer)) return;
      const output = document.createElement("div");
      for (const body of messages.querySelectorAll<HTMLElement>("[data-message-body]")) {
        if (!body.getClientRects().length || !selected.intersectsNode(body)) continue;
        const part = document.createRange();
        part.selectNodeContents(body);
        if (selected.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(selected.startContainer, selected.startOffset);
        if (selected.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(selected.endContainer, selected.endOffset);
        const block = document.createElement("div");
        block.append(part.cloneContents());
        block.querySelectorAll("[data-selection-ignore], .linenumber, button, [aria-hidden='true']").forEach((node) => node.remove());
        // Presentation-only line wrappers must not introduce extra copied lines.
        block.querySelectorAll(".chat-code-line").forEach((line) => { line.replaceWith(document.createTextNode(line.textContent ?? "")); });
        block.querySelectorAll("pre").forEach((pre) => { pre.textContent = pre.textContent; });
        output.append(block);
      }
      if (!output.childNodes.length) return;
      // Measure text in a rendered, offscreen container to retain paragraph and
      // code line breaks, while excluding message metadata from both formats.
      output.style.cssText = "position:fixed;left:-100000px;top:0;white-space:pre-wrap;pointer-events:none";
      document.body.append(output);
      try {
        event.clipboardData.setData("text/plain", output.innerText);
        event.clipboardData.setData("text/html", output.innerHTML);
        event.preventDefault();
      } finally { output.remove(); }
    };
    document.addEventListener("keydown", handle);
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("keydown", handle);
      document.removeEventListener("copy", copy);
    };
  }, [messagesRef, isFocused]);
}
