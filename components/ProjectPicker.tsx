"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getProjectDisplayName } from "@/lib/project-name";
import { AppIcon } from "./AppIcon";

export type ProjectOption = { cwd: string; displayName: string };

// Renders the picker into a slot element when a target id is provided.
export function ProjectHeaderSlot({ targetId, children }: { targetId?: string; children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(targetId ? document.getElementById(targetId) : null);
  }, [targetId]);
  return targetId ? target && createPortal(children, target) : children;
}

type ProjectPickerProps = {
  currentCwd?: string;
  projectOptions?: ProjectOption[];
  onSelect?: (cwd: string) => void;
  compact?: boolean;
  sessionName?: string;
  projectDisplayName?: string;
  isHighlighted?: boolean;
};

// Project switcher shared by session headers and the idle start surface.
export function ProjectPicker({ currentCwd, projectOptions = [], onSelect, compact = false, sessionName, projectDisplayName, isHighlighted = false }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const byCwd = new Map<string, string>();
    for (const project of projectOptions) byCwd.set(project.cwd, project.displayName);
    if (currentCwd && !byCwd.has(currentCwd)) byCwd.set(currentCwd, getProjectDisplayName(currentCwd));
    return [...byCwd.entries()].map(([cwd, displayName]) => ({ cwd, displayName }));
  }, [currentCwd, projectOptions]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const canSwitch = Boolean(onSelect) && options.length > 1;
  const label = projectDisplayName || (currentCwd
    ? options.find((project) => project.cwd === currentCwd)?.displayName ?? getProjectDisplayName(currentCwd)
    : "");

  if (!currentCwd || !label) return null;

  return (
    <div
      style={{
        position: "relative",
        zIndex: 4,
        maxWidth: "100%",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          if (!canSwitch) return;
          setOpen((previous) => !previous);
        }}
        title={canSwitch ? "切换项目" : currentCwd}
        aria-label="当前项目"
        aria-haspopup={canSwitch ? "menu" : undefined}
        aria-expanded={canSwitch ? open : undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          minWidth: 0,
          padding: compact ? "4px 7px" : "4px 8px",
          border: "none",
          borderRadius: "var(--radius-control)",
          background: open ? "var(--bg-hover)" : "transparent",
          color: "var(--text)",
          cursor: canSwitch ? "pointer" : "default",
          fontSize: compact ? 12 : 13,
          fontWeight: 500,
          fontFamily: "inherit",
          lineHeight: 1.25,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          if (canSwitch) event.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "transparent";
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isHighlighted ? "var(--accent)" : "inherit",
          }}
        >
          {label}
        </span>
        {sessionName && (
          <span
            title={sessionName}
            style={{
              flexShrink: 0,
              color: "var(--text-muted)",
              fontWeight: 400,
              whiteSpace: "nowrap",
            }}
          >
            · {sessionName}
          </span>
        )}
        {canSwitch && (
          <AppIcon name="chevron-down" size="compact" style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none" }} />
        )}
      </button>
      {canSwitch && open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: compact ? 30 : 34,
            left: 0,
            width: compact ? 230 : 260,
            maxWidth: "calc(100vw - 48px)",
            maxHeight: compact ? 260 : 320,
            overflowY: "auto",
            padding: 6,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-panel)",
            boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
          }}
        >
          {options.map((project) => {
            const active = project.cwd === currentCwd;
            return (
              <button
                key={project.cwd}
                type="button"
                role="menuitem"
                onClick={() => {
                  if (!active) onSelect?.(project.cwd);
                  setOpen(false);
                }}
                title={project.cwd}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 9px",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: active ? "default" : "pointer",
                  textAlign: "left",
                  fontSize: 12,
                }}
                onMouseEnter={(event) => {
                  if (!active) event.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(event) => {
                  if (!active) event.currentTarget.style.background = "transparent";
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "var(--radius-circle)", background: active ? "var(--accent)" : "var(--border)", flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.displayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
