"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ChatWindow } from "./ChatWindow";
import { ChatFileExplorerButton } from "./ChatFileExplorerButton";
import type { ChatInputHandle, ChatInputState } from "./ChatInput";
import styles from "./QuickSessionDrawer.module.css";
import type { SessionInfo } from "@/lib/types";
import { getProjectDisplayName } from "@/lib/project-name";
import {
  QUICK_SESSION_DEFAULT_WIDTH,
  QUICK_SESSION_EXPANDED_COUNT,
} from "@/lib/quick-session-drawer";

const MAX_QUICK_SESSIONS = 6;
const SESSION_GAP = 10;
const SCROLLER_INLINE_PADDING = 20;

interface Props {
  open: boolean;
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  projectOptions: { cwd: string; displayName: string }[];
  newSessionRequestKey?: number;
  modelsRefreshKey?: number;
  simpleWaitingIndicator?: boolean;
  locked: boolean;
  onClose: () => void;
  onToggleLocked: () => void;
  onDismissSession: (sessionId: string) => void;
  onDiscardTemporarySessions: (sessionIds: string[]) => void;
  onTemporarySessionCwdChange: (sessionId: string, cwd: string) => void;
  onSessionCreated: (session: SessionInfo, replacedSessionId?: string) => void;
  onAgentRunningChange: (sessionId: string | null | undefined, running: boolean) => void;
  onAgentEnd: (sessionId: string, changedFiles?: string[]) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onOpenRoleConfig?: () => void;
}

function sessionTitle(session: SessionInfo): string {
  const title = session.name || session.firstMessage || "新会话";
  return title.length > 30 ? `${title.slice(0, 28)}...` : title;
}

function sortSessions(sessions: SessionInfo[], sentAt: Record<string, number>): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (session.id && !session.isSubagent) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = (sentAt[a.id] ?? Date.parse(a.modified)) || 0;
    const bTime = (sentAt[b.id] ?? Date.parse(b.modified)) || 0;
    return bTime - aTime;
  }).slice(0, MAX_QUICK_SESSIONS);
}

function createTemporarySession(cwd: string): SessionInfo {
  const now = new Date().toISOString();
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return {
    path: "",
    id,
    cwd,
    name: "新会话",
    created: now,
    modified: now,
    messageCount: 0,
    firstMessage: "",
  };
}

