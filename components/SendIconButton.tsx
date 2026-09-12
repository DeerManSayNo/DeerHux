"use client";

import type { CSSProperties } from "react";

export function SendIconButton({ onClick, disabled, hasContent, title = "发送", busy, alignSelf = "center" }: {
  onClick: () => void;
  disabled: boolean;
  hasContent: boolean;
  title?: string;
  busy?: boolean;
  alignSelf?: CSSProperties["alignSelf"];
}) {
  return <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title} aria-busy={busy}
    style={{
      flexShrink: 0, alignSelf, display: "flex", alignItems: "center", justifyContent: "center",
      width: 30, height: 30, padding: 0, border: "none", borderRadius: "50%",
      background: hasContent ? "var(--accent)" : "var(--bg-panel)",
      color: hasContent ? "#fff" : "var(--text-dim)",
      cursor: disabled ? "not-allowed" : "pointer",
      fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
      boxShadow: hasContent ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
      transition: "background 0.15s, box-shadow 0.15s",
    }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  </button>;
}
