"use client";

import { useState, type CSSProperties } from "react";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  cwd?: string | null;
  viewerCwd?: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseTabs?: (tabIds: string[]) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onDetach?: () => void;
}

function DetachButton({ onDetach }: { onDetach: () => void }) {
  const [hovered, setHovered] = useState(false);
  const style: CSSProperties = {
    width: 24,
    height: 24,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "1px solid transparent",
    borderRadius: 7,
    background: hovered ? "var(--bg-hover)" : "transparent",
    color: hovered ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  };

  return (
    <button
      type="button"
      title="弹出为独立窗口"
      aria-label="弹出为独立窗口"
      onClick={onDetach}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={style}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
      </svg>
    </button>
  );
}

export function FilePreviewPanel({ tabs, activeTabId, cwd, viewerCwd, onSelectTab, onCloseTab, onCloseTabs, onOpenFile, onDetach }: Props) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <>
      {tabs.length > 0 && (
        <div style={{ flexShrink: 0 }}>
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId ?? ""}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onCloseTabs={onCloseTabs}
            cwd={cwd ?? undefined}
            rightAction={onDetach ? <DetachButton onDetach={onDetach} /> : undefined}
          />
        </div>
      )}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {activeTab?.kind === "web" ? (
          <iframe
            key={activeTab.id}
            src={activeTab.filePath}
            title={activeTab.label}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            style={{ width: "100%", height: "100%", border: 0, background: "white" }}
          />
        ) : activeTab?.filePath ? (
          <FileViewer filePath={activeTab.filePath} cwd={viewerCwd ?? cwd ?? undefined} onOpenFile={onOpenFile} />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
            未打开任何文件
          </div>
        )}
      </div>
    </>
  );
}
