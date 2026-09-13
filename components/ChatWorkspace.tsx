"use client";

import { AppIcon } from "./AppIcon";

import { useEffect, useId, useRef, type RefObject } from "react";
import type { ChatInputHandle, ChatInputState } from "./ChatInput";
import { ChatWindow } from "./ChatWindow";
import type { SessionInfo } from "@/lib/types";

export type ChatLayoutMode = "single" | "double" | "triple" | "quad" | "six";

export const CHAT_LAYOUT_COUNTS: Record<ChatLayoutMode, number> = {
  single: 1,
  double: 2,
  triple: 3,
  quad: 4,
  six: 6,
};

interface ChatWorkspaceProps {
  layoutMode: ChatLayoutMode;
  slotIds: (string | null)[];
  sessions: SessionInfo[];
  focusedSlotIndex: number;
  isPlaceholderSession: (sessionId: string) => boolean;
  runningSessionIds: Set<string>;
  modelsRefreshKey?: number;
  chatInputRef?: RefObject<ChatInputHandle | null>;
  onFocusSlot: (slotIndex: number) => void;
  onClearSlot: (slotIndex: number) => void;
  onAgentEnd?: (sessionId: string, changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo, slotIndex: number, sourceSessionId: string | null, running?: boolean) => void;
  onSessionStarted?: (session: SessionInfo | null, slotIndex: number, sourceSessionId: string | null) => void;
  onAgentRunningChange?: (sessionId: string | null | undefined, running: boolean) => void;
  onSessionForked?: (newSessionId: string, slotIndex: number, sourceSessionId: string | null) => void;
  onSessionStatsChange?: (stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onRevealFile?: (filePath: string, cwd: string, slotIndex: number) => void;
  onOpenExplorer?: (slotIndex: number) => void;
  onOpenRoleConfig?: () => void;
  projectOptions?: { cwd: string; displayName: string }[];
  onNewSessionCwdChange?: (cwd: string, slotIndex: number) => void;
  onOpenSession?: (sessionId: string) => void;
  getSessionRenderKey: (sessionId: string) => string;
  getInputState: (slotIndex: number, sessionId: string) => ChatInputState | null;
  saveInputState: (slotIndex: number, sessionId: string, state: ChatInputState) => void;
}

function sessionTitle(session: SessionInfo | null, index: number): string {
  if (!session) return `空窗口 ${index + 1}`;
  const raw = session.name || session.firstMessage?.slice(0, 80) || (session.path ? session.id.slice(0, 8) : "新会话");
  return raw.length > 24 ? `${raw.slice(0, 22)}...` : raw;
}

function gridTemplate(mode: ChatLayoutMode): { columns: string; rows: string; minWidth: number } {
  // 多窗口始终横向排列：空间不足时由工作区横向滚动，绝不折成宫格。
  switch (mode) {
    case "double":
      return { columns: "repeat(2, minmax(360px, 1fr))", rows: "1fr", minWidth: 740 };
    case "triple":
      return { columns: "repeat(3, minmax(300px, 1fr))", rows: "1fr", minWidth: 940 };
    case "quad":
      return { columns: "repeat(4, minmax(300px, 1fr))", rows: "1fr", minWidth: 1_230 };
    case "six":
      return { columns: "repeat(6, minmax(300px, 1fr))", rows: "1fr", minWidth: 1_850 };
    default:
      return { columns: "minmax(0, 1fr)", rows: "1fr", minWidth: 0 };
  }
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const headerId = useId();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const {
    layoutMode,
    slotIds,
    sessions,
    focusedSlotIndex,
    isPlaceholderSession,
    runningSessionIds,
    modelsRefreshKey,
    chatInputRef,
    onFocusSlot,
    onClearSlot,
    onAgentEnd,
    onSessionCreated,
    onSessionStarted,
    onAgentRunningChange,
    onSessionForked,
    onSessionStatsChange,
    onContextUsageChange,
    onOpenFile,
    onOpenExplorer,
    onRevealFile,
    onOpenRoleConfig,
    projectOptions,
    onNewSessionCwdChange,
    onOpenSession,
    getSessionRenderKey,
    getInputState,
    saveInputState,
  } = props;

  const visibleCount = CHAT_LAYOUT_COUNTS[layoutMode];
  const template = gridTemplate(layoutMode);
  const isMultiLayout = layoutMode !== "single";
  const compact = layoutMode === "triple" || layoutMode === "quad" || layoutMode === "six";
  const workspaceGap = isMultiLayout ? (compact ? 10 : 12) : 0;

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !isMultiLayout) return;

    const onWheel = (event: WheelEvent) => {
      // 只接管外层留白和网格间隙；窗口及其弹层内部保留原生滚动。
      if (event.target !== workspace && event.target !== gridRef.current) return;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!event.deltaY || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (workspace.scrollWidth <= workspace.clientWidth) return;

      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? workspace.clientWidth : 1;
      event.preventDefault();
      workspace.scrollLeft += event.deltaY * unit;
    };

