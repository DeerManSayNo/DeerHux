"use client";

import type { RefObject } from "react";
import type { ChatInputHandle, ChatInputState } from "./ChatInput";
import { ChatWindow } from "./ChatWindow";
import { ChatFileExplorerButton } from "./ChatFileExplorerButton";
import type { SessionInfo } from "@/lib/types";
import { getProjectDisplayName } from "@/lib/project-name";

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
  onSessionCreated?: (session: SessionInfo, slotIndex: number, sourceSessionId: string | null) => void;
  onSessionStarted?: (session: SessionInfo | null, slotIndex: number, sourceSessionId: string | null) => void;
  onAgentRunningChange?: (sessionId: string | null | undefined, running: boolean) => void;
  onSessionForked?: (newSessionId: string, slotIndex: number, sourceSessionId: string | null) => void;
  onSessionStatsChange?: (stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  explorerRefreshKey?: number;
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
    onAtMention,
    explorerRefreshKey,
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
  const workspacePadding = isMultiLayout ? (compact ? 10 : 12) : 0;
  const workspaceGap = isMultiLayout ? (compact ? 10 : 12) : 0;

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflow: "auto",
        padding: workspacePadding,
        background: isMultiLayout
          ? "linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 68%, var(--bg)) 0%, var(--bg) 100%)"
          : "transparent",
      }}
    >
      <div
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
          const projectWatermark = projectCwd ? getProjectDisplayName(projectCwd) : "";
          const title = sessionTitle(session, index);
          const isRunning = Boolean(slotId && runningSessionIds.has(slotId));
          const isEmptyMultiSlot = isMultiLayout && !session;

          return (
            <section
              key={slotId ? getSessionRenderKey(slotId) : `empty-slot-${index}`}
              onMouseDown={() => onFocusSlot(index)}
              style={{
                minWidth: 0,
                minHeight: 0,
                overflow: isMultiLayout ? "visible" : "hidden",
                position: "relative",
                display: "flex",
                flexDirection: "column",
                border: !isMultiLayout || isEmptyMultiSlot ? "none" : `1px solid ${isFocused ? "color-mix(in srgb, var(--text) 36%, var(--border))" : "color-mix(in srgb, var(--border) 82%, transparent)"}`,
                borderRadius: !isMultiLayout ? 0 : 16,
                background: isEmptyMultiSlot
                  ? "transparent"
                  : !isMultiLayout
                  ? "var(--bg)"
                  : "linear-gradient(180deg, color-mix(in srgb, var(--bg) 94%, var(--bg-panel)) 0%, var(--bg) 100%)",
                boxShadow: !isMultiLayout || isEmptyMultiSlot
                  ? "none"
                  : isFocused
                    ? "0 0 0 2px color-mix(in srgb, var(--text) 10%, transparent), 0 18px 42px -30px rgba(0, 0, 0, 0.52)"
                    : "0 12px 30px -28px rgba(15, 23, 42, 0.5)",
                transition: "border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease",
              }}
            >
              {isMultiLayout && session && (
                <div
                  style={{
                    position: "relative",
                    zIndex: 52,
                    height: compact ? 34 : 36,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 8px 0 12px",
                    borderTopLeftRadius: 15,
                    borderTopRightRadius: 15,
                    borderBottom: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
                    background: isFocused
                      ? "linear-gradient(90deg, color-mix(in srgb, var(--text) 7%, var(--bg-panel)), color-mix(in srgb, var(--bg-panel) 78%, transparent))"
                      : "color-mix(in srgb, var(--bg-panel) 76%, transparent)",
                    color: isFocused ? "var(--text)" : "var(--text-muted)",
                    fontSize: 12,
                    userSelect: "none",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: isRunning ? "var(--accent)" : isFocused ? "var(--text-muted)" : "var(--border)",
                      boxShadow: isRunning ? "0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isFocused ? 650 : 500 }} title={title}>
                    {title}
                  </span>
                  {projectCwd && (
                    <ChatFileExplorerButton
                      variant="header"
                      cwd={projectCwd}
                      onOpenFile={onOpenFile}
                      onAtMention={onAtMention}
                      refreshKey={explorerRefreshKey}
                    />
                  )}
                  {slotId && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onClearSlot(index);
                      }}
                      style={{
                        width: 22,
                        height: 22,
                        border: "none",
                        borderRadius: 7,
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
                      ×
                    </button>
                  )}
                </div>
              )}

              <div style={{ minHeight: 0, flex: 1, overflow: "hidden", position: "relative", background: "transparent" }}>
                {projectWatermark && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: compact ? 24 : 64,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "96%",
                        boxSizing: "border-box",
                        color: "var(--text)",
                        opacity: compact ? 0.038 : 0.045,
                        fontSize: compact ? "clamp(32px, 7vw, 96px)" : "clamp(48px, 10vw, 160px)",
                        fontWeight: 900,
                        letterSpacing: "-0.05em",
                        lineHeight: 1.15,
                        padding: "0.12em 0.08em",
                        textAlign: "center",
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                        userSelect: "none",
                      }}
                    >
                      {projectWatermark}
                    </div>
                  </div>
                )}
                {session ? (
                  <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
                    <ChatWindow
                      activeTabId={slotId}
                      isFocused={isFocused}
                      streamRenderPriority={isFocused ? "focused" : "visible"}
                      session={activeSession}
                      newSessionCwd={newSessionCwd}
                      onAgentEnd={onAgentEnd}
                      onSessionCreated={(created) => onSessionCreated?.(created, index, slotId)}
                      onSessionStarted={(started) => onSessionStarted?.(started, index, slotId)}
                      onAgentRunningChange={onAgentRunningChange}
                      isSessionRunning={isRunning}
                      onSessionForked={(newSessionId) => onSessionForked?.(newSessionId, index, slotId)}
                      modelsRefreshKey={modelsRefreshKey}
                      chatInputRef={isFocused ? chatInputRef : undefined}
                      onSessionStatsChange={isFocused ? onSessionStatsChange : undefined}
                      onContextUsageChange={isFocused ? onContextUsageChange : undefined}
                      onOpenFile={onOpenFile}
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
                      background: "radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 44%)",
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
                        borderRadius: 16,
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
                      ＋
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
