"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import { copyText, MessageMarkdown } from "./MessageView";
import {
  SELECTION_ASSISTANT_READY_EVENT,
  SELECTION_ASSISTANT_REQUEST_EVENT,
  SELECTION_ASSISTANT_WINDOW_LABEL,
  selectionAssistantStorageKey,
  type SelectionAssistantRequest,
} from "@/lib/selection-assistant-window";
import styles from "./SelectionExplainOverlay.module.css";

type AnchorRect = { top: number; right: number; bottom: number; left: number; width: number; height: number };
type SelectionSnapshot = { text: string; anchor: AnchorRect; pointer: { x: number; y: number } | null };
type WindowPosition = { left: number; top: number };
/** 只读旁路请求：解释选中文字，或对当前上下文提问。 */
type AskMode = "explain" | "ask";
type AskState = Omit<SelectionSnapshot, "pointer"> & {
  mode: AskMode;
  question: string;
  content: string;
  error: string;
  status: "loading" | "streaming" | "done" | "error";
};
type ContextMenuState = { x: number; y: number };
/** 提问输入框：quote 为引用的选中文字，可为空（空白处提问）。 */
type ComposerState = { x: number; y: number; question: string; quote: string; quoteExpanded: boolean };

const VIEWPORT_GAP = 8;
const FLOATING_GAP = 8;
const CONTEXT_MENU_WIDTH = 152;
const CONTEXT_MENU_HEIGHT = 44;
const MENU_POINTER_OFFSET_X = 6;
const MENU_POINTER_OFFSET_Y = 6;
const COMPOSER_WIDTH = 380;
const COMPOSER_HEIGHT = 38;

function parentElement(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function anchorFromRange(range: Range): AnchorRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const rect = rects.at(-1) ?? range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
}

function floatingPosition(element: HTMLElement, anchor: AnchorRect, align: "menu" | "window"): WindowPosition {
  const bounds = element.getBoundingClientRect();
  const centered = anchor.left + anchor.width / 2 - bounds.width / 2;
  const preferredLeft = align === "window" ? anchor.right - bounds.width : centered;
  const left = Math.max(VIEWPORT_GAP, Math.min(preferredLeft, window.innerWidth - bounds.width - VIEWPORT_GAP));
  const above = anchor.top - bounds.height - FLOATING_GAP;
  const below = anchor.bottom + FLOATING_GAP;
  const top = above >= VIEWPORT_GAP
    ? above
    : Math.max(VIEWPORT_GAP, Math.min(below, window.innerHeight - bounds.height - VIEWPORT_GAP));
  return { left, top };
}

function positionFloating(element: HTMLElement, anchor: AnchorRect, align: "menu" | "window") {
  const position = floatingPosition(element, anchor, align);
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
}

/** 指针松开位置：菜单从光标右下角展开，靠近视口边缘时翻转到另一侧。 */
function positionFromPointer(element: HTMLElement, pointer: { x: number; y: number }) {
  const bounds = element.getBoundingClientRect();
  const right = pointer.x + MENU_POINTER_OFFSET_X;
  const below = pointer.y + MENU_POINTER_OFFSET_Y;
  const left = right + bounds.width <= window.innerWidth - VIEWPORT_GAP
    ? right
    : Math.max(VIEWPORT_GAP, pointer.x - bounds.width - MENU_POINTER_OFFSET_X);
  const top = below + bounds.height <= window.innerHeight - VIEWPORT_GAP
    ? below
    : Math.max(VIEWPORT_GAP, pointer.y - bounds.height - MENU_POINTER_OFFSET_Y);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || "暂时无法解释这段内容";
  } catch {
    return "暂时无法解释这段内容";
  }
}

