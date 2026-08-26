"use client";

import { open } from "@tauri-apps/plugin-dialog";
import { getLocalStorageItem } from "@/lib/client-storage";
import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import type { ProjectMeta } from "@/lib/project-meta";
import { FileExplorer } from "./FileExplorer";
import { SchedulerRunsBlock } from "./SchedulerRunsBlock";
import { RemoteConnectionsBlock } from "./RemoteConnectionsBlock";
import { readCachedJson, writeCachedJson } from "@/lib/client-resilience";
import { getProjectDisplayName } from "@/lib/project-name";


type RunningSessionStatus = {
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  lastEventType: string;
  eventCount: number;
  eventRate: number;
  eventIdleMs: number | null;
  contentIdleMs: number | null;
  updatedAt?: number;
};

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  optimisticSession?: SessionInfo | null;
  optimisticSessions?: SessionInfo[];
  onOptimisticSessionResolved?: (sessionId: string) => void;
  runningSessionStatuses?: Map<string, RunningSessionStatus>;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  compact?: boolean;
  onProjectsChange?: (projects: { cwd: string; displayName: string }[]) => void;
  onRefreshRunningSessions?: () => void | Promise<void>;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return date.toLocaleDateString();
}

function formatSecondsFromMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "--";
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function formatRunningStatus(status: RunningSessionStatus, now: number): string {
  const eventName = status.isCompacting ? "compacting" : status.lastEventType || "running";
  const rate = Number.isFinite(status.eventRate) ? status.eventRate : 0;
  const elapsedSinceSnapshot = status.updatedAt ? Math.max(0, now - status.updatedAt) : 0;
  const eventIdleMs = status.eventIdleMs == null ? null : status.eventIdleMs + elapsedSinceSnapshot;
  const contentIdleMs = status.contentIdleMs == null ? null : status.contentIdleMs + elapsedSinceSnapshot;
  return `${eventName} · ${rate.toFixed(1)}/s · 事件 ${formatSecondsFromMs(eventIdleMs)} · 内容 ${formatSecondsFromMs(contentIdleMs)}`;
}

interface ProjectGroup {
  cwd: string;
  sessions: SessionInfo[];
  latestModified: string;
  displayName?: string;
  note?: string;
  pinned?: boolean;
}

// Legacy localStorage keys — kept ONLY for one-time migration to the server-side
// project-meta.json file. After migration these are purged from localStorage.
const PROJECT_META_STORAGE_KEY = "deerhux.project-meta";
const CUSTOM_CWDS_STORAGE_KEY = "deerhux.custom-cwds";

const EMPTY_PROJECT_META: ProjectMeta = {
  hiddenCwds: [],
  pinnedCwds: [],
  notes: {},
  defaultPinInitializedCwds: [],
  customCwds: [],
};

