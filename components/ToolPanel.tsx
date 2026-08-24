"use client";

import { useEffect, useRef } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full" | "custom";
export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write", "codegraph"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls", "code_search", "codegraph"];

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const active = tools.filter(t => t.active).map(t => t.name).sort().join(",");
  const available = new Set(tools.map(t => t.name));
  const defaultTools = PRESET_DEFAULT.filter(name => available.has(name));
  const fullTools = PRESET_FULL.filter(name => available.has(name));
  if (active === "") return "none";
  if (active === [...defaultTools].sort().join(",")) return "default";
  if (active === [...fullTools].sort().join(",")) return "full";
  return "custom";
}

interface Props {
  tools: ToolEntry[];
  onPreset: (preset: ToolPreset, toolNames: string[]) => void;
  onClose: () => void;
}

const PRESETS: { id: Exclude<ToolPreset, "custom">; label: string; desc: string; tools: string[] }[] = [
  { id: "none",    label: "关闭",  desc: "无工具",                                  tools: PRESET_NONE },
  { id: "default", label: "低",    desc: "read · bash · edit · write · codegraph",   tools: PRESET_DEFAULT },
  { id: "full",    label: "高",    desc: "read · bash · edit · write · grep · find · ls · code/codegraph search", tools: PRESET_FULL },
];

export function ToolPanel({ tools, onPreset, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getPresetFromTools(tools);

  useEscapeClose(onClose);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const currentIndex = current === "custom" ? PRESETS.length - 1 : PRESETS.findIndex(p => p.id === current);

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        zIndex: 200,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 -4px 20px rgba(0,0,0,0.10)",
        width: 260,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Segmented control */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        background: "var(--bg-panel)",
        borderRadius: 8,
        padding: 3,
        gap: 3,
      }}>
        {PRESETS.map((preset) => {
          const isActive = current === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => { onPreset(preset.id, preset.tools); onClose(); }}
              style={{
                padding: "5px 0",
                borderRadius: 6,
                border: "none",
                background: isActive ? "var(--bg)" : "transparent",
                boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                fontWeight: isActive ? 600 : 400,
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.12s",
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Description of current selection */}
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {current === "custom" ? "自定义工具组合" : currentIndex >= 0 ? PRESETS[currentIndex].desc || "未启用任何工具" : ""}
        {current === "none" && <span> — Agent 将不使用任何工具</span>}
      </div>

      {/* Track bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {PRESETS.map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1, height: 3, borderRadius: 2,
              background: current !== "custom" && i <= currentIndex ? "var(--accent)" : "var(--border)",
              transition: "background 0.15s",
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
        将在下一次交互中生效
      </div>
    </div>
  );
}
