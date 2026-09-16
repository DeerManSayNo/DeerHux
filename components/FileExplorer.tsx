"use client";

import { useState, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { FILE_REFERENCE_DRAG_TYPE } from "@/hooks/useDragDrop";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath, getExplorerRevealTarget } from "@/lib/file-paths";

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
  revealRequest?: { id: number; path: string } | null;
  activePath?: string | null;
  onExplorerStateChange?: (state: { expandedPaths: string[]; activePath: string | null }) => void;
  showRoot?: boolean;
  filterQuery?: string;
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
  filterQuery,
  workspaceStyle,
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
  filterQuery?: string;
  workspaceStyle?: boolean;
}) {
  const open = expandedPaths.has(node.fullPath);
  const active = !node.isDir && activePath === node.fullPath;
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const normalizedFilter = filterQuery?.trim().toLocaleLowerCase() ?? "";

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

  // Restored expanded directories must load their children without another click.
  useEffect(() => {
    if (open && !loaded) void loadChildren();
  }, [open, loaded, loadChildren]);

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
    <div data-explorer-loading={node.isDir && open && (!loaded || loading) || undefined}>
      <div
        onClick={handleClick}
        data-explorer-path={node.fullPath}
        data-explorer-active={active || undefined}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "link";
          event.dataTransfer.setData(FILE_REFERENCE_DRAG_TYPE, JSON.stringify([node.fullPath]));
          event.dataTransfer.setData("text/plain", node.fullPath);
        }}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: workspaceStyle ? 6 : 4,
          paddingLeft: 6 + depth * (workspaceStyle ? 16 : 12),
          paddingRight: 8,
          height: workspaceStyle ? 26 : 24,
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
        {(!node.isDir || !workspaceStyle) && (
          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
            {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
          </span>
        )}
        <span
          style={{
            fontSize: workspaceStyle ? 12 : 11,
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
        {node.isDir && (
          <span style={{ width: 10, height: 10, flexShrink: 0, display: "flex", opacity: loading ? 1 : 0 }} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
            </svg>
          </span>
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
          {children.filter((child) => child.isDir || !normalizedFilter || child.name.toLocaleLowerCase().includes(normalizedFilter)).map((child) => (
            <TreeNode key={child.fullPath} node={child} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onAtMention={onAtMention} expandedPaths={expandedPaths} onToggleExpanded={onToggleExpanded} refreshKey={refreshKey} onContextMenu={onContextMenu} activePath={activePath} filterQuery={filterQuery} workspaceStyle={workspaceStyle} />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 6 + (depth + 1) * (workspaceStyle ? 16 : 12) + 14, fontSize: 10, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center", fontStyle: "italic" }}>
              空文件夹
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention, revealRequest, initialExpandedPaths = [], activePath = null, onExplorerStateChange, showRoot = false, filterQuery = "" }: Props) {
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(initialExpandedPaths));
  const [activeFilePath, setActiveFilePath] = useState<string | null>(activePath);
  const [rootOpen, setRootOpen] = useState(true);
  const prevCwdRef = useRef<string | null>(null);
  const initialExpandedPathsRef = useRef(initialExpandedPaths);
  const initialActivePathRef = useRef(activePath);
  const onExplorerStateChangeRef = useRef(onExplorerStateChange);
  const explorerStateRef = useRef({ expandedPaths, activePath: activeFilePath });

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
    const next = new Set(explorerStateRef.current.expandedPaths);
    if (open) next.add(fullPath); else next.delete(fullPath);
    explorerStateRef.current = { ...explorerStateRef.current, expandedPaths: next };
    setExpandedPaths(next);
    onExplorerStateChangeRef.current?.({ expandedPaths: Array.from(next), activePath: explorerStateRef.current.activePath });
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    explorerStateRef.current = { ...explorerStateRef.current, activePath: filePath };
    setActiveFilePath(filePath);
    onExplorerStateChangeRef.current?.({ expandedPaths: Array.from(explorerStateRef.current.expandedPaths), activePath: filePath });
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
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      const restoredPaths = new Set(initialExpandedPathsRef.current);
      explorerStateRef.current = { expandedPaths: restoredPaths, activePath: initialActivePathRef.current };
      setExpandedPaths(restoredPaths);
      setActiveFilePath(initialActivePathRef.current);
      setRootOpen(true);
    }

    setLoading(cwdChanged);
    setError(null);
    if (revealRequest) return;
    let cancelled = false;
    fetchEntries(cwd, !cwdChanged)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, revealRequest, initialExpandedPathsRef, initialActivePathRef]);

  useEffect(() => {
    if (!revealRequest) return;
    let cancelled = false;
    setRevealError(null);
    setRevealedId(null);
    const reveal = async () => {
      const target = getExplorerRevealTarget(revealRequest.path, cwd);
      try {
        // Refresh ancestors so newly created files are visible despite the directory cache.
        const rootEntries = await fetchEntries(cwd, true);
        if (cancelled) return;
        setRoots(rootEntries);
        let entries = rootEntries;
        for (const parent of target.expandedPaths) {
          if (cancelled) return;
          if (!entries.some((entry) => entry.fullPath === parent && entry.isDir)) {
            throw new Error("无法定位文件：所在目录不存在或已被隐藏");
          }
          entries = await fetchEntries(parent, true);
        }
        if (cancelled) return;
        if (!entries.some((entry) => entry.fullPath === target.path && !entry.isDir)) {
          throw new Error("无法定位文件：文件不存在或已被隐藏");
        }
        const expanded = new Set([...explorerStateRef.current.expandedPaths, ...target.expandedPaths]);
        explorerStateRef.current = { expandedPaths: expanded, activePath: target.path };
        setExpandedPaths(expanded);
        setActiveFilePath(target.path);
        setRoots(rootEntries);
        setRevealedId(revealRequest.id);
        onExplorerStateChangeRef.current?.({ expandedPaths: [...expanded], activePath: target.path });
      } catch (cause) {
        if (!cancelled) setRevealError(cause instanceof Error ? cause.message : "无法定位文件，请重试");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void reveal();
    return () => { cancelled = true; };
  }, [cwd, revealRequest, refreshKey]);

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
  const normalizedFilter = filterQuery.trim().toLocaleLowerCase();
  const visibleRoots = roots.filter((node) => node.isDir || !normalizedFilter || node.name.toLocaleLowerCase().includes(normalizedFilter));
  const rootLabel = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;

  return (
    <div style={{ padding: "2px 4px" }} data-explorer-reveal-id={revealedId}>
      {revealError && <div role="alert" style={{ padding: 8, color: "var(--danger, #ef4444)", fontSize: 12 }}>{revealError}</div>}
      {showRoot && (
        <button
          type="button"
          aria-expanded={rootOpen}
          onClick={() => setRootOpen((open) => !open)}
          title={cwd}
          style={{ width: "100%", height: 26, display: "flex", alignItems: "center", gap: 6, padding: "0 8px 0 6px", border: 0, borderRadius: 3, background: "transparent", color: "var(--text)", cursor: "pointer", font: "inherit", textAlign: "left" }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: rootOpen ? "rotate(90deg)" : "none", transition: "transform 0.1s" }} aria-hidden="true">
            <polyline points="3 2 7 5 3 8" />
          </svg>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{rootLabel}</span>
        </button>
      )}
      {(!showRoot || rootOpen) && visibleRoots.map((node) => (
        <TreeNode
          key={`${node.fullPath}:${revealedId ?? "initial"}`}
          node={node}
          depth={showRoot ? 1 : 0}
          cwd={cwd}
          onOpenFile={handleOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={refreshKey}
          onContextMenu={handleContextMenu}
          activePath={activeFilePath}
          filterQuery={filterQuery}
          workspaceStyle={showRoot}
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
