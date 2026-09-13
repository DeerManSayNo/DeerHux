"use client";

import { AppIcon } from "./AppIcon";

import type { CSSProperties } from "react";

export function SendIconButton({ onClick, disabled, hasContent, title = "发送", busy, alignSelf = "center" }: {
  onClick: () => void;
  disabled: boolean;
  hasContent: boolean;
  title?: string;
  busy?: boolean;
  alignSelf?: CSSProperties["alignSelf"];
}) {
  return <button type="button" className="app-tool-button" data-active={hasContent} onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-busy={busy}
    style={{
      flexShrink: 0, alignSelf, display: "flex", alignItems: "center", justifyContent: "center",
      width: 30, height: 30, padding: 0, border: "none", borderRadius: "var(--radius-circle)",
      background: "transparent",
      color: hasContent ? "var(--accent)" : "var(--text-dim)",
      cursor: disabled ? "not-allowed" : "pointer",
      fontSize: 13, fontWeight: 600, letterSpacing: 0,
      transition: "color 0.15s",
    }}>
    <AppIcon name="send" size="compact" />
  </button>;
}