async function openNativeAssistantWindow(request: SelectionAssistantRequest, anchor: AnchorRect): Promise<boolean> {
  if (!window.__TAURI_INTERNALS__) return false;
  const requestId = crypto.randomUUID();
  const storageKey = selectionAssistantStorageKey(requestId);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(request));
    const [{ WebviewWindow }, { getCurrentWindow }, { emitTo, listen }] = await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/event"),
    ]);
    let unlistenReady: (() => void) | null = null;
    unlistenReady = await listen<{ requestId?: string }>(SELECTION_ASSISTANT_READY_EVENT, (event) => {
      if (event.payload?.requestId !== requestId) return;
      void emitTo(SELECTION_ASSISTANT_WINDOW_LABEL, SELECTION_ASSISTANT_REQUEST_EVENT, { requestId, request });
      unlistenReady?.();
      unlistenReady = null;
    });
    window.setTimeout(() => {
      unlistenReady?.();
      unlistenReady = null;
    }, 10_000);

    const existing = await WebviewWindow.getByLabel(SELECTION_ASSISTANT_WINDOW_LABEL);
    if (existing) await existing.close();

    const mainWindow = getCurrentWindow();
    const [origin, scaleFactor] = await Promise.all([mainWindow.outerPosition(), mainWindow.scaleFactor()]);
    const x = Math.round(origin.x / scaleFactor + anchor.left);
    const y = Math.round(origin.y / scaleFactor + anchor.bottom + FLOATING_GAP);
    const url = new URL("/selection-assistant", window.location.href);
    url.searchParams.set("request", requestId);

    const assistantWindow = new WebviewWindow(SELECTION_ASSISTANT_WINDOW_LABEL, {
      url: url.toString(),
      title: "只读问答",
      width: 344,
      height: 238,
      minWidth: 344,
      minHeight: 238,
      x,
      y,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: true,
    });
    await new Promise<void>((resolve, reject) => {
      void assistantWindow.once("tauri://created", () => resolve());
      void assistantWindow.once("tauri://error", (event) => reject(new Error(String(event.payload))));
    });
    return true;
  } catch {
    window.localStorage.removeItem(storageKey);
    return false;
  }
}

