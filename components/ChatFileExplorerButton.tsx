"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type ExplorerProjectState, EMPTY_EXPLORER_PROJECT_STATE, sanitizeExplorerProjectState, areExplorerProjectStatesEqual, readFileExplorerState, writeFileExplorerState } from "@/lib/file-explorer-state";
import { FileExplorer } from "./FileExplorer";

interface Props {
  cwd: string | null;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  refreshKey?: number;
  variant?: "floating" | "header";
}

export function ChatFileExplorerButton({ cwd, onOpenFile, onAtMention, refreshKey, variant = "floating" }: Props) {
  const isHeader = variant === "header";
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [refreshDone, setRefreshDone] = useState(false);
  const [explorerState, setExplorerState] = useState<ExplorerProjectState>(EMPTY_EXPLORER_PROJECT_STATE);
  const [restoredCwd, setRestoredCwd] = useState<string | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updatePopoverPosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;

    const margin = 12;
    const width = Math.min(isHeader ? 360 : 420, Math.max(240, window.innerWidth - margin * 2));
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const left = Math.min(Math.max(isHeader ? rect.right - width : rect.left, margin), maxLeft);

    if (isHeader) {
      const top = Math.min(rect.bottom + 8, window.innerHeight - margin - 160);
      setPopoverStyle({
        position: "fixed",
        left,
        top: Math.max(margin, top),
        width,
        maxHeight: Math.min(520, Math.max(160, window.innerHeight - top - margin)),
        zIndex: 1000,
      });
      return;
    }

    const bottom = Math.max(margin, window.innerHeight - rect.top + 8);
    setPopoverStyle({
      position: "fixed",
      left,
      bottom,
      width,
      maxHeight: Math.min(620, Math.max(160, rect.top - margin - 8)),
      zIndex: 1000,
    });
  }, [isHeader]);

  useEffect(() => {
    if (refreshKey !== undefined) setLocalRefreshKey((key) => key + 1);
  }, [refreshKey]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePopoverPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open, updatePopoverPosition]);

  useEffect(() => {
    if (!cwd) {
      setExplorerState(EMPTY_EXPLORER_PROJECT_STATE);
      setRestoredCwd(null);
      return;
    }
    setExplorerState(readFileExplorerState(cwd));
    setRestoredCwd(cwd);
  }, [cwd]);

  const handleRefresh = useCallback(() => {
    setLocalRefreshKey((key) => key + 1);
    setRefreshDone(true);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setRefreshDone(false), 1600);
  }, []);

  const handleToggle = useCallback(() => {
    setHasOpened(true);
    if (!open) updatePopoverPosition();
    setOpen((value) => !value);
  }, [open, updatePopoverPosition]);

  const handleExplorerStateChange = useCallback((state: ExplorerProjectState) => {
    if (!cwd) return;
    const next = sanitizeExplorerProjectState(state);
    setExplorerState((prev) => areExplorerProjectStatesEqual(prev, next) ? prev : next);
    writeFileExplorerState(cwd, next);
  }, [cwd]);

  if (!cwd) return null;

  const containerStyle: CSSProperties = {
    position: isHeader ? "relative" : "absolute",
    zIndex: isHeader ? 52 : 1000,
    display: "flex",
    alignItems: "flex-end",
    flexShrink: 0,
  };
  if (!isHeader) {
    containerStyle.left = 16;
    containerStyle.bottom = 16;
  }

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(nextTarget) && !popoverRef.current?.contains(nextTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        title="资源管理器"
        aria-label="资源管理器"
        aria-expanded={open}
        style={{
          width: isHeader ? 22 : 36,
          height: isHeader ? 22 : 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: isHeader ? 7 : "50%",
          border: "none",
          background: open && isHeader ? "var(--bg-hover)" : "none",
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          opacity: 1,
          transition: "background 0.12s, color 0.12s, opacity 0.12s, transform 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = isHeader ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = "var(--text)";
          event.currentTarget.style.opacity = "1";
          event.currentTarget.style.transform = "translateY(-1px)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open && isHeader ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
          event.currentTarget.style.opacity = "1";
          event.currentTarget.style.transform = "none";
        }}
        onClick={(event) => {
          event.stopPropagation();
          handleToggle();
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </button>

      {hasOpened && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          style={{
            ...(popoverStyle ?? {}),
            display: open ? "flex" : "none",
            flexDirection: "column",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-panel)",
            boxShadow: "0 18px 48px rgba(15,23,42,0.18)",
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 34,
              padding: "4px 6px 4px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-subtle)",
              flexShrink: 0,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                资源管理器
              </div>
              <div title={cwd} style={{ marginTop: 1, fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {cwd}
              </div>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              title="刷新资源管理器"
              aria-label="刷新资源管理器"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                padding: 0,
                border: "none",
                borderRadius: 7,
                background: refreshDone ? "rgba(74,222,128,0.18)" : "transparent",
                color: refreshDone ? "#4ade80" : "var(--text-dim)",
                cursor: "pointer",
                flexShrink: 0,
                transition: "color 0.2s, background 0.2s",
              }}
              onMouseEnter={(event) => {
                if (refreshDone) return;
                event.currentTarget.style.color = "var(--text-muted)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                if (refreshDone) return;
                event.currentTarget.style.color = "var(--text-dim)";
                event.currentTarget.style.background = "transparent";
              }}
            >
              {refreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 160, overflowY: "auto", overflowX: "hidden", padding: "4px 2px" }}>
            {restoredCwd === cwd && <FileExplorer
              key={cwd}
              cwd={cwd}
              onOpenFile={onOpenFile ?? (() => {})}
              onAtMention={onAtMention}
              refreshKey={localRefreshKey}
              initialExpandedPaths={explorerState.expandedPaths}
              activePath={explorerState.activePath}
              onExplorerStateChange={handleExplorerStateChange}
            />}
          </div>
        </div>
      , document.body)}
    </div>
  );
}