function DrawerLockButton({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.cardActionButton} ${locked ? styles.lockedButton : ""}`}
      onClick={onToggle}
      title={locked ? "取消锁定，失去焦点时自动收起" : "锁定抽屉，失去焦点时保持显示"}
      aria-label={locked ? "取消锁定抽屉" : "锁定抽屉"}
      aria-pressed={locked}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        {locked
          ? <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          : <path d="M8 10V7a4 4 0 0 1 7.5-2" />}
      </svg>
    </button>
  );
}

export function QuickSessionDrawer({
  open,
  sessions,
  sessionsLoaded,
  projectOptions,
  newSessionRequestKey = 0,
  modelsRefreshKey,
  simpleWaitingIndicator,
  locked,
  onClose,
  onToggleLocked,
  onDismissSession,
  onDiscardTemporarySessions,
  onTemporarySessionCwdChange,
  onSessionCreated,
  onAgentRunningChange,
  onAgentEnd,
  onOpenFile,
  onOpenRoleConfig,
}: Props) {
  const [sentAt, setSentAt] = useState<Record<string, number>>({});
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [mountedSessionIds, setMountedSessionIds] = useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(QUICK_SESSION_DEFAULT_WIDTH);
  const revealOffsetRef = useRef(0);
  const [revealOffset, setRevealOffset] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeChatInputRef = useRef<ChatInputHandle | null>(null);
  const draftsRef = useRef(new Map<string, ChatInputState>());
  const placeholderSessionIdsRef = useRef(new Set<string>());
  const sessionRenderKeysRef = useRef(new Map<string, string>());
  const handledNewSessionRequestRef = useRef(0);
  const revealDragRef = useRef({ screenX: 0, offset: 0 });
  const nativeResizeRef = useRef({ targetWidth: QUICK_SESSION_DEFAULT_WIDTH, running: false });
  const orderedSessions = useMemo(() => sortSessions(sessions, sentAt), [sentAt, sessions]);
  const cardWidth = QUICK_SESSION_DEFAULT_WIDTH - SCROLLER_INLINE_PADDING;
  const stripWidth = orderedSessions.length > 0
    ? SCROLLER_INLINE_PADDING + orderedSessions.length * cardWidth + (orderedSessions.length - 1) * SESSION_GAP
    : QUICK_SESSION_DEFAULT_WIDTH;
  const maximumRevealOffset = Math.max(0, stripWidth - viewportWidth);
  const visibleSessionCount = expanded ? QUICK_SESSION_EXPANDED_COUNT : 1;
  const visibleStartIndex = Math.max(0, Math.floor(revealOffset / (cardWidth + SESSION_GAP)));
  const visibleEndIndex = Math.min(orderedSessions.length - 1, visibleStartIndex + visibleSessionCount - 1);

  const widthThroughIndex = useCallback((index: number) => (
    SCROLLER_INLINE_PADDING + (index + 1) * cardWidth + index * SESSION_GAP
  ), [cardWidth]);

  const applyRevealOffset = useCallback((nextOffset: number) => {
    const clampedOffset = Math.min(maximumRevealOffset, Math.max(0, nextOffset));
    revealOffsetRef.current = clampedOffset;
    setRevealOffset(clampedOffset);
    if (scrollerRef.current) scrollerRef.current.scrollLeft = clampedOffset;

    const visibleRight = clampedOffset + viewportWidth;
    const revealedIndex = Math.min(
      orderedSessions.length - 1,
      Math.max(0, Math.floor((visibleRight - SCROLLER_INLINE_PADDING + SESSION_GAP) / (cardWidth + SESSION_GAP)) - 1),
    );
    setActiveIndex(Math.max(0, revealedIndex));
    return clampedOffset;
  }, [cardWidth, maximumRevealOffset, orderedSessions.length, viewportWidth]);

  const resizeNativeWindow = useCallback((targetWidth: number) => {
    if (!window.__TAURI_INTERNALS__) return;
    const resizeState = nativeResizeRef.current;
    resizeState.targetWidth = targetWidth;
    if (resizeState.running) return;
    resizeState.running = true;

    void import("@tauri-apps/api/core").then(async ({ invoke }) => {
      let appliedWidth = -1;
      while (appliedWidth !== resizeState.targetWidth) {
        const nextWidth = resizeState.targetWidth;
        await invoke("resize_quick_session_window", { width: nextWidth });
        appliedWidth = nextWidth;
      }
    }).catch(() => {}).finally(() => {
      resizeState.running = false;
    });
  }, []);

  const scrollToIndex = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nextIndex = Math.max(0, Math.min(index, Math.max(0, orderedSessions.length - 1)));
    applyRevealOffset(widthThroughIndex(nextIndex) - viewportWidth);
    setActiveIndex(nextIndex);
  }, [applyRevealOffset, orderedSessions.length, viewportWidth, widthThroughIndex]);

  useEffect(() => {
    const expandedWidth = SCROLLER_INLINE_PADDING
      + QUICK_SESSION_EXPANDED_COUNT * cardWidth
      + (QUICK_SESSION_EXPANDED_COUNT - 1) * SESSION_GAP;
    const availableWidth = window.screen.availWidth || expandedWidth;
    setViewportWidth(expanded ? Math.min(expandedWidth, availableWidth) : QUICK_SESSION_DEFAULT_WIDTH);
  }, [cardWidth, expanded]);

  useEffect(() => {
    resizeNativeWindow(viewportWidth);
  }, [resizeNativeWindow, viewportWidth]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const latestIndex = 0;
      scrollToIndex(latestIndex);
      window.setTimeout(() => scrollerRef.current?.querySelector<HTMLElement>(`[data-session-index="${latestIndex}"] textarea`)?.focus(), 180);
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open, orderedSessions.length, scrollToIndex]);

  useEffect(() => {
    if (activeIndex < orderedSessions.length) return;
    setActiveIndex(Math.max(0, orderedSessions.length - 1));
  }, [activeIndex, orderedSessions.length]);

  useEffect(() => {
    if (open) return;
    const temporarySessionIds = [...placeholderSessionIdsRef.current];
    if (temporarySessionIds.length > 0) {
      const temporaryIdSet = new Set(temporarySessionIds);
      placeholderSessionIdsRef.current.clear();
      for (const sessionId of temporarySessionIds) {
        draftsRef.current.delete(sessionId);
        sessionRenderKeysRef.current.delete(sessionId);
      }
      setMountedSessionIds((current) => new Set([...current].filter((sessionId) => !temporaryIdSet.has(sessionId))));
      setRunningIds((current) => new Set([...current].filter((sessionId) => !temporaryIdSet.has(sessionId))));
      setSentAt((current) => {
        const next = { ...current };
        for (const sessionId of temporarySessionIds) delete next[sessionId];
        return next;
      });
      onDiscardTemporarySessions(temporarySessionIds);
    }
    setExpanded(false);
    setActiveIndex(0);
    revealOffsetRef.current = 0;
    setRevealOffset(0);
    if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
    setViewportWidth(QUICK_SESSION_DEFAULT_WIDTH);
  }, [onDiscardTemporarySessions, open]);

  useEffect(() => {
    const availableIds = new Set(orderedSessions.map((session) => session.id));
    setMountedSessionIds((current) => {
      const next = new Set([...current].filter((sessionId) => availableIds.has(sessionId)));
      if (open) {
        const mountStartIndex = Math.max(0, Math.min(activeIndex, orderedSessions.length - QUICK_SESSION_EXPANDED_COUNT));
        const mountEndIndex = Math.min(orderedSessions.length - 1, mountStartIndex + QUICK_SESSION_EXPANDED_COUNT - 1);
        for (let index = mountStartIndex; index <= mountEndIndex; index += 1) {
          next.add(orderedSessions[index].id);
        }
      }
      if (next.size === current.size && [...next].every((sessionId) => current.has(sessionId))) return current;
      return next;
    });
  }, [activeIndex, open, orderedSessions]);

  const handleRevealStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    revealDragRef.current = { screenX: event.screenX, offset: revealOffsetRef.current };
  }, []);

  const handleRevealMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    applyRevealOffset(revealDragRef.current.offset + event.screenX - revealDragRef.current.screenX);
  }, [applyRevealOffset]);

  const handleRevealEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleRevealWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const horizontalDelta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : 0;
    if (horizontalDelta === 0) return;
    event.preventDefault();
    applyRevealOffset(revealOffsetRef.current + horizontalDelta);
  }, [applyRevealOffset]);

  const handleRevealKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextOffset: number | undefined;
    if (event.key === "ArrowRight") nextOffset = revealOffsetRef.current + 40;
    else if (event.key === "ArrowLeft") nextOffset = revealOffsetRef.current - 40;
    else if (event.key === "Home") nextOffset = 0;
    else if (event.key === "End") nextOffset = maximumRevealOffset;
    if (nextOffset === undefined) return;
    event.preventDefault();
    applyRevealOffset(nextOffset);
  }, [applyRevealOffset, maximumRevealOffset]);

  const markSessionSent = useCallback((sessionId: string) => {
    // Keep the sending card mounted while the same state update moves it to
    // the first position in the time-ordered strip.
    setActiveIndex(0);
    setSentAt((current) => ({ ...current, [sessionId]: Date.now() }));
    window.requestAnimationFrame(() => scrollToIndex(0));
  }, [scrollToIndex]);

  const handleCreated = useCallback((created: SessionInfo, sourceSessionId: string) => {
    const sourceRenderKey = sessionRenderKeysRef.current.get(sourceSessionId) ?? sourceSessionId;
    sessionRenderKeysRef.current.delete(sourceSessionId);
    sessionRenderKeysRef.current.set(created.id, sourceRenderKey);
    placeholderSessionIdsRef.current.delete(sourceSessionId);
    const sourceDraft = draftsRef.current.get(sourceSessionId);
    draftsRef.current.delete(sourceSessionId);
    if (sourceDraft) draftsRef.current.set(created.id, sourceDraft);
    setMountedSessionIds((current) => {
      const next = new Set(current);
      next.delete(sourceSessionId);
      next.add(created.id);
      return next;
    });
    setSentAt((current) => {
      const next = { ...current };
      delete next[sourceSessionId];
      next[created.id] = Date.now();
      return next;
    });
    setRunningIds((current) => {
      const next = new Set(current);
      next.delete(sourceSessionId);
      next.add(created.id);
      return next;
    });
    onSessionCreated(created, sourceSessionId);
    onAgentRunningChange(created.id, true);
  }, [onAgentRunningChange, onSessionCreated]);

  const handleNewSession = useCallback((cwd: string) => {
    const placeholder = createTemporarySession(cwd);
    placeholderSessionIdsRef.current.add(placeholder.id);
    sessionRenderKeysRef.current.set(placeholder.id, placeholder.id);
    setMountedSessionIds((current) => new Set(current).add(placeholder.id));
    setSentAt((current) => ({ ...current, [placeholder.id]: Date.now() }));
    setActiveIndex(0);
    onSessionCreated(placeholder);
    window.requestAnimationFrame(() => {
      scrollToIndex(0);
      window.setTimeout(() => scrollerRef.current?.querySelector<HTMLElement>('[data-session-index="0"] textarea')?.focus(), 0);
    });
  }, [onSessionCreated, scrollToIndex]);

  useEffect(() => {
    if (!open || newSessionRequestKey <= handledNewSessionRequestRef.current) return;
    const cwd = projectOptions[0]?.cwd ?? orderedSessions[0]?.cwd;
    if (!cwd) return;
    handledNewSessionRequestRef.current = newSessionRequestKey;
    handleNewSession(cwd);
  }, [handleNewSession, newSessionRequestKey, open, orderedSessions, projectOptions]);

  const handleRunningChange = useCallback((sessionId: string | null | undefined, running: boolean) => {
    if (sessionId) {
      setRunningIds((current) => {
        const next = new Set(current);
        if (running) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
    }
    onAgentRunningChange(sessionId, running);
  }, [onAgentRunningChange]);

  const handleEnd = useCallback((sessionId: string, changedFiles?: string[]) => {
    setRunningIds((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    onAgentEnd(sessionId, changedFiles);
  }, [onAgentEnd]);

  const handleForked = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" }).catch(() => null);
    const payload = response?.ok
      ? await response.json().catch(() => null) as { info?: SessionInfo | null } | null
      : null;
    if (payload?.info?.id) onSessionCreated(payload.info);
  }, [onSessionCreated]);

  const handleHeaderDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, textarea, select, [role='button']")) return;
    event.preventDefault();
    setExpanded((current) => !current);
  }, []);

  return (
    <aside
      aria-label="快捷会话"
      aria-hidden={!open}
      className={`${styles.drawer} ${open ? styles.open : styles.closed} ${expanded && viewportWidth > QUICK_SESSION_DEFAULT_WIDTH ? styles.expanded : ""}`}
      style={{
        width: "100vw",
        "--quick-session-card-width": `${cardWidth}px`,
      } as CSSProperties}
    >
      <div id="quick-session-strip" ref={scrollerRef} className={styles.sessionScroller} onWheel={handleRevealWheel}>
        {orderedSessions.length > 0 ? orderedSessions.map((session, index) => {
          const isActive = index === activeIndex;
          const isPlaceholder = placeholderSessionIdsRef.current.has(session.id);
          const shouldMount = mountedSessionIds.has(session.id)
            || runningIds.has(session.id)
            || (open && index >= visibleStartIndex && index < visibleStartIndex + visibleSessionCount);
          return (
            <section key={sessionRenderKeysRef.current.get(session.id) ?? session.id} className={styles.sessionCard} data-session-index={index}>
              <header className={styles.sessionHeader} onDoubleClick={handleHeaderDoubleClick} title="双击切换单会话/三会话显示">
                <span className={`${styles.statusDot} ${runningIds.has(session.id) ? styles.runningDot : ""}`} aria-hidden="true" />
                <strong title={session.name || session.firstMessage || session.id}>{sessionTitle(session)}</strong>
                {shouldMount && <ChatFileExplorerButton variant="header" cwd={session.cwd} onOpenFile={onOpenFile} onAtMention={(relativePath) => {
                  scrollToIndex(index);
                  window.setTimeout(() => activeChatInputRef.current?.addReference(relativePath), 0);
                }} />}
                <button type="button" className={styles.cardActionButton} onClick={() => handleNewSession(session.cwd)} title="新建会话" aria-label="新建会话">+</button>
                {!isPlaceholder && <button type="button" className={styles.cardActionButton} onClick={() => onDismissSession(session.id)} title="从快捷会话中隐藏" aria-label="从快捷会话中隐藏">×</button>}
                {index === visibleEndIndex && <DrawerLockButton locked={locked} onToggle={onToggleLocked} />}
              </header>
              <div className={styles.sessionBody}>
                <div className={styles.projectWatermark} aria-hidden="true">{getProjectDisplayName(session.cwd)}</div>
                {shouldMount && <ChatWindow
                  activeTabId={`quick-session:${session.id}`}
                  isFocused={open && isActive}
                  streamRenderPriority={open ? (isActive ? "focused" : "visible") : "hidden"}
                  simpleWaitingIndicator={simpleWaitingIndicator}
                  session={isPlaceholder ? null : session}
                  newSessionCwd={isPlaceholder ? session.cwd : null}
                  compact
                  isSessionRunning={runningIds.has(session.id)}
                  onSessionStarted={() => markSessionSent(session.id)}
                  onSessionCreated={(created) => handleCreated(created, session.id)}
                  onAgentRunningChange={handleRunningChange}
                  onAgentEnd={handleEnd}
                  onSessionForked={handleForked}
                  modelsRefreshKey={modelsRefreshKey}
                  chatInputRef={isActive ? activeChatInputRef : undefined}
                  onOpenFile={onOpenFile}
                  onOpenRoleConfig={onOpenRoleConfig}
                  projectOptions={projectOptions}
                  onNewSessionCwdChange={isPlaceholder ? (cwd) => onTemporarySessionCwdChange(session.id, cwd) : undefined}
                  initialInputState={draftsRef.current.get(session.id) ?? null}
                  saveInputState={(draft) => { draftsRef.current.set(session.id, draft); }}
                />}
              </div>
            </section>
          );
        }) : (
          <section className={styles.sessionCard} data-session-index="0">
            <header className={styles.sessionHeader} onDoubleClick={handleHeaderDoubleClick} title="双击切换单会话/三会话显示"><span className={styles.statusDot} aria-hidden="true" /><strong>{sessionsLoaded ? "暂无会话" : "正在加载"}</strong>{projectOptions[0]?.cwd && <button type="button" className={styles.cardActionButton} onClick={() => handleNewSession(projectOptions[0].cwd)} title="新建会话" aria-label="新建会话">+</button>}<DrawerLockButton locked={locked} onToggle={onToggleLocked} /></header>
            <div className={styles.sessionBody}>
              <div className={styles.loading}>{sessionsLoaded ? "暂无最近会话" : "正在加载最近会话..."}</div>
            </div>
          </section>
        )}
      </div>
      <div
        className={styles.revealScrollbar}
        role="scrollbar"
        aria-label="展开快捷会话"
        aria-controls="quick-session-strip"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={maximumRevealOffset}
        aria-valuenow={revealOffset}
        tabIndex={0}
        onPointerDown={handleRevealStart}
        onPointerMove={handleRevealMove}
        onPointerUp={handleRevealEnd}
        onPointerCancel={handleRevealEnd}
        onWheel={handleRevealWheel}
        onKeyDown={handleRevealKeyDown}
      >
        <div
          className={styles.revealProgress}
          style={{ width: `${maximumRevealOffset > 0 ? (revealOffset / maximumRevealOffset) * 100 : 0}%` }}
        />
      </div>
    </aside>
  );
}