export function SelectionExplainOverlay({ sessionId, children }: { sessionId?: string | null; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [explain, setExplain] = useState<AskState | null>(null);
  const [windowPosition, setWindowPosition] = useState<WindowPosition | null>(null);
  const [copied, setCopied] = useState<"selection" | "result" | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);

  const closeExplanation = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setExplain(null);
    setWindowPosition(null);
    dragRef.current = null;
    returnFocusRef.current?.focus({ preventScroll: true });
    returnFocusRef.current = null;
  }, []);

  useEffect(() => {
    setSelection(null);
    setContextMenu(null);
    setComposer(null);
    closeExplanation();
  }, [sessionId, closeExplanation]);

  useEffect(() => () => {
    requestRef.current?.abort();
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const readSelection = useCallback((keyboard: boolean, pointer: { x: number; y: number } | null = null) => {
    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount !== 1) {
      setSelection(null);
      return;
    }
    const range = browserSelection.getRangeAt(0);
    const startBody = parentElement(range.startContainer)?.closest<HTMLElement>("[data-message-body]");
    const endBody = parentElement(range.endContainer)?.closest<HTMLElement>("[data-message-body]");
    const root = rootRef.current;
    if (!root || !startBody || startBody !== endBody || !root.contains(startBody) || startBody.closest("[data-selection-explain-ui]")) {
      setSelection(null);
      return;
    }
    const text = browserSelection.toString().trim();
    const anchor = anchorFromRange(range);
    if (!text || !anchor) {
      setSelection(null);
      return;
    }
    closeExplanation();
    returnFocusRef.current = keyboard && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection({ text, anchor, pointer });
    if (keyboard) window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }), 0);
  }, [closeExplanation]);

  const runAsk = useCallback(async (request: {
    mode: AskMode;
    anchor: AnchorRect;
    text?: string;
    question?: string;
  }) => {
    const openedFromKeyboard = Boolean(menuRef.current?.contains(document.activeElement));
    setSelection(null);
    setContextMenu(null);
    setComposer(null);
    setWindowPosition(null);
    const text = request.text ?? "";
    if (!sessionId) {
      setExplain({
        text,
        anchor: request.anchor,
        mode: request.mode,
        question: request.question ?? "",
        content: "",
        error: request.mode === "explain" ? "当前会话尚未建立，无法解释选中内容" : "当前会话尚未建立，无法提问",
        status: "error",
      });
      if (openedFromKeyboard) window.setTimeout(() => windowRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }), 0);
      return;
    }

    const openedNative = await openNativeAssistantWindow({
      sessionId,
      mode: request.mode,
      text,
      question: request.question ?? "",
    }, request.anchor);
    if (openedNative) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setExplain({
      text,
      anchor: request.anchor,
      mode: request.mode,
      question: request.question ?? "",
      content: "",
      error: "",
      status: "loading",
    });
    if (openedFromKeyboard) window.setTimeout(() => windowRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }), 0);

    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: request.mode, text, question: request.question ?? "" }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.body) throw new Error("只读问答服务没有返回内容");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let finished = false;
      while (!finished) {
        const chunk = await reader.read();
        finished = chunk.done;
        buffered += decoder.decode(chunk.value, { stream: !finished });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type?: string; text?: string; message?: string };
          if (event.type === "delta" && event.text) {
            setExplain((current) => current ? { ...current, content: current.content + event.text, status: "streaming" } : current);
          } else if (event.type === "done") {
            setExplain((current) => current ? { ...current, status: "done" } : current);
          } else if (event.type === "error") {
            throw new Error(event.message || "暂时无法回答");
          }
        }
      }
      setExplain((current) => current && current.status !== "done" ? { ...current, status: "done" } : current);
    } catch (error) {
      if (controller.signal.aborted) return;
      setExplain((current) => current ? {
        ...current,
        error: error instanceof Error ? error.message : "暂时无法回答",
        status: "error",
      } : current);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, [sessionId]);

  const startExplanation = useCallback((snapshot: SelectionSnapshot) => {
    void runAsk({ mode: "explain", anchor: snapshot.anchor, text: snapshot.text });
  }, [runAsk]);

  const startQuestion = useCallback((question: string, anchor: AnchorRect, quote = "") => {
    const trimmed = question.trim();
    if (!trimmed) return;
    void runAsk({ mode: "ask", anchor, question: trimmed, text: quote.trim() || undefined });
  }, [runAsk]);

  const markCopied = useCallback((target: "selection" | "result") => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopied(target);
    copyTimerRef.current = setTimeout(() => setCopied(null), 1200);
  }, []);

  const copySelection = useCallback(async () => {
    if (!selection) return;
    try {
      await copyText(selection.text);
      markCopied("selection");
      window.setTimeout(() => setSelection(null), 180);
    } catch {
      // Keep the menu open so the action can be retried.
    }
  }, [markCopied, selection]);

  useLayoutEffect(() => {
    if (!selection || !menuRef.current) return;
    if (selection.pointer) positionFromPointer(menuRef.current, selection.pointer);
    else positionFloating(menuRef.current, selection.anchor, "menu");
  }, [selection, copied]);

  const explainAnchor = explain?.anchor;
  useLayoutEffect(() => {
    if (explainAnchor && windowRef.current && !windowPosition) {
      setWindowPosition(floatingPosition(windowRef.current, explainAnchor, "window"));
    }
  }, [explainAnchor, windowPosition]);

  const clampWindowPosition = useCallback((left: number, top: number): WindowPosition => {
    const bounds = windowRef.current?.getBoundingClientRect();
    const width = bounds?.width ?? 0;
    const height = bounds?.height ?? 0;
    return {
      left: Math.max(VIEWPORT_GAP, Math.min(left, window.innerWidth - width - VIEWPORT_GAP)),
      top: Math.max(VIEWPORT_GAP, Math.min(top, window.innerHeight - height - VIEWPORT_GAP)),
    };
  }, []);

  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !windowRef.current) return;
    const bounds = windowRef.current.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWindowPosition(clampWindowPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY));
  };

  const stopDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const moveWindowWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!windowRef.current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const bounds = windowRef.current.getBoundingClientRect();
    const step = event.shiftKey ? 24 : 8;
    const left = bounds.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0);
    const top = bounds.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
    setWindowPosition(clampWindowPosition(left, top));
  };

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (selection && !menuRef.current?.contains(target)) setSelection(null);
      if (contextMenu && !contextMenuRef.current?.contains(target)) setContextMenu(null);
      if (composer && !composerRef.current?.contains(target)) setComposer(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (selection) setSelection(null);
        else if (contextMenu) setContextMenu(null);
        else if (composer) setComposer(null);
        else if (explain) closeExplanation();
        return;
      }
      if (!selection || !menuRef.current || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
          : event.key === "ArrowDown" ? (current + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus({ preventScroll: true });
    };
    const onScroll = () => {
      setSelection(null);
      setContextMenu(null);
      setComposer(null);
    };
    const onResize = () => {
      setSelection(null);
      setContextMenu(null);
      setComposer(null);
      const bounds = windowRef.current?.getBoundingClientRect();
      if (bounds) setWindowPosition(clampWindowPosition(bounds.left, bounds.top));
    };
    const onWindowBlur = () => {
      setSelection(null);
      setContextMenu(null);
      setComposer(null);
      if (explain) closeExplanation();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [clampWindowPosition, closeExplanation, composer, contextMenu, explain, selection]);

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("[data-selection-explain-ui]")) return;
    const pointer = { x: event.clientX, y: event.clientY };
    window.requestAnimationFrame(() => readSelection(false, pointer));
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-selection-explain-ui]")) return;
    if (!event.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    readSelection(true);
  };

  /** 空白处右键：只认聊天滚动区域内的非交互内容，避免抢占链接、工具面板和输入框的原生菜单。 */
  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-selection-explain-ui]")) return;
    if (target.closest("a, button, input, textarea, select, [contenteditable='true'], [data-chat-composer], .markdown-body pre")) return;
    const scrollArea = target.closest("[data-chat-scroll-area]");
    if (!scrollArea) return;
    event.preventDefault();
    setSelection(null);
    setComposer(null);
    const x = Math.max(VIEWPORT_GAP, Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_GAP));
    const y = Math.max(VIEWPORT_GAP, Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_GAP));
    setContextMenu({ x, y });
  };

  const openComposer = useCallback((anchor: { x: number; y: number }, quote = "") => {
    setContextMenu(null);
    const left = Math.max(VIEWPORT_GAP, Math.min(anchor.x, window.innerWidth - COMPOSER_WIDTH - VIEWPORT_GAP));
    const top = Math.max(VIEWPORT_GAP, Math.min(anchor.y, window.innerHeight - COMPOSER_HEIGHT - VIEWPORT_GAP));
    setComposer({ x: left, y: top, question: "", quote, quoteExpanded: false });
    window.setTimeout(() => composerInputRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  const submitQuestion = useCallback(() => {
    if (!composer) return;
    const question = composer.question.trim();
    if (!question) {
      composerInputRef.current?.focus({ preventScroll: true });
      return;
    }
    const point = { top: composer.y, bottom: composer.y, left: composer.x, right: composer.x, width: 0, height: 0 };
    startQuestion(question, point, composer.quote);
  }, [composer, startQuestion]);

  return (
    <div ref={rootRef} className={styles.scope} onPointerUp={onPointerUp} onKeyUp={onKeyUp} onContextMenu={onContextMenu}>
      {children}
      {selection && createPortal(
        <div
          ref={menuRef}
          className={`${styles.menu} context-menu-glass`}
          data-selection-explain-ui
          role="menu"
          aria-label="选中文字操作"
          style={{ left: selection.anchor.left, top: selection.anchor.top }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => void copySelection()}>
            <AppIcon name={copied === "selection" ? "check" : "copy"} size="compact" />
            {copied === "selection" ? "已复制" : "复制"}
          </button>
          <button type="button" role="menuitem" onClick={() => startExplanation(selection)}>
            <AppIcon name="thinking" size="compact" />
            解释
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const point = { x: selection.anchor.left, y: selection.anchor.bottom };
              openComposer(point, selection.text);
            }}
          >
            <AppIcon name="prompt" size="compact" />
            提问
          </button>
        </div>,
        document.body,
      )}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className={`${styles.menu} context-menu-glass`}
          data-selection-explain-ui
          role="menu"
          aria-label="空白处操作"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => openComposer(contextMenu)}>
            <AppIcon name="prompt" size="compact" />
            提问
          </button>
        </div>,
        document.body,
      )}
      {composer && createPortal(
        <div
          ref={composerRef}
          className={styles.composer}
          data-selection-explain-ui
          role="group"
          aria-label="对当前上下文提问"
          style={{ left: composer.x, top: composer.y }}
        >
          {composer.quote && (
            <div className={styles.composerQuote}>
              <button
                type="button"
                className={styles.composerQuoteText}
                onClick={() => setComposer((current) => current ? { ...current, quoteExpanded: !current.quoteExpanded } : current)}
                title={composer.quoteExpanded ? "收起引用" : "展开引用"}
                aria-expanded={composer.quoteExpanded}
              >
                {composer.quote}
              </button>
              <button
                type="button"
                className={styles.composerQuoteRemove}
                aria-label="移除引用"
                title="移除引用"
                onClick={() => {
                  setComposer((current) => current ? { ...current, quote: "", quoteExpanded: false } : current);
                  window.setTimeout(() => composerInputRef.current?.focus({ preventScroll: true }), 0);
                }}
              >
                <AppIcon name="close" size="compact" />
              </button>
            </div>
          )}
          <input
            ref={composerInputRef}
            className={styles.composerInput}
            value={composer.question}
            placeholder={composer.quote ? "针对引用的内容提问…" : "对当前上下文提问…"}
            aria-label="问题"
            onChange={(event) => setComposer((current) => current ? { ...current, question: event.target.value } : current)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitQuestion();
              }
            }}
          />
          <button
            type="button"
            className={styles.composerSend}
            disabled={!composer.question.trim()}
            aria-label="发送提问"
            title="发送提问"
            onClick={submitQuestion}
          >
            <AppIcon name="send" size="compact" />
          </button>
        </div>,
        document.body,
      )}
      {explain && createPortal(
        <section
          ref={windowRef}
          className={`${styles.window} adaptive-glass-surface`}
          data-selection-explain-ui
          role="dialog"
          aria-label={explain.mode === "explain" ? "选中文字解释" : "上下文提问回答"}
          aria-live="polite"
          style={{ left: windowPosition?.left ?? explain.anchor.left, top: windowPosition?.top ?? explain.anchor.bottom }}
        >
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconButton}
              disabled={!explain.content}
              title={copied === "result" ? "已复制" : "复制回答"}
              aria-label={copied === "result" ? "回答已复制" : "复制回答"}
              onClick={() => void copyText(explain.content).then(() => markCopied("result"))}
            >
              <AppIcon name={copied === "result" ? "check" : "copy"} size="compact" />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              title="关闭"
              aria-label="关闭"
              onClick={closeExplanation}
            >
              <AppIcon name="close" size="compact" />
            </button>
          </div>
          <button
            type="button"
            className={styles.quote}
            aria-label="移动窗口"
            title={explain.mode === "explain" ? explain.text : explain.text ? `“${explain.text}”\n${explain.question}` : explain.question}
            onPointerDown={startDragging}
            onPointerMove={moveDragging}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onKeyDown={moveWindowWithKeyboard}
          >
            {explain.mode === "explain" && `“${explain.text}”`}
            {explain.mode === "ask" && (
              explain.text ? (
                <>
                  <span className={styles.quoteReference}>“{explain.text}”</span>
                  <span className={styles.quoteQuestion}>{explain.question}</span>
                </>
              ) : explain.question
            )}
          </button>
          <div className={styles.body}>
            {explain.content && <MessageMarkdown text={explain.content} isStreaming={explain.status === "streaming"} />}
            {explain.status === "loading" && (
              <div className={styles.loading}>
                <AppIcon name="loading" size="compact" />
                {explain.mode === "explain" ? "正在解释…" : "正在回答…"}
              </div>
            )}
            {explain.status === "error" && (
              <div className={styles.error} role="alert">
                <span>{explain.error}</span>
                <button
                  type="button"
                  onClick={() => explain.mode === "explain"
                    ? startExplanation({ text: explain.text, anchor: explain.anchor, pointer: null })
                    : startQuestion(explain.question, explain.anchor)}
                >
                  重试
                </button>
              </div>
            )}
          </div>
        </section>,
        document.body,
      )}
    </div>
  );
}
