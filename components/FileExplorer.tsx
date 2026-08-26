"use client";

import { useState, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";

interface FileEntry {
  name: string;
  isDir: boolean;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  initialExpandedPaths?: string[];
  activePath?: string | null;
  onExplorerStateChange?: (state: { expandedPaths: string[]; activePath: string | null }) => void;
}

const DIRECTORY_CACHE_TTL_MS = 30_000;
const directoryCache = new Map<string, { entries: FileNode[]; expiresAt: number }>();
const directoryRequests = new Map<string, Promise<FileNode[]>>();

async function fetchEntries(dirPath: string, force = false): Promise<FileNode[]> {
  if (!force) {
    const cached = directoryCache.get(dirPath);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;
    const pending = directoryRequests.get(dirPath);
    if (pending) return pending;
  }

  const request = (async () => {
    const encoded = encodeFilePathForApi(dirPath);
    const res = await fetch(`/api/files/${encoded}?type=list`);
    if (!res.ok) throw new Error(`加载目录失败 (${res.status})`);
    const data = await res.json() as { entries?: FileEntry[] };
    const entries = (data.entries ?? []).map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(dirPath, entry.name),
      isDir: entry.isDir,
      children: entry.isDir ? [] : undefined,
      loaded: !entry.isDir,
    }));
    directoryCache.set(dirPath, { entries, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS });
    return entries;
  })();

  directoryRequests.set(dirPath, request);
  try {
    return await request;
  } finally {
    if (directoryRequests.get(dirPath) === request) directoryRequests.delete(dirPath);
  }
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
  onContextMenu,
  activePath,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
  onContextMenu?: (event: React.MouseEvent, filePath: string, fileName: string, isDir: boolean) => void;
  activePath?: string | null;
}) {
  const open = expandedPaths.has(node.fullPath);
  const active = !node.isDir && activePath === node.fullPath;
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath, force);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // When refreshKey causes a re-render with the same node identity, reload open dirs
  const prevLoadedRef = useRef(loaded);
  useEffect(() => {
    prevLoadedRef.current = loaded;
  });

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.(event, node.fullPath, node.name, node.isDir);
  }, [node.fullPath, node.name, node.isDir, onContextMenu]);

  return (
    <div>
      <div
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 6 + depth * 12,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: active
            ? "color-mix(in srgb, var(--accent) 22%, var(--bg-hover))"
            : hovered
              ? "color-mix(in srgb, var(--accent) 18%, var(--bg-hover))"
              : "transparent",
          borderRadius: 3,
          userSelect: "none",
          transition: "background 0.12s ease, color 0.12s ease",
          color: active || hovered ? "var(--text)" : "var(--text-muted)",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 11,
            color: active || hovered ? "var(--text)" : "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd));
            }}
            title="插入路径到输入框"
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
            </svg>
            引用
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.fullPath} node={child} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onAtMention={onAtMention} expandedPaths={expandedPaths} onToggleExpanded={onToggleExpanded} refreshKey={refreshKey} onContextMenu={onContextMenu} activePath={activePath} />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 6 + (depth + 1) * 12 + 14, fontSize: 10, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center", fontStyle: "italic" }}>
              空文件夹
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, initialExpandedPaths = [], activePath = null, onExplorerStateChange }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(initialExpandedPaths));
  const [activeFilePath, setActiveFilePath] = useState<string | null>(activePath);
  const prevCwdRef = useRef<string | null>(null);
  const initialExpandedPathsRef = useRef(initialExpandedPaths);
  const initialActivePathRef = useRef(activePath);
  const onExplorerStateChangeRef = useRef(onExplorerStateChange);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    filePath: string;
    fileName: string;
    isDir: boolean;
    x: number;
    y: number;
  } | null>(null);
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

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, filePath: string, fileName: string, isDir: boolean) => {
      setContextMenu({ filePath, fileName, isDir, x: event.clientX, y: event.clientY });
    },
    []
  );

  const handleCopyPath = useCallback(
    async (type: "absolute" | "relative") => {
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
    },
    [contextMenu, cwd]
  );

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

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    setActiveFilePath(filePath);
    onOpenFile(filePath, fileName);
  }, [onOpenFile]);

  useEffect(() => {
    initialExpandedPathsRef.current = initialExpandedPaths;
    initialActivePathRef.current = activePath;
  }, [activePath, initialExpandedPaths]);

  useEffect(() => {
    onExplorerStateChangeRef.current = onExplorerStateChange;
  }, [onExplorerStateChange]);

  useEffect(() => {
    onExplorerStateChangeRef.current?.({ expandedPaths: Array.from(expandedPaths), activePath: activeFilePath });
  }, [activeFilePath, expandedPaths]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set(initialExpandedPathsRef.current));
      setActiveFilePath(initialActivePathRef.current);
    }

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd, !cwdChanged)
      .then((entries) => setRoots(entries))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey, initialExpandedPathsRef, initialActivePathRef]);

  if (loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        正在加载文件...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>
        {error}
      </div>
    );
  }

  const itemStyle: CSSProperties = {
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

  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  return (
    <div style={{ padding: "2px 4px" }}>
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cwd={cwd}
          onOpenFile={handleOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={refreshKey}
          onContextMenu={handleContextMenu}
          activePath={activeFilePath}
        />
      ))}
      {roots.length === 0 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
          未找到文件
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
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
            {contextMenu.fileName}
          </div>
          <button
            style={itemStyle}
            onClick={() => handleCopyPath("absolute")}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied === "absolute" ? "已复制!" : "复制绝对路径"}
          </button>
          <button
            style={itemStyle}
            onClick={() => handleCopyPath("relative")}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied === "relative" ? "已复制!" : "复制相对路径"}
          </button>
          <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
          <button
            style={itemStyle}
            onClick={handleRevealInFinder}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {contextMenu.isDir ? (
                <>
                  <path d="M5 12h14" />
                  <path d="M12 5l7 7-7 7" />
                </>
              ) : (
                <>
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </>
              )}
            </svg>
            {isMac ? "在 Finder 中显示" : "打开所在文件夹"}
          </button>
        </div>
      )}
    </div>
  );
}
