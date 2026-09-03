"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getFileIcon } from "./FileIcons";
import { getRelativeFilePath } from "@/lib/file-paths";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  kind?: "file" | "web";
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseTabs?: (ids: string[]) => void;
  cwd?: string;
  rightAction?: React.ReactNode;
}

const menuItemStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 9px",
  background: "transparent",
  border: "none",
  borderRadius: 7,
  color: "var(--text-muted)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
};

const disabledMenuItemStyle: React.CSSProperties = {
  ...menuItemStyle,
  color: "var(--text-dim)",
  cursor: "not-allowed",
  opacity: 0.5,
};

function MenuIcon({ type }: { type: "close" | "right" | "others" | "all" | "copy" | "folder" }) {
  if (type === "copy") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }
  if (type === "folder") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (type === "right") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6l6 6-6 6" />
        <path d="M16 6v12" />
      </svg>
    );
  }
  if (type === "others") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M8 9l8 8" />
        <path d="M16 9l-8 8" />
      </svg>
    );
  }
  if (type === "all") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v5" />
        <path d="M14 11v5" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

function ContextMenuButton({
  children,
  icon,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ComponentProps<typeof MenuIcon>["type"];
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      style={disabled ? disabledMenuItemStyle : menuItemStyle}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <MenuIcon type={icon} />
      {children}
    </button>
  );
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseTabs, cwd, rightAction }: Props) {
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; filePath: string; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ tabId: tab.id, filePath: tab.filePath, x: e.clientX, y: e.clientY });
  }, []);

  const closeTabs = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    if (onCloseTabs) onCloseTabs(ids);
    else ids.forEach(onCloseTab);
    setContextMenu(null);
  }, [onCloseTab, onCloseTabs]);

  const handleCopyPath = useCallback(async (type: "absolute" | "relative") => {
    if (!contextMenu) return;
    const text = type === "absolute" ? contextMenu.filePath : getRelativeFilePath(contextMenu.filePath, cwd);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      // fallback: ignore
    }
    setContextMenu(null);
  }, [contextMenu, cwd]);

  const handleRevealInFinder = useCallback(async () => {
    if (!contextMenu) return;
    try {
      await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: contextMenu.filePath }),
      });
    } catch {
      // ignore
    }
    setContextMenu(null);
  }, [contextMenu]);

  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : null;
  const contextTabIndex = contextTab ? tabs.findIndex((tab) => tab.id === contextTab.id) : -1;
  const rightTabIds = contextTabIndex >= 0 ? tabs.slice(contextTabIndex + 1).map((tab) => tab.id) : [];
  const otherTabIds = contextTab ? tabs.filter((tab) => tab.id !== contextTab.id).map((tab) => tab.id) : [];
  const allTabIds = tabs.map((tab) => tab.id);

  return (
    <>
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg-panel)",
        flexShrink: 0,
        height: 36,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          overflowX: "auto",
          minWidth: 0,
          flex: 1,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              data-tauri-drag-region="false"
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 36,
                paddingLeft: 12,
                paddingRight: 6,
                borderRight: "1px solid var(--border)",
                background: isActive ? "var(--bg)" : "var(--bg-panel)",
                cursor: "pointer",
                fontSize: 12,
                color: isActive ? "var(--text)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                maxWidth: 180,
                minWidth: 80,
                flexShrink: 0,
                userSelect: "none",
                transition: "background 0.1s, color 0.1s",
              }}
            >
              <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
                {tab.kind === "web" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                  </svg>
                ) : getFileIcon(tab.label, 13)}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                  fontWeight: isActive ? 500 : 400,
                }}
                title={tab.filePath}
              >
                {tab.label}
              </span>
              <button
                data-tauri-drag-region="false"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                onMouseEnter={() => setHoveredClose(tab.id)}
                onMouseLeave={() => setHoveredClose(null)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 16, height: 16,
                  background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                  border: "none",
                  borderRadius: 3,
                  color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                  transition: "background 0.1s, color 0.1s",
                }}
                title="关闭"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      {rightAction && (
        <div
          style={{
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderLeft: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {rightAction}
        </div>
      )}
    </div>

    {/* Context Menu */}
    {contextMenu && contextTab && (
      <div
        style={{
          position: "fixed",
          left: contextMenu.x,
          top: contextMenu.y,
          zIndex: 1000,
          width: 200,
          padding: 6,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          style={{
            padding: "5px 8px 7px",
            color: "var(--text-dim)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={contextMenu.filePath}
        >
          {contextTab.label}
        </div>
        <ContextMenuButton icon="close" onClick={() => closeTabs([contextTab.id])}>关闭此页</ContextMenuButton>
        <ContextMenuButton icon="right" disabled={rightTabIds.length === 0} onClick={() => closeTabs(rightTabIds)}>关闭右侧标签</ContextMenuButton>
        <ContextMenuButton icon="others" disabled={otherTabIds.length === 0} onClick={() => closeTabs(otherTabIds)}>关闭其他页签</ContextMenuButton>
        <ContextMenuButton icon="all" disabled={allTabIds.length === 0} onClick={() => closeTabs(allTabIds)}>关闭全部页签</ContextMenuButton>
        <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
        <ContextMenuButton icon="copy" onClick={() => handleCopyPath("absolute")}>
          {copied === "absolute" ? "已复制!" : contextTab.kind === "web" ? "复制链接" : "复制绝对路径"}
        </ContextMenuButton>
        {contextTab.kind !== "web" && (
          <>
            <ContextMenuButton icon="copy" onClick={() => handleCopyPath("relative")}>{copied === "relative" ? "已复制!" : "复制相对路径"}</ContextMenuButton>
            <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
            <ContextMenuButton icon="folder" onClick={handleRevealInFinder}>{isMac ? "在 Finder 中显示" : "打开所在文件夹"}</ContextMenuButton>
          </>
        )}
      </div>
    )}
    </>
  );
}
