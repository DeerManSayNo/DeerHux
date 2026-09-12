"use client";

import { useState } from "react";
import { getRelativeFilePath } from "@/lib/file-paths";
import { getFileIcon } from "./FileIcons";

interface Props {
  files: string[];
  cwd: string | null;
  onOpenFile?: (filePath: string) => void;
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function ChangedFilesList({ files, cwd, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState(true);
  async function openWithDefaultApp(filePath: string) {
    try {
      const response = await fetch("/api/files/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error("Failed to open file with default app:", error);
    }
  }

  if (!files || files.length === 0) return null;

  const count = files.length;
  const label =
    count === 1
      ? `1 个文件被修改`
      : `${count} 个文件被修改`;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        marginBottom: 16,
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "8px 12px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          textAlign: "left",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: "var(--text-dim)", flexShrink: 0 }}
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        <span>{label}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            color: "var(--text-dim)",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* File list */}
      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
          }}
        >
          {files.map((absPath, i) => {
            const rel = getRelativeFilePath(absPath, cwd ?? undefined);
            const name = fileNameFromPath(rel);
            const parent = rel.includes("/") || rel.includes("\\")
              ? rel.slice(0, rel.lastIndexOf(rel.includes("/") ? "/" : "\\"))
              : null;

            return (
              <button
                key={i}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) {
                    void openWithDefaultApp(absPath);
                    return;
                  }
                  onOpenFile?.(absPath);
                }}
                data-file-menu-path={absPath}
                title={`${absPath}\n⌘/Ctrl + 点击：使用系统默认应用打开`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "7px 12px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text)",
                  fontSize: 12,
                  textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                }}
              >
                <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                  {getFileIcon(name, 14)}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                  }}
                >
                  {name}
                </span>
                {parent && (
                  <span
                    style={{
                      color: "var(--text-dim)",
                      fontSize: 11,
                      flexShrink: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "45%",
                    }}
                  >
                    {parent}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}


    </div>
  );
}