    workspace.addEventListener("wheel", onWheel, { passive: false });
    return () => workspace.removeEventListener("wheel", onWheel);
  }, [isMultiLayout]);

  return (
    <div
      ref={workspaceRef}
      className="workbench-workspace"
      style={{
        position: "relative",
        height: "100%",
        overflow: "auto",
        padding: 0,
        background: "transparent",
      }}
    >
      <div
        ref={gridRef}
        style={{
          minWidth: template.minWidth,
          height: "100%",
          display: "grid",
          gridTemplateColumns: template.columns,
          gridTemplateRows: template.rows,
          gap: workspaceGap,
        }}
      >
        {Array.from({ length: visibleCount }, (_, index) => {
          const slotId = slotIds[index] ?? null;
          const session = slotId ? sessions.find((item) => item.id === slotId) ?? null : null;
          const isFocused = index === focusedSlotIndex;
          const isPlaceholder = Boolean(slotId && isPlaceholderSession(slotId));
          const activeSession = isPlaceholder ? null : session;
          const newSessionCwd = isPlaceholder ? session?.cwd ?? null : null;
          const projectCwd = session?.cwd ?? newSessionCwd;
          const title = sessionTitle(session, index);
          const isRunning = Boolean(slotId && runningSessionIds.has(slotId));
          const isEmptyMultiSlot = isMultiLayout && !session;

          return (
            <section
              className="workbench-session"
              aria-label={title}
              data-focused={isFocused}
              data-empty={isEmptyMultiSlot}
              key={slotId ? getSessionRenderKey(slotId) : `empty-slot-${index}`}
              onMouseDown={() => onFocusSlot(index)}
              style={{
                minWidth: 0,
                minHeight: 0,
                overflow: isMultiLayout ? "visible" : "hidden",
                position: "relative",
                display: "flex",
                flexDirection: "column",
                border: isEmptyMultiSlot ? "none" : "1px solid var(--surface-border, var(--border))",
                borderRadius: "var(--radius-window)",
                background: isEmptyMultiSlot ? "transparent" : "var(--bg)",
                transition: "border-color 0.16s ease",
              }}
            >
              {session && (
                <div
                  className="workbench-session-heading"
                  style={{
                    position: "relative",
                    zIndex: 52,
                    height: compact ? 34 : 36,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: 8,
                    padding: "0 8px 0 12px",
                    borderTopLeftRadius: "var(--radius-window-inner)",
                    borderTopRightRadius: "var(--radius-window-inner)",
                    background: "var(--bg)",
                    color: isFocused ? "var(--text)" : "var(--text-muted)",
                    fontSize: 12,
                    userSelect: "none",
                  }}
                >
                  <div id={`${headerId}-project-${index}`} style={{ flex: 1, minWidth: 0 }} />
                  <div id={`${headerId}-wechat-${index}`} style={{ display: "flex", flexShrink: 0 }} />
                  {projectCwd && (
                    <button
                      type="button"
                      className="workspace-explorer-button"
                      title="资源管理器"
                      aria-label="资源管理器"
                      onClick={() => { onFocusSlot(index); onOpenExplorer?.(index); }}
                    >
                      <AppIcon name="files" size="compact" />
                    </button>
                  )}
                  {slotId && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onClearSlot(index);
                      }}
                      style={{
                        width: 28,
                        height: 28,
                        display: "grid",
                        placeItems: "center",
                        border: "none",
                        borderRadius: "var(--radius-control)",
                        background: "transparent",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                      title="清空此窗口"
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = "var(--bg-hover)";
                        event.currentTarget.style.color = "var(--text)";
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = "transparent";
                        event.currentTarget.style.color = "var(--text-dim)";
                      }}
                    >
                      <AppIcon name="close" size="compact" />
                    </button>
                  )}
                </div>
              )}

              <div style={{ minHeight: 0, flex: 1, overflow: "hidden", position: "relative", background: "transparent" }}>
                {session ? (
                  <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
                    <ChatWindow
                      projectHeaderTargetId={`${headerId}-project-${index}`}
                      wechatHeaderTargetId={session ? `${headerId}-wechat-${index}` : undefined}
                      activeTabId={slotId}
                      isFocused={isFocused}
                      streamRenderPriority={isFocused ? "focused" : "visible"}
                      session={activeSession}
                      newSessionCwd={newSessionCwd}
                      onAgentEnd={onAgentEnd}
                      onSessionCreated={(created, running) => onSessionCreated?.(created, index, slotId, running)}
                      onSessionStarted={(started) => onSessionStarted?.(started, index, slotId)}
                      onAgentRunningChange={onAgentRunningChange}
                      isSessionRunning={isRunning}
                      onSessionForked={(newSessionId) => onSessionForked?.(newSessionId, index, slotId)}
                      modelsRefreshKey={modelsRefreshKey}
                      chatInputRef={isFocused ? chatInputRef : undefined}
                      onSessionStatsChange={isFocused ? onSessionStatsChange : undefined}
                      onContextUsageChange={isFocused ? onContextUsageChange : undefined}
                      onOpenFile={onOpenFile}
                      onRevealFile={onRevealFile ? (path) => onRevealFile(path, session.cwd, index) : undefined}
                      onOpenRoleConfig={onOpenRoleConfig}
                      projectOptions={projectOptions}
                      onNewSessionCwdChange={(cwd) => onNewSessionCwdChange?.(cwd, index)}
                      onOpenSession={onOpenSession}
                      initialInputState={slotId ? getInputState(index, slotId) : null}
                      saveInputState={slotId ? (state) => saveInputState(index, slotId, state) : undefined}
                      compact={compact}
                    />
                  </div>
                ) : isMultiLayout ? null : (
                  <button
                    type="button"
                    onClick={() => onFocusSlot(index)}
                    style={{
                      width: "100%",
                      height: "100%",
                      border: "none",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      fontFamily: "inherit",
                      padding: 24,
                    }}
                  >
                    <span
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: "var(--radius-panel)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                        background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
                        color: "var(--accent)",
                        fontSize: 24,
                        boxShadow: "inset 0 1px 0 color-mix(in srgb, #fff 24%, transparent)",
                      }}
                    >
                      <AppIcon name="add" size="section" />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>窗口 {index + 1} 还空着</span>
                    <span style={{ maxWidth: 180, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>从左侧会话列表选择或新建会话</span>
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