/** Read legacy localStorage value (used only for one-time migration to file). */
function readLegacyJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(getLocalStorageItem(key) ?? "null") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function mergeStrings(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (typeof s === "string" && s.trim() && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Load project meta from the server-persisted file
 * (~/.deerhux/agent/project-meta.json). On first run (file doesn't exist yet),
 * migrate from the legacy localStorage keys so existing hide/pin/custom-cwd
 * settings survive the switch to file-based storage. This is what makes
 * "deleted project references" stick across app reinstalls.
 */
async function loadProjectMetaWithMigration(
  fallback: ProjectMeta = EMPTY_PROJECT_META,
): Promise<ProjectMeta> {
  let serverMeta: ProjectMeta = {
    hiddenCwds: [...fallback.hiddenCwds],
    pinnedCwds: [...fallback.pinnedCwds],
    notes: { ...fallback.notes },
    defaultPinInitializedCwds: [...fallback.defaultPinInitializedCwds],
    customCwds: [...fallback.customCwds],
  };
  let serverExists = false;
  try {
    const res = await fetch("/api/project-meta", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { meta?: Partial<ProjectMeta>; exists?: boolean };
      serverMeta = { ...EMPTY_PROJECT_META, ...data.meta };
      serverExists = Boolean(data.exists);
    } else {
      return serverMeta;
    }
  } catch {
    // A transient refresh failure must not erase custom/hidden/pinned projects.
    return serverMeta;
  }

  // One-time migration: only when the server file has never been written.
  if (!serverExists && typeof window !== "undefined") {
    const legacyMeta = readLegacyJson<Partial<ProjectMeta>>(PROJECT_META_STORAGE_KEY, {});
    const legacyCustomCwds = readLegacyJson<unknown[]>(CUSTOM_CWDS_STORAGE_KEY, [])
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    const hasLegacy =
      (legacyMeta.hiddenCwds?.length ?? 0) > 0 ||
      (legacyMeta.pinnedCwds?.length ?? 0) > 0 ||
      (legacyMeta.notes && Object.keys(legacyMeta.notes).length > 0) ||
      (legacyMeta.defaultPinInitializedCwds?.length ?? 0) > 0 ||
      legacyCustomCwds.length > 0;

    if (hasLegacy) {
      const migrated: ProjectMeta = {
        hiddenCwds: mergeStrings(serverMeta.hiddenCwds, legacyMeta.hiddenCwds),
        pinnedCwds: mergeStrings(serverMeta.pinnedCwds, legacyMeta.pinnedCwds),
        notes: { ...serverMeta.notes, ...(legacyMeta.notes ?? {}) },
        defaultPinInitializedCwds: mergeStrings(serverMeta.defaultPinInitializedCwds, legacyMeta.defaultPinInitializedCwds),
        customCwds: mergeStrings(serverMeta.customCwds, legacyCustomCwds),
      };
      try {
        const res = await fetch("/api/project-meta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(migrated),
        });
        if (res.ok) {
          // Migration succeeded — purge legacy keys so we never migrate twice.
          try {
            window.localStorage.removeItem(PROJECT_META_STORAGE_KEY);
            window.localStorage.removeItem(CUSTOM_CWDS_STORAGE_KEY);
          } catch {
            /* ignore */
          }
          return migrated;
        }
      } catch {
        /* keep localStorage as fallback if POST fails */
      }
    }
  }

  return serverMeta;
}

/** Persist project meta to the server-side file (fire-and-forget). */
function persistProjectMeta(meta: ProjectMeta) {
  if (typeof window === "undefined") return;
  void fetch("/api/project-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  }).catch(() => {
    /* ignore — local state is still correct for this session */
  });
}

/** Group projects by cwd and sort by their newest message/session activity. */
function buildProjectGroups(sessions: SessionInfo[]): ProjectGroup[] {
  const byCwd = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }

  return [...byCwd.entries()]
    .map(([cwd, list]) => {
      const sorted = [...list].sort((a, b) => b.modified.localeCompare(a.modified));
      return { cwd, sessions: sorted, latestModified: sorted[0]?.modified ?? "" };
    })
    .sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

function isScheduledTasksCwd(cwd: string): boolean {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return /[\\/]\.deerhux[\\/]agent[\\/]scheduled-tasks$/.test(normalized)
    || /[\\/]\.deerhux[\\/]agent[\\/]wechat[\\/]remote-cwd$/.test(normalized);
}

function getInitial(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  return Array.from(trimmed)[0]?.toUpperCase() ?? "•";
}


interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, optimisticSession, optimisticSessions, onOptimisticSessionResolved, runningSessionStatuses = new Map(), onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onAtMention, compact = false, onProjectsChange, onRefreshRunningSessions }: Props) {
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Index control-plane state. `rebuilding` is non-fatal: a stale/missing
  // index triggers a background rebuild but the sidebar keeps showing data.
  const [indexRebuilding, setIndexRebuilding] = useState(false);
  const [indexWarning, setIndexWarning] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta>({ ...EMPTY_PROJECT_META });
  const [purging, setPurging] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<{ cwd: string; displayName: string } | null>(null);
  const [purgeResult, setPurgeResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ cwd: string; x: number; y: number } | null>(null);
  const [expandedCwds, setExpandedCwds] = useState<Set<string>>(new Set());
  const [allProjectsState, setAllProjectsState] = useState<"expanded" | "collapsed">("expanded");
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showAllCwds, setShowAllCwds] = useState<Set<string>>(new Set());
  const autoExpandedRef = useRef(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastGoodSessionsRef = useRef<SessionInfo[]>([]);
  const hasCompletedInitialLoadRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryAttemptRef = useRef(0);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const loadRequestIdRef = useRef(0);
  const loadAbortControllerRef = useRef<AbortController | null>(null);
  // Load project meta from the server-persisted file, migrating from legacy
  // localStorage keys on first run. Runs after mount to avoid hydration mismatch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const meta = await loadProjectMetaWithMigration();
      if (!cancelled) setProjectMeta(meta);
    })();
    return () => { cancelled = true; };
  }, []);

  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [projectsRefreshDone, setProjectsRefreshDone] = useState(false);
  const projectsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const splitterRef = useRef<HTMLDivElement>(null);
  const splitPercentRef = useRef(50);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const [isHoveringSplitter, setIsHoveringSplitter] = useState(false);
  const [splitPercent, setSplitPercent] = useState(() => {
    if (typeof window === "undefined") return 50;
    try {
      const stored = getLocalStorageItem("deerhux.sidebar-split-percent");
      if (stored) {
        const n = Number(stored);
        if (n >= 10 && n <= 90) return n;
      }
    } catch { /* ignore */ }
    return 50;
  });

  useEffect(() => { splitPercentRef.current = splitPercent; }, [splitPercent]);

  useEffect(() => {
    const cached = readCachedJson<SessionInfo[]>("deerhux.control-plane.sessions.v1");
    if (!cached?.length) return;
    lastGoodSessionsRef.current = cached;
    setAllSessions(cached);
  }, []);

  const loadSessions = useCallback(async (showLoading = false): Promise<{
    ok: boolean;
    rebuilding: boolean;
    error?: string;
  }> => {
    const requestId = ++loadRequestIdRef.current;
    loadAbortControllerRef.current?.abort();
    const controller = new AbortController();
    loadAbortControllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      if (showLoading && !hasCompletedInitialLoadRef.current) {
        setError(null);
        setLoading(true);
      }
      const res = await fetch("/api/sessions", { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        stale?: boolean;
        rebuilding?: boolean;
        recovering?: boolean;
        warning?: string;
        source?: "index" | "legacy";
      };
      if (!Array.isArray(data.sessions)) throw new Error("Invalid sessions response");
      if (requestId !== loadRequestIdRef.current) {
        return { ok: false, rebuilding: false };
      }

      // A cold/corrupt index reports [] + rebuilding=true. Keep the last-good
      // list visible until the background rebuild converges.
      if (!(data.rebuilding && data.sessions.length === 0 && lastGoodSessionsRef.current.length > 0)) {
        setAllSessions(data.sessions);
      }
      if (data.sessions.length > 0 || !data.rebuilding) {
        lastGoodSessionsRef.current = data.sessions;
        writeCachedJson("deerhux.control-plane.sessions.v1", data.sessions);
      }
      recoveryAttemptRef.current = 0;
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      hasCompletedInitialLoadRef.current = true;
      // Index control-plane flags are advisory only — never surface as errors.
      // Routine stale-while-revalidate is intentionally silent. Only a missing
      // or corrupt index is a user-visible recovery state that needs polling.
      setIndexRebuilding(Boolean(
        data.recovering
        ?? (data.rebuilding && data.sessions.length === 0)
      ));
      setIndexWarning(data.warning ?? null);
      setError(null);
      return { ok: true, rebuilding: Boolean(data.rebuilding) };
    } catch (e) {
      if (requestId !== loadRequestIdRef.current) {
        return { ok: false, rebuilding: false };
      }
      const message = e instanceof DOMException && e.name === "AbortError"
        ? "加载会话超时"
        : String(e);
      setError(
        lastGoodSessionsRef.current.length > 0
          ? `${message}（正在显示上次数据，将自动重试）`
          : `${message}（将自动重试）`,
      );
      return { ok: false, rebuilding: false, error: message };
    } finally {
      clearTimeout(timeout);
      if (requestId === loadRequestIdRef.current) {
        loadAbortControllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    void loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Any transient list failure gets an automatic bounded-backoff retry. This
  // also covers the first page load, where there may be no in-memory data yet.
  useEffect(() => {
    if (!error || recoveryTimerRef.current) return;
    let cancelled = false;
    const delay = Math.min(1_000 * (2 ** recoveryAttemptRef.current), 10_000);
    recoveryAttemptRef.current += 1;
    recoveryTimerRef.current = setTimeout(async () => {
      recoveryTimerRef.current = null;
      const result = await loadSessions(false);
      if (!cancelled && !result.ok) setRecoveryTick((value) => value + 1);
    }, delay);
    return () => {
      cancelled = true;
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [error, loadSessions, recoveryTick]);

  // Missing/corrupt indexes rebuild in the background. Retry until the server
  // reports convergence so users never need to click refresh to recover.
  useEffect(() => {
    if (!indexRebuilding) return;
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const retry = () => {
      const delay = Math.min(1_500 * (2 ** attempt), 10_000);
      retryTimer = setTimeout(async () => {
        if (cancelled) return;
        const result = await loadSessions(false);
        if (cancelled || (result.ok && !result.rebuilding)) return;
        attempt += 1;
        retry();
      }, delay);
    };
    retry();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [indexRebuilding, loadSessions]);

  useEffect(() => () => {
    loadRequestIdRef.current += 1;
    loadAbortControllerRef.current?.abort();
  }, []);

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startPercent = splitPercentRef.current;
    const sidebarEl = sidebarRef.current;
    const headerEl = headerRef.current;
    if (!sidebarEl) return;
    const sidebarHeight = sidebarEl.offsetHeight;
    const headerHeight = headerEl?.offsetHeight ?? 0;
    const availableHeight = sidebarHeight - headerHeight;
    if (availableHeight <= 0) return;

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    setIsDraggingSplitter(true);

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - startY;
      const deltaPercent = (deltaY / availableHeight) * 100;
      const newPercent = Math.max(10, Math.min(90, startPercent + deltaPercent));
      setSplitPercent(newPercent);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsDraggingSplitter(false);
      try {
        localStorage.setItem("deerhux.sidebar-split-percent", String(splitPercentRef.current));
      } catch { /* ignore */ }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  const restoredRef = useRef(false);

  useEffect(() => {
    onCwdChange?.(selectedCwd);
  }, [selectedCwd, onCwdChange]);

  const ensureDefaultCwd = useCallback(async () => {
    if (defaultCwd) return defaultCwd;
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setDefaultCwd(data.cwd);
        return data.cwd;
      }
    } catch {
      // ignore
    }
    return null;
  }, [defaultCwd]);

  const handleDefaultCwd = useCallback(async () => {
    const cwd = await ensureDefaultCwd();
    if (cwd) {
      setSelectedCwd(cwd);
      setExpandedCwds((prev) => new Set(prev).add(cwd));
    }
  }, [ensureDefaultCwd]);

  useEffect(() => {
    if (!loading && !defaultCwd) {
      void ensureDefaultCwd();
    }
  }, [loading, defaultCwd, ensureDefaultCwd]);

  const updateProjectMeta = useCallback((updater: (prev: ProjectMeta) => ProjectMeta) => {
    setProjectMeta((prev) => {
      const next = updater(prev);
      persistProjectMeta(next);
      return next;
    });
  }, []);

  const displayedSessions = useMemo(() => {
    const optimistic = [
      ...(optimisticSessions ?? []),
      ...(optimisticSession ? [optimisticSession] : []),
    ];
    const base = [...allSessions];
    const existingIds = new Set(base.map((s) => s.id));
    for (const session of optimistic) {
      if (!existingIds.has(session.id)) {
        base.unshift(session);
        existingIds.add(session.id);
      }
    }
    // Hide subagent worker sessions from the top-level project list: they are
    // subordinate to a parent session's message and are surfaced via the
    // collaboration run card under that message instead.
    return base.filter((s) => !s.isSubagent);
  }, [allSessions, optimisticSession, optimisticSessions]);

  useEffect(() => {
    if (!onOptimisticSessionResolved) return;
    const persistedIds = new Set(allSessions.map((s) => s.id));
    const optimistic = [
      ...(optimisticSessions ?? []),
      ...(optimisticSession ? [optimisticSession] : []),
    ];
    for (const session of optimistic) {
      if (persistedIds.has(session.id)) onOptimisticSessionResolved(session.id);
    }
  }, [allSessions, optimisticSession, optimisticSessions, onOptimisticSessionResolved]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (loading) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = displayedSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        return;
      }
      onInitialRestoreDone?.();
    }

    if (selectedCwd === null) {
      const projects = buildProjectGroups(displayedSessions);
      if (projects.length > 0) {
        setSelectedCwd(projects[0].cwd);
      } else {
        handleDefaultCwd();
      }
    }
  }, [loading, displayedSessions, selectedCwd, initialSessionId, onSelectSession, onInitialRestoreDone, handleDefaultCwd]);

  const handleCustomPath = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择项目目录",
    });

    if (typeof selected === "string") {
      setSelectedCwd(selected);
      setExpandedCwds((prev) => new Set(prev).add(selected));
      updateProjectMeta((prev) => ({
        ...prev,
        // Re-adding a previously hidden project must clear hiddenCwds — otherwise
        // allProjects still filters it out and the sidebar looks empty.
        hiddenCwds: prev.hiddenCwds.filter((cwd) => cwd !== selected),
        customCwds: [selected, ...prev.customCwds.filter((cwd) => cwd !== selected)],
      }));
    }
  }, [updateProjectMeta]);

  const handleNewSession = useCallback(async () => {
    const recentCwd = buildProjectGroups(displayedSessions)[0]?.cwd;
    const cwd = selectedCwdProp ?? selectedCwd ?? recentCwd ?? await ensureDefaultCwd();
    if (!cwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // DeerHux will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [selectedCwdProp, selectedCwd, displayedSessions, ensureDefaultCwd, onNewSession]);

  const sessionProjects = useMemo(() => buildProjectGroups(displayedSessions), [displayedSessions]);
  const allProjects = useMemo(() => {
    const byCwd = new Map<string, ProjectGroup>();
    for (const project of sessionProjects) byCwd.set(project.cwd, project);
    for (const cwd of projectMeta.customCwds) {
      if (!byCwd.has(cwd)) byCwd.set(cwd, { cwd, sessions: [], latestModified: "" });
    }
    if (defaultCwd && !byCwd.has(defaultCwd)) {
      byCwd.set(defaultCwd, { cwd: defaultCwd, sessions: [], latestModified: "" });
    }

    return [...byCwd.values()]
      .filter((project) => project.cwd === defaultCwd || !projectMeta.hiddenCwds.includes(project.cwd))
      .map((project) => ({
        ...project,
        displayName: isScheduledTasksCwd(project.cwd) ? "定时任务" : project.cwd === defaultCwd ? "默认" : project.displayName,
        note: projectMeta.notes[project.cwd]?.trim() || undefined,
        pinned: projectMeta.pinnedCwds.includes(project.cwd),
      }))
      .sort((a, b) => {
        const aIdx = projectMeta.pinnedCwds.indexOf(a.cwd);
        const bIdx = projectMeta.pinnedCwds.indexOf(b.cwd);
        const aPinned = aIdx !== -1;
        const bPinned = bIdx !== -1;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (aPinned) return aIdx - bIdx;
        return b.latestModified.localeCompare(a.latestModified);
      });
  }, [sessionProjects, defaultCwd, projectMeta]);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const projects = useMemo(() => {
    if (!normalizedSearchQuery) return allProjects;
    return allProjects
      .map((project) => {
        const projectTitle = project.displayName ?? getProjectDisplayName(project.cwd);
        const projectMatches = [projectTitle, project.cwd, project.note ?? ""]
          .some((value) => value.toLowerCase().includes(normalizedSearchQuery));
        const sessions = projectMatches
          ? project.sessions
          : project.sessions.filter((session) => [
              session.name ?? "",
              session.firstMessage ?? "",
              session.id,
              session.cwd,
            ].some((value) => value.toLowerCase().includes(normalizedSearchQuery)));
        return projectMatches || sessions.length > 0 ? { ...project, sessions } : null;
      })
      .filter((project) => project !== null) as ProjectGroup[];
  }, [allProjects, normalizedSearchQuery]);
  const activeSelectedCwd = selectedCwdProp ?? selectedCwd;
  const recentSessions = useMemo(() => {
    if (normalizedSearchQuery) return [];
    return [...displayedSessions]
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, 5);
  }, [displayedSessions, normalizedSearchQuery]);
  const visibleProjects = useMemo(() => {
    if (normalizedSearchQuery || showAllProjects) return projects;
    const visible = projects.slice(0, 5);
    const activeProject = activeSelectedCwd
      ? projects.find((project) => project.cwd === activeSelectedCwd)
      : undefined;
    if (activeProject && !visible.some((project) => project.cwd === activeProject.cwd)) {
      visible.push(activeProject);
    }
    return visible;
  }, [activeSelectedCwd, normalizedSearchQuery, projects, showAllProjects]);
  const hiddenProjectCount = Math.max(0, projects.length - visibleProjects.length);

  useEffect(() => {
    onProjectsChange?.(allProjects.map((project) => ({
      cwd: project.cwd,
      displayName: project.displayName ?? getProjectDisplayName(project.cwd),
    })));
  }, [allProjects, onProjectsChange]);

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  const handleProjectNote = useCallback((cwd: string) => {
    const current = projectMeta.notes[cwd] ?? "";
    const nextNote = window.prompt("项目备注", current);
    if (nextNote === null) return;
    updateProjectMeta((prev) => ({
      ...prev,
      notes: { ...prev.notes, [cwd]: nextNote.trim() },
    }));
  }, [projectMeta.notes, updateProjectMeta]);

  useEffect(() => {
    if (!defaultCwd || projectMeta.defaultPinInitializedCwds.includes(defaultCwd)) return;
    updateProjectMeta((prev) => ({
      ...prev,
      pinnedCwds: prev.pinnedCwds.includes(defaultCwd) ? prev.pinnedCwds : [defaultCwd, ...prev.pinnedCwds],
      defaultPinInitializedCwds: [...prev.defaultPinInitializedCwds, defaultCwd],
    }));
  }, [defaultCwd, projectMeta.defaultPinInitializedCwds, updateProjectMeta]);

  const handleToggleProjectPinned = useCallback((cwd: string) => {
    updateProjectMeta((prev) => {
      const pinned = prev.pinnedCwds.includes(cwd)
        ? prev.pinnedCwds.filter((item) => item !== cwd)
        : [cwd, ...prev.pinnedCwds];
      return { ...prev, pinnedCwds: pinned };
    });
  }, [updateProjectMeta]);

  const handleRemoveProjectReference = useCallback((cwd: string) => {
    if (cwd === defaultCwd) return;
    updateProjectMeta((prev) => ({
      ...prev,
      hiddenCwds: prev.hiddenCwds.includes(cwd) ? prev.hiddenCwds : [...prev.hiddenCwds, cwd],
      pinnedCwds: prev.pinnedCwds.filter((item) => item !== cwd),
      customCwds: prev.customCwds.filter((item) => item !== cwd),
    }));
    if ((selectedCwdProp ?? selectedCwd) === cwd) void handleDefaultCwd();
  }, [defaultCwd, selectedCwdProp, selectedCwd, updateProjectMeta, handleDefaultCwd]);

  const handleReselectProjectPath = useCallback(async (cwd: string) => {
    const selected = await open({ directory: true, multiple: false, title: "重新选定项目路径" });
    if (typeof selected !== "string" || selected === cwd) return;
    updateProjectMeta((prev) => {
      const notes = { ...prev.notes };
      if (notes[cwd] && !notes[selected]) notes[selected] = notes[cwd];
      delete notes[cwd];
      return {
        ...prev,
        hiddenCwds: prev.hiddenCwds.includes(cwd) ? prev.hiddenCwds : [...prev.hiddenCwds, cwd],
        pinnedCwds: prev.pinnedCwds.includes(cwd)
          ? [selected, ...prev.pinnedCwds.filter((item) => item !== cwd && item !== selected)]
          : prev.pinnedCwds.filter((item) => item !== selected),
        customCwds: [selected, ...prev.customCwds.filter((item) => item !== cwd && item !== selected)],
        notes,
        defaultPinInitializedCwds: prev.defaultPinInitializedCwds.map((item) => item === cwd ? selected : item),
      };
    });
    setSelectedCwd(selected);
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      next.delete(cwd);
      next.add(selected);
      return next;
    });
  }, [updateProjectMeta]);

  const handlePurgeProjectSessions = useCallback((cwd: string) => {
    if (cwd === defaultCwd) return;
    const displayName = isScheduledTasksCwd(cwd) ? "定时任务" : getProjectDisplayName(cwd);
    setConfirmPurge({ cwd, displayName });
  }, [defaultCwd]);

  // Actually performs the destructive session deletion. Triggered by the
  // confirm modal's "确认删除" button — kept separate so the confirmation UI
  // can live entirely in React (Tauri blocks window.confirm/alert).
  const executePurge = useCallback(async () => {
    const target = confirmPurge;
    if (!target) return;
    const { cwd } = target;
    setConfirmPurge(null);
    setPurging(true);
    try {
      const res = await fetch("/api/projects/clear-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { deletedCount?: number };
      // Server already cleaned cwd out of project-meta; reload the canonical copy.
      const meta = await loadProjectMetaWithMigration(projectMeta);
      setProjectMeta(meta);
      await loadSessions();
      if ((selectedCwdProp ?? selectedCwd) === cwd) void handleDefaultCwd();
      setPurgeResult({ ok: true, message: `已彻底删除 ${data.deletedCount ?? 0} 个会话文件。` });
    } catch (e) {
      setPurgeResult({ ok: false, message: `删除失败：${String(e)}` });
    } finally {
      setPurging(false);
    }
  }, [confirmPurge, selectedCwdProp, selectedCwd, projectMeta, loadSessions, handleDefaultCwd]);

  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("click", close);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!defaultCwd) return;
    setExpandedCwds((prev) => {
      if (prev.has(defaultCwd)) return prev;
      const next = new Set(prev);
      next.add(defaultCwd);
      return next;
    });
  }, [defaultCwd]);

  useEffect(() => {
    if (loading || projects.length === 0 || autoExpandedRef.current) return;
    autoExpandedRef.current = true;
    setExpandedCwds((prev) => new Set([...prev, ...projects.slice(0, 1).map((p) => p.cwd)]));
  }, [loading, projects]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const session = displayedSessions.find((s) => s.id === selectedSessionId);
    if (!session?.cwd) return;
    setExpandedCwds((prev) => {
      if (prev.has(session.cwd)) return prev;
      const next = new Set(prev);
      next.add(session.cwd);
      return next;
    });
  }, [selectedSessionId, displayedSessions]);

  const toggleProject = useCallback((cwd: string) => {
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const toggleShowAll = useCallback((cwd: string) => {
    setShowAllCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const handleRefreshProjects = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [meta, sessionsResult] = await Promise.all([
        loadProjectMetaWithMigration(projectMeta),
        loadSessions(true),
        onRefreshRunningSessions?.(),
      ]);
      setProjectMeta(meta);
      void ensureDefaultCwd();
      if (!sessionsResult.ok) {
        return;
      }
      setProjectsRefreshDone(true);
      if (projectsRefreshTimerRef.current) clearTimeout(projectsRefreshTimerRef.current);
      projectsRefreshTimerRef.current = setTimeout(() => setProjectsRefreshDone(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, [ensureDefaultCwd, loadSessions, onRefreshRunningSessions, projectMeta]);

  useEffect(() => {
    return () => {
      if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
      if (projectsRefreshTimerRef.current) clearTimeout(projectsRefreshTimerRef.current);
    };
  }, []);

  return (
    <div ref={sidebarRef} className="sidebar-navigation" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div
        ref={headerRef}
        style={{
          padding: compact ? "8px 6px" : "34px 8px 8px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", flexDirection: searchOpen ? "row" : compact ? "row" : "column", alignItems: searchOpen || compact ? "center" : "stretch", justifyContent: compact ? "center" : "space-between", gap: compact ? 6 : 2 }}>
          {!searchOpen ? (
            <button
              onClick={handleNewSession}
              disabled={false}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: compact ? "center" : "flex-start",
                gap: compact ? 0 : 10,
                background: compact ? "var(--bg-hover)" : "transparent",
                border: compact ? "1px solid var(--border)" : "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                height: compact ? 34 : 38,
                width: compact ? 34 : "100%",
                minWidth: 0,
                padding: compact ? 0 : "0 10px",
                borderRadius: compact ? 999 : 9,
                fontSize: compact ? 12 : 13,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flex: compact ? "0 0 auto" : "1 1 auto",
                order: compact ? 0 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              title={activeSelectedCwd ? `在 ${activeSelectedCwd} 中新建会话` : "新建会话（将使用最近项目或默认项目）"}
              aria-label="新建会话"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = compact ? "var(--bg-hover)" : "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
            >
              <svg
                width={compact ? 14 : 13}
                height={compact ? 14 : 13}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <path d="M3.7 4.3 21 12 3.7 19.7l3.2-7.7-3.2-7.7Z" />
                <path d="M6.9 12H21" />
              </svg>
              {!compact && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>新建会话</span>}
            </button>
          ) : (
            <div
              style={{
                position: "relative",
                order: compact ? 0 : 1,
                flex: 1,
                minWidth: 0,
                height: compact ? 34 : 32,
                display: "flex",
                alignItems: "center",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ position: "absolute", left: 10, color: "var(--text-dim)", pointerEvents: "none" }}
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchOpen(false);
                  }
                }}
                placeholder="搜索会话或项目"
                aria-label="搜索会话或项目"
                style={{
                  width: "100%",
                  height: "100%",
                  border: "1px solid var(--border)",
                  borderRadius: compact ? 999 : 8,
                  background: "var(--bg)",
                  color: "var(--text)",
                  outline: "none",
                  padding: compact ? "0 10px 0 30px" : "0 12px 0 30px",
                  fontSize: 12,
                  boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 8%, transparent)",
                }}
              />
            </div>
          )}

          <button
            onClick={() => {
              if (searchOpen) {
                setSearchQuery("");
                setSearchOpen(false);
              } else {
                setSearchOpen(true);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: compact || searchOpen ? "center" : "flex-start",
              gap: compact || searchOpen ? 0 : 10,
              width: compact || searchOpen ? 34 : "100%",
              height: compact ? 34 : searchOpen ? 36 : 38,
              borderRadius: compact ? 999 : searchOpen ? 8 : 9,
              border: compact ? "1px solid var(--border)" : "none",
              background: compact ? "var(--bg-hover)" : "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              order: compact ? 0 : 2,
              padding: compact || searchOpen ? 0 : "0 10px",
              fontSize: compact ? 12 : 13,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              transition: "background 0.12s, color 0.12s",
            }}
            title={searchOpen ? "关闭搜索" : "搜索"}
            aria-label={searchOpen ? "关闭搜索" : "搜索"}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = compact ? "var(--bg-hover)" : "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            {searchOpen ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <>
                <svg
                  width={compact ? 14 : 13}
                  height={compact ? 14 : 13}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                {!compact && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>搜索</span>}
              </>
            )}
          </button>
        </div>

      </div>

      {/* Project/session list */}
      <div className="sidebar-navigation-scroll" style={{ flex: compact ? "1 1 auto" : explorerOpen && activeSelectedCwd ? `${splitPercent} 1 0` : "1 1 auto", overflowY: "auto", padding: compact ? "6px 0" : "8px 0 12px", minHeight: 80 }}>
        {indexRebuilding && allSessions.length > 0 && !compact && (
          <div style={{ padding: "6px 14px", background: "rgba(250, 204, 21, 0.08)", color: "#b45309", fontSize: 11, borderBottom: "1px solid rgba(250, 204, 21, 0.2)" }}>
            正在恢复会话索引…
          </div>
        )}
        {indexWarning && allSessions.length > 0 && !compact && (
          <div style={{ padding: "6px 14px", color: "var(--text-muted)", fontSize: 11 }}>
            索引刷新异常：{indexWarning}（展示为旧数据）
          </div>
        )}
        {loading && (
          <div style={{ padding: compact ? "8px 0" : "16px 14px", color: "var(--text-muted)", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact ? "…" : "加载中..."}
          </div>
        )}
        {error && (
          <div style={{ padding: compact ? "8px 4px" : "12px 14px", color: "#f87171", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact ? "!" : error}
          </div>
        )}
        {!loading && !error && projects.length === 0 && (
          <div style={{ padding: compact ? "8px 4px" : "16px 14px", color: "var(--text-muted)", fontSize: 12, textAlign: compact ? "center" : undefined }}>
            {compact
              ? "…"
              : indexRebuilding && allSessions.length === 0
                ? "正在建立会话索引…"
                : normalizedSearchQuery
                  ? "没有匹配结果"
                  : (
                    <div style={{ display: "grid", justifyItems: "start", gap: 8 }}>
                      <span>还没有项目</span>
                      <button type="button" className="sidebar-empty-action" onClick={handleCustomPath}>添加项目</button>
                    </div>
                  )}
          </div>
        )}
        {!loading && projects.length > 0 && (
          <section style={{ marginBottom: compact ? 0 : 18 }} aria-labelledby="projects-heading">
            {!compact && (
              <div
                className="sidebar-section-heading sidebar-section-heading-actions"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "nowrap",
                  minWidth: 0,
                }}
              >
                <button
                  id="projects-heading"
                  type="button"
                  className="sidebar-section-title-button"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    minWidth: 0,
                    flex: "1 1 auto",
                  }}
                  onClick={() => setAllProjectsState((prev) => prev === "expanded" ? "collapsed" : "expanded")}
                  aria-expanded={allProjectsState === "expanded"}
                >
                  项目
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: allProjectsState === "expanded" ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
                    <polyline points="3 2 7 5 3 8" />
                  </svg>
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto", flexWrap: "nowrap" }}>
                  <button type="button" className="sidebar-heading-action" onClick={handleCustomPath} title="添加项目" aria-label="添加项目">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7.5V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2" />
                      <path d="M12 14v7M8.5 17.5h7" />
                    </svg>
                  </button>
                  <button type="button" className="sidebar-heading-action" onClick={() => void handleRefreshProjects()} disabled={refreshing} title="刷新项目和会话" aria-label="刷新项目和会话">
                    {projectsRefreshDone ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                    )}
                  </button>
                </div>
              </div>
            )}
            {(compact || normalizedSearchQuery || allProjectsState === "expanded") && (compact ? projects : visibleProjects).map((project) => (
              <ProjectSection
                key={project.cwd}
                project={project}
                expanded={normalizedSearchQuery ? true : expandedCwds.has(project.cwd)}
                showAll={normalizedSearchQuery ? true : showAllCwds.has(project.cwd)}
                selectedSessionId={selectedSessionId}
                runningSessionStatuses={runningSessionStatuses}
                onToggle={() => {
                  setSelectedCwd(project.cwd);
                  toggleProject(project.cwd);
                }}
                onToggleShowAll={() => toggleShowAll(project.cwd)}
                onSelectSession={onSelectSession}
                onRenamed={loadSessions}
                onSessionDeleted={(id) => {
                  onSessionDeleted?.(id);
                  loadSessions();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setProjectMenu({ cwd: project.cwd, x: event.clientX, y: event.clientY });
                }}
                compact={compact}
                isActiveProject={project.cwd === activeSelectedCwd}
              />
            ))}
            {!compact && !normalizedSearchQuery && allProjectsState === "expanded" && (showAllProjects || hiddenProjectCount > 0) && (
              <button type="button" className="sidebar-more-button" onClick={() => setShowAllProjects((value) => !value)}>
                {showAllProjects ? "收起项目" : `更多项目 (${hiddenProjectCount})`}
              </button>
            )}
          </section>
        )}
        {!loading && !compact && recentSessions.length > 0 && (
          <section aria-labelledby="recent-sessions-heading">
            <div id="recent-sessions-heading" className="sidebar-section-heading">
              最近
            </div>
            <div style={{ display: "grid", gap: 2 }}>
              {recentSessions.map((session) => (
                <SessionItem
                  key={`recent-${session.id}`}
                  session={session}
                  isSelected={session.id === selectedSessionId}
                  runningStatus={runningSessionStatuses.get(session.id)}
                  onClick={() => onSelectSession(session)}
                  onRenamed={loadSessions}
                  onDeleted={(id) => {
                    onSessionDeleted?.(id);
                    loadSessions();
                  }}
                  showProject
                />
              ))}
            </div>
          </section>
        )}
        {compact && (
          <div style={{ padding: "6px 0", display: "flex", justifyContent: "center" }}>
            <button type="button" className="sidebar-heading-action" onClick={handleCustomPath} title="添加项目" aria-label="添加项目">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
        )}
      </div>

      {projectMenu && (() => {
        const project = projects.find((p) => p.cwd === projectMenu.cwd);
        if (!project) return null;
        const isDefault = project.cwd === defaultCwd;
        const pinned = projectMeta.pinnedCwds.includes(project.cwd);
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
        return (
          <div
            style={{
              position: "fixed",
              left: projectMenu.x,
              top: projectMenu.y,
              zIndex: 1000,
              width: 178,
              padding: 6,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div style={{ padding: "5px 8px 7px", color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={project.cwd}>
              {project.displayName ?? getProjectDisplayName(project.cwd)}
            </div>
            <button style={itemStyle} onClick={() => { setProjectMenu(null); void handleReselectProjectPath(project.cwd); }}>
              重新选定路径
            </button>
            <button style={itemStyle} onClick={() => { setProjectMenu(null); handleProjectNote(project.cwd); }}>
              备注
            </button>
            <button
              style={itemStyle}
              onClick={() => { setProjectMenu(null); handleToggleProjectPinned(project.cwd); }}
            >
              {pinned ? "取消置顶" : "置顶"}
            </button>
            <div style={{ height: 1, background: "var(--border)", margin: "5px 4px" }} />
            <button
              style={{ ...itemStyle, color: isDefault ? "var(--text-dim)" : "#ef4444", cursor: isDefault ? "default" : "pointer", opacity: isDefault ? 0.45 : 1 }}
              disabled={isDefault}
              onClick={() => { setProjectMenu(null); handleRemoveProjectReference(project.cwd); }}
            >
              删除项目引入
            </button>
            <button
              style={{ ...itemStyle, color: isDefault ? "var(--text-dim)" : "#b91c1c", cursor: isDefault || purging ? "default" : "pointer", opacity: isDefault || purging ? 0.45 : 1 }}
              disabled={isDefault || purging}
              title={isDefault ? "默认项目不支持彻底删除" : "永久删除该项目下的全部会话文件"}
              onClick={() => { setProjectMenu(null); handlePurgeProjectSessions(project.cwd); }}
            >
              {purging ? "删除中…" : "彻底删除所有会话"}
            </button>
          </div>
        );
      })()}

      {/* Purge confirmation modal (Tauri blocks window.confirm, so we use React) */}
      {confirmPurge && (
        <div
          onClick={() => setConfirmPurge(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(440px, calc(100vw - 40px))",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "0 16px 40px rgba(0,0,0,0.3)",
              padding: 18,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
              彻底删除该项目所有会话？
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 6 }}>
              项目：<b style={{ color: "var(--text)" }}>{confirmPurge.displayName}</b>
            </div>
            <div
              style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 14, wordBreak: "break-all" }}
            >
              {confirmPurge.cwd}
            </div>
            <div style={{ fontSize: 12, color: "#ef4444", lineHeight: 1.6, marginBottom: 16, padding: "8px 10px", background: "rgba(239,68,68,0.08)", borderRadius: 8, border: "1px solid rgba(239,68,68,0.2)" }}>
              此操作不可恢复，将永久删除该项目目录下的全部会话文件（.jsonl）。如仅需从侧边栏隐藏，请使用“删除项目引入”。
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setConfirmPurge(null)}
                style={{ padding: "7px 16px", background: "transparent", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                取消
              </button>
              <button
                disabled={purging}
                onClick={() => { void executePurge(); }}
                style={{ padding: "7px 16px", background: purging ? "#b91c1c99" : "#dc2626", border: "none", borderRadius: 7, color: "#fff", cursor: purging ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}
              >
                {purging ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purge result modal (replaces window.alert) */}
      {purgeResult && (
        <div
          onClick={() => setPurgeResult(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(400px, calc(100vw - 40px))",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "0 16px 40px rgba(0,0,0,0.3)",
              padding: 18,
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, marginBottom: 16 }}>
              {purgeResult.message}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => setPurgeResult(null)}
                style={{ padding: "7px 16px", background: "var(--accent)", border: "none", borderRadius: 7, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SchedulerRunsBlock */}
      {!compact && (
        <SchedulerRunsBlock
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
        />
      )}

      {/* RemoteConnectionsBlock */}
      {!compact && (
        <RemoteConnectionsBlock
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
        />
      )}

      {/* Draggable splitter handle */}
      {explorerOpen && !compact && (selectedCwdProp || selectedCwd) && (
        <div
          ref={splitterRef}
          onMouseDown={handleSplitterMouseDown}
          style={{
            height: 6,
            flexShrink: 0,
            cursor: 'row-resize',
            borderTop: `1px solid ${isDraggingSplitter || isHoveringSplitter ? 'var(--text-muted)' : 'transparent'}`,
            background: 'var(--bg-subtle)',
            transition: isDraggingSplitter ? 'none' : 'border-color 0.15s',
          }}
          onMouseEnter={() => setIsHoveringSplitter(true)}
          onMouseLeave={() => setIsHoveringSplitter(false)}
        />
      )}



      {/* File Explorer section */}
      {!compact && (selectedCwdProp || selectedCwd) && (
        <div
          style={{
            background: "var(--bg-subtle)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? `${100 - splitPercent} 1 0` : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0, paddingTop: 2 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              资源管理器
            </button>
            <button
              onClick={() => {
                setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title="刷新资源管理器"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 26, padding: 0, marginRight: 6,
                background: explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none",
                border: "none",
                color: explorerRefreshDone ? "#4ade80" : "var(--text-dim)",
                cursor: "pointer",
                borderRadius: 5,
                flexShrink: 0,
                transition: "color 0.3s, background 0.3s",
              }}
              onMouseEnter={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { if (explorerRefreshDone) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
            >
              {explorerRefreshDone ? (
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
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                cwd={selectedCwdProp ?? selectedCwd!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function ProjectSection({
  project,
  expanded,
  showAll,
  selectedSessionId,
  runningSessionStatuses,
  onToggle,
  onToggleShowAll,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onContextMenu,
  compact = false,
  isActiveProject = false,
}: {
  project: ProjectGroup;
  expanded: boolean;
  showAll: boolean;
  selectedSessionId: string | null;
  runningSessionStatuses: Map<string, RunningSessionStatus>;
  onToggle: () => void;
  onToggleShowAll: () => void;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  compact?: boolean;
  isActiveProject?: boolean;
}) {
  const selectedInProject = selectedSessionId ? project.sessions.find((s) => s.id === selectedSessionId) : undefined;
  const collapsedLimit = 3;
  const limit = showAll ? project.sessions.length : collapsedLimit;
  let visibleSessions = project.sessions.slice(0, limit);
  if (selectedInProject && !showAll && !visibleSessions.some((s) => s.id === selectedInProject.id)) {
    visibleSessions = [...visibleSessions, selectedInProject];
  }
  const hiddenSessionCount = Math.max(0, project.sessions.length - collapsedLimit);
  const sessionTree = buildSessionTree(project.sessions);
  const projectTitle = project.displayName ?? getProjectDisplayName(project.cwd);
  const projectInitial = getInitial(projectTitle);
  const projectRowBackground = isActiveProject && !selectedInProject ? "var(--bg-selected)" : "transparent";

  return (
    <div
      style={{ marginBottom: compact ? 2 : 4 }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
      onMouseDown={(event) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event);
      }}
    >
      <button
        onClick={() => {
          if (compact && project.sessions.length > 0) {
            onSelectSession(project.sessions[0]);
          } else {
            onToggle();
          }
        }}
        style={{
          margin: compact ? "3px 6px" : "0 8px",
          borderRadius: compact ? 999 : 9,
          width: compact ? "calc(100% - 12px)" : "calc(100% - 16px)",
          display: "flex",
          alignItems: "center",
          height: compact ? 30 : 38,
          justifyContent: compact ? "center" : undefined,
          gap: compact ? 0 : 9,
          padding: compact ? 0 : "0 10px",
          background: compact ? (isActiveProject ? "var(--bg-selected)" : "transparent") : projectRowBackground,
          border: "none",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = compact ? (isActiveProject ? "var(--bg-selected)" : "transparent") : projectRowBackground; }}
        title={project.cwd}
      >
        {compact ? (
          <span
            aria-hidden="true"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: selectedInProject || isActiveProject ? "var(--accent)" : project.pinned ? "var(--text-muted)" : "var(--bg)",
              color: selectedInProject || isActiveProject || project.pinned ? "#fff" : "var(--text)",
              border: selectedInProject || isActiveProject ? "1px solid var(--accent)" : "1px solid var(--border)",
              boxShadow: selectedInProject || isActiveProject ? "0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
              flexShrink: 0,
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              lineHeight: 1,
            }}
          >
            {projectInitial}
          </span>
        ) : (
          <>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: selectedInProject || isActiveProject ? "var(--text)" : "var(--text-muted)" }}>
              <path d="M3 7.5V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: selectedInProject || isActiveProject ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>
              {projectTitle}
              {project.note && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {project.note}</span>}
            </span>
            {project.pinned && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="已置顶"><path d="m14 4 6 6-3 1-4 4-1 5-2-2-2-2 5-1 4-4Z" /></svg>
            )}
            {project.sessions.length > 0 && <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{project.sessions.length}</span>}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0, color: "var(--text-dim)" }}>
              <polyline points="3 2 7 5 3 8" />
            </svg>
          </>
        )}
      </button>

      {(compact || expanded) && (
        <div>
          {showAll && !compact ? sessionTree.map((node) => (
            <SessionTreeItem key={node.session.id} node={node} selectedSessionId={selectedSessionId} runningSessionStatuses={runningSessionStatuses} onSelectSession={onSelectSession} onRenamed={onRenamed} onSessionDeleted={onSessionDeleted} depth={0} compact={compact} />
          )) : visibleSessions.map((session) => (
            <SessionItem key={session.id} session={session} isSelected={session.id === selectedSessionId} runningStatus={runningSessionStatuses.get(session.id)} onClick={() => onSelectSession(session)} onRenamed={onRenamed} onDeleted={(id) => onSessionDeleted?.(id)} depth={0} compact={compact} />
          ))}
          {project.sessions.length > collapsedLimit && !compact && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleShowAll(); }}
              style={{
                width: "calc(100% - 16px)",
                margin: "0 8px",
                padding: "4px 10px 6px 32px",
                background: "none",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 10,
                textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {showAll ? "收起" : `更多 ${hiddenSessionCount} 条`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionStatuses,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  compact = false,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionStatuses: Map<string, RunningSessionStatus>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  compact?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {depth > 0 && !compact && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          runningStatus={runningSessionStatuses.get(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          compact={compact}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionStatuses={runningSessionStatuses}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  runningStatus,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  compact = false,
  showProject = false,
}: {
  session: SessionInfo;
  isSelected: boolean;
  runningStatus?: RunningSessionStatus;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  compact?: boolean;
  showProject?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; copied: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const sessionInitial = getInitial(title);
  const hasRunningStatus = Boolean(runningStatus);
  const isRunning = Boolean(runningStatus?.isStreaming || runningStatus?.isCompacting);
  const runningText = runningStatus ? formatRunningStatus(runningStatus, statusClock) : null;
  const projectName = getProjectDisplayName(session.cwd);

  useEffect(() => {
    if (!hasRunningStatus) return;
    const timer = window.setInterval(() => setStatusClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningStatus]);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useEffect(() => () => {
    if (contextMenuCloseTimerRef.current) clearTimeout(contextMenuCloseTimerRef.current);
  }, []);

  const copySessionId = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(session.id);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = session.id;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setContextMenu((current) => current ? { ...current, copied: true } : current);
    if (contextMenuCloseTimerRef.current) clearTimeout(contextMenuCloseTimerRef.current);
    contextMenuCloseTimerRef.current = setTimeout(() => setContextMenu(null), 800);
  }, [session.id]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = compact ? 28 : showProject ? 44 : 36;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseDown={(event) => {
        if (event.button === 2) event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const menuWidth = 220;
        const menuHeight = 72;
        setContextMenu({
          x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
          y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
          copied: false,
        });
      }}
      className="sidebar-session-item"
      role="button"
      tabIndex={confirmDelete || renaming ? -1 : 0}
      aria-current={isSelected ? "page" : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if ((event.key === "Enter" || event.key === " ") && !confirmDelete && !renaming) {
          event.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: compact ? "center" : undefined,
        paddingLeft: compact ? 0 : showProject ? 11 : depth > 0 ? depth * 12 + 30 : 40,
        paddingRight: compact ? 0 : 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        border: "none",
        borderRadius: compact ? 8 : 9,
        margin: compact ? "2px 6px" : "0 8px",
        width: compact ? undefined : "calc(100% - 16px)",
        transition: "background 0.1s, color 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            确定删除会话 <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span> 吗？
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              删除
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              取消
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {compact && (
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isSelected ? "transparent" : "transparent",
                color: isSelected ? "var(--accent)" : "var(--text-muted)",
                border: isSelected ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                boxShadow: isSelected ? "0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)" : undefined,
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                lineHeight: 1,
                position: "relative",
              }}
            >
              {sessionInitial}
              {isRunning && <span className="session-running-dot" style={{ position: "absolute", right: -3, bottom: -3, width: 9, height: 9, borderWidth: 2 }} />}
            </span>
          )}
          {!compact && (
            <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && !compact && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: isSelected ? 550 : 400,
                lineHeight: 1.35,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text)",
                letterSpacing: "-0.01em",
              }}
              title={title}
            >
              {title}
            </div>
            {(showProject || runningText) && (
              <div style={{ marginTop: 2, display: "flex", gap: 6, color: isRunning ? "var(--accent)" : "var(--text-dim)", fontSize: 10.5, minWidth: 0, lineHeight: 1.2 }}>
                {runningText ? (
                  <span title={runningText} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{runningText}</span>
                ) : (
                  <>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectName}</span>
                    <span aria-hidden="true">·</span>
                    <span title={session.modified} style={{ whiteSpace: "nowrap" }}>{formatRelativeTime(session.modified)}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "展开分支" : "收起分支"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Running indicator */}
          {isRunning && (
            <span
              aria-label="会话正在运行"
              title="会话正在运行"
              className="session-running-dot"
              style={{ flexShrink: 0 }}
            />
          )}

          {/* Action buttons — shown on hover */}
          {hovered && !compact && (
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title="重命名"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "transparent", border: "none",
                  borderRadius: 6, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title="删除"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "transparent", border: "none",
                  borderRadius: 6, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
            </>
          )}
        </>
      )}
      {contextMenu && createPortal(
        <div
          role="menu"
          aria-label="Session 操作"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1100,
            width: 220,
            padding: 6,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
          }}
        >
          <div
            title={session.id}
            style={{
              padding: "5px 8px 7px",
              color: "var(--text-dim)",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.id}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={copySessionId}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "7px 9px",
              background: "transparent",
              border: "none",
              borderRadius: 7,
              color: contextMenu.copied ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
            }}
          >
            {contextMenu.copied ? "已复制 Session ID" : "复制 Session ID"}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
