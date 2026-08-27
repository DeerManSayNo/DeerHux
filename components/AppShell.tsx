"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { PointerEvent as PointerEventType, MouseEvent as MouseEventType, ReactNode } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { CHAT_LAYOUT_COUNTS, ChatWorkspace, type ChatLayoutMode } from "./ChatWorkspace";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { WindowControls, useNeedsWindowControls } from "./WindowControls";
import type { Tab } from "./TabBar";
import { getLocalStorageItem } from "@/lib/client-storage";
import { normalizeExternalHref, openExternalLink } from "@/lib/external-links";
import { getRelativeFilePath } from "@/lib/file-paths";
import { retainCwdWorkspaceState } from "@/lib/workspace-cwd-state";
import { getProjectDisplayName } from "@/lib/project-name";
import {
  FILE_PREVIEW_CHANNEL_NAME,
  FILE_PREVIEW_STATE_STORAGE_KEY,
  FILE_PREVIEW_TAURI_COMMAND_EVENT,
  FILE_PREVIEW_TAURI_STATE_EVENT,
  FILE_PREVIEW_WINDOW_LABEL,
  type FilePreviewChannelMessage,
  type FilePreviewState,
} from "@/lib/file-preview-window";
import { useTheme } from "@/hooks/useTheme";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { SessionInfo } from "@/lib/types";
import { subscribeHostEvents } from "@/lib/agent-event-client";
import type { ChatInputHandle, ChatInputState } from "./ChatInput";
import { ChatDraftStore, clearCwdScopedDraftResources, promoteNewSessionDraft } from "@/lib/chat-drafts";
import { getChatRenderKey, promoteChatRenderKey } from "@/lib/chat-render-keys";

type SidebarMode = "open" | "closed";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function ConfigurationPanelLoading() {
  return (
    <div
      aria-label="正在打开配置窗口"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.28)",
      }}
    >
      <div
        style={{
          padding: "12px 18px",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          fontSize: 13,
        }}
      >
        正在打开…
      </div>
    </div>
  );
}

// Keep configuration panels split from the initial shell. AppShell preloads these
// chunks after its first paint, while the themed fallback prevents a white flash if
// a panel is opened before its chunk has arrived. Next.js requires each dynamic()
// options argument to be an inline object literal so it can be statically analyzed.
const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), {
  loading: ConfigurationPanelLoading,
});
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), {
  loading: ConfigurationPanelLoading,
});
const SchedulerPanel = dynamic(() => import("./SchedulerPanel").then((module) => module.SchedulerPanel), {
  loading: ConfigurationPanelLoading,
});
const RoleConfig = dynamic(() => import("./RoleConfig").then((module) => module.RoleConfig), {
  loading: ConfigurationPanelLoading,
});
const MemoryConfig = dynamic(() => import("./MemoryConfig").then((module) => module.MemoryConfig), {
  loading: ConfigurationPanelLoading,
});
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig), {
  loading: ConfigurationPanelLoading,
});
const ExtensionsConfig = dynamic(() => import("./ExtensionsConfig").then((module) => module.ExtensionsConfig), {
  loading: ConfigurationPanelLoading,
});
const WeChatConfig = dynamic(() => import("./WeChatConfig").then((module) => module.WeChatConfig), {
  loading: ConfigurationPanelLoading,
});

function preloadConfigurationPanels() {
  void Promise.allSettled([
    import("./ModelsConfig"),
    import("./SkillsConfig"),
    import("./SchedulerPanel"),
    import("./RoleConfig"),
    import("./MemoryConfig"),
    import("./McpConfig"),
    import("./ExtensionsConfig"),
    import("./WeChatConfig"),
  ]);
}

const WINDOW_DRAG_HEIGHT = 32;
const WINDOW_DRAG_EXCLUDE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='menuitem']",
  "[contenteditable='true']",
  "[data-no-window-drag]",
  "[data-tauri-drag-region='false']",
].join(",");

function shouldStartWindowDrag(event: PointerEventType<Element>) {
  if (event.button !== 0 || event.clientY > WINDOW_DRAG_HEIGHT || event.defaultPrevented) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return !target.closest(WINDOW_DRAG_EXCLUDE_SELECTOR);
}

type RunningSessionStatus = {
  sessionId: string;
  running?: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  lastEventType: string;
  eventCount: number;
  eventRate: number;
  eventIdleMs: number | null;
  contentIdleMs: number | null;
};

const MAX_CHAT_WINDOWS = 6;
const CHAT_WINDOW_LIMIT_MESSAGE = "请先关闭一个窗口";

function layoutModeForSlotCount(count: number): ChatLayoutMode {
  if (count <= 1) return "single";
  if (count === 2) return "double";
  if (count === 3) return "triple";
  if (count <= 4) return "quad";
  return "six";
}

const CUSTOM_CWDS_STORAGE_KEY = "deerhux.custom-cwds";

function readCustomCwds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(getLocalStorageItem(CUSTOM_CWDS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function AppShell() {
  const searchParams = useSearchParams();
  const { isDark, toggleTheme } = useTheme();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const selectedSessionRef = useRef<SessionInfo | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  const pendingSessionRef = useRef<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const newSessionCwdRef = useRef<string | null>(null);
  // Open chat sessions are assigned to workspace slots; layout follows the slot count.
  const [sessionTabs, setSessionTabs] = useState<SessionInfo[]>([]);
  const sessionTabsRef = useRef<SessionInfo[]>([]);
  const [activeSessionTabId, setActiveSessionTabId] = useState<string | null>(null);
  const activeSessionTabIdRef = useRef<string | null>(null);
  const [chatSlotIds, setChatSlotIds] = useState<(string | null)[]>(() => Array(MAX_CHAT_WINDOWS).fill(null));
  const chatSlotIdsRef = useRef<(string | null)[]>(Array(MAX_CHAT_WINDOWS).fill(null));
  const chatRenderKeysRef = useRef(new Map<string, string>());
  const chatDraftsRef = useRef(new ChatDraftStore<ChatInputState>());
  const [focusedChatSlotIndex, setFocusedChatSlotIndex] = useState(0);
  const focusedChatSlotIndexRef = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [extensionsConfigOpen, setExtensionsConfigOpen] = useState(false);
  const [quickConfigOpen, setQuickConfigOpen] = useState<"memory" | "mcp" | "role" | null>(null);
  const [schedulerPanelOpen, setSchedulerPanelOpen] = useState(false);
  const [wechatConfigOpen, setWechatConfigOpen] = useState(false);
  const [wechatStatus, setWechatStatus] = useState<{ connected: boolean; polling: boolean; accountId?: string; activeUserCount?: number } | null>(null);
  const [runningSessionStatuses, setRunningSessionStatuses] = useState<Map<string, RunningSessionStatus>>(new Map());
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  const hostRunningBaselineReceivedRef = useRef(false);
  const pendingSessionIdsBySlotRef = useRef<Map<number, string>>(new Map());
  const pendingTempTabIdsBySlotRef = useRef<Map<number, string>>(new Map());
  // Track which tab ids are genuine placeholders (not real sessions),
  // so handleSelectSession knows when to show a new-session UI vs load from API.
  const placeholderTabIdsRef = useRef<Set<string>>(new Set());
  const ignoredWorkspaceSessionIdsRef = useRef<Set<string>>(new Set());
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("open");
  const sidebarOpen = sidebarMode === "open";
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 500;
  const [sidebarWidth, setSidebarWidth] = useState<number>(280);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(260);

  // Right panel (file viewer) resize
  const RIGHT_PANEL_MIN = 250;
  const RIGHT_PANEL_MAX = 1000;
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(500);
  const [isResizingRightPanel, setIsResizingRightPanel] = useState(false);
  const rightPanelResizeStartX = useRef(0);
  const rightPanelResizeStartWidth = useRef(500);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const wechatAutoStartAttemptedRef = useRef(false);
  const [chatWindowLimitNotice, setChatWindowLimitNotice] = useState<string | null>(null);
  const chatWindowLimitNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(preloadConfigurationPanels, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const replaceUrl = useCallback((url: string) => {
    window.history.replaceState(null, "", url);
  }, []);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [filePreviewDetached, setFilePreviewDetached] = useState(false);
  const filePreviewChannelRef = useRef<BroadcastChannel | null>(null);
  const filePreviewStateRef = useRef<FilePreviewState>({ tabs: [], activeTabId: null, cwd: null, viewerCwd: null });
  const filePreviewPopupRef = useRef<Window | null>(null);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.addReference(relativePath);
  }, []);

  const handleProjectsChange = useCallback((projects: { cwd: string; displayName: string }[]) => {
    setProjectOptions(projects);
  }, []);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeCwdRef = useRef<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [customCwds, setCustomCwds] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<{ cwd: string; displayName: string }[]>([]);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [topActionBarHovered, setTopActionBarHovered] = useState(false);
  const topActionBarHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Windows/Linux 无边框主窗口需要在左上角自绘仿 macOS 红绿灯窗口控制按钮。
  const needsWindowControls = useNeedsWindowControls();

  useEscapeClose(() => setSettingsMenuOpen(false), settingsMenuOpen);

  const effectiveProjectCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? defaultCwd;
  const sidebarOptimisticSessions = useMemo(() => {
    const byId = new Map<string, SessionInfo>();
    const add = (session: SessionInfo | null | undefined) => {
      if (session && !session.isSubagent) byId.set(session.id, session);
    };
    add(pendingSession);
    add(selectedSession);
    for (const tab of sessionTabs) {
      if (placeholderTabIdsRef.current.has(tab.id)) add(tab);
    }
    return [...byId.values()];
  }, [pendingSession, selectedSession, sessionTabs]);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));
  // Suppresses extra cwd handling during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    pendingSessionRef.current = pendingSession;
  }, [pendingSession]);

  useEffect(() => {
    newSessionCwdRef.current = newSessionCwd;
  }, [newSessionCwd]);

  useEffect(() => {
    sessionTabsRef.current = sessionTabs;
  }, [sessionTabs]);

  useEffect(() => {
    runningSessionIdsRef.current = new Set(runningSessionStatuses.keys());
  }, [runningSessionStatuses]);

  useEffect(() => {
    activeSessionTabIdRef.current = activeSessionTabId;
  }, [activeSessionTabId]);

  useEffect(() => {
    focusedChatSlotIndexRef.current = focusedChatSlotIndex;
  }, [focusedChatSlotIndex]);

  useEffect(() => {
    activeCwdRef.current = activeCwd;
  }, [activeCwd]);

  useEffect(() => {
    const handleExternalLinkClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      if (!(event.target instanceof Element)) return;

      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = anchor.getAttribute("href");
      if (!href || !normalizeExternalHref(href)) return;

      event.preventDefault();
      void openExternalLink(href);
    };

    document.addEventListener("click", handleExternalLinkClick);
    return () => document.removeEventListener("click", handleExternalLinkClick);
  }, []);

  // Sync client-only localStorage state after mount to avoid hydration mismatch
  useEffect(() => {
    const storedWidth = getLocalStorageItem("deerhux.sidebar-width");
    if (storedWidth) {
      const parsed = parseInt(storedWidth, 10);
      if (Number.isFinite(parsed)) setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed)));
    }
    const storedRightWidth = getLocalStorageItem("deerhux.right-panel-width");
    if (storedRightWidth) {
      const parsed = parseInt(storedRightWidth, 10);
      if (Number.isFinite(parsed)) setRightPanelWidth(Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, parsed)));
    }
    setCustomCwds(readCustomCwds());
  }, []);

  useEffect(() => {
    fetch("/api/default-cwd", { method: "POST" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((data: { cwd?: string }) => { if (data.cwd) setDefaultCwd(data.cwd); })
      .catch(() => {});
  }, []);

  const loadRunningSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/running", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { runningSessionIds?: string[]; sessions?: RunningSessionStatus[] };
      if (!hostRunningBaselineReceivedRef.current) {
        setRunningSessionStatuses(new Map(
          (data.sessions ?? [])
            .filter((session) => !ignoredWorkspaceSessionIdsRef.current.has(session.sessionId))
            .map((session) => [session.sessionId, session]),
        ));
      }
    } catch {
      if (!hostRunningBaselineReceivedRef.current) setRunningSessionStatuses(new Map());
    }
  }, []);

  useEffect(() => {
    // One HTTP fallback covers startup before the mux baseline. Afterwards all
    // running flips are delivered on the existing tab-global EventSource.
    void loadRunningSessions();
    let previousIds = new Set<string>();
    return subscribeHostEvents((frame) => {
      hostRunningBaselineReceivedRef.current = true;
      const next = new Map(frame.sessions
        .filter((session) => !ignoredWorkspaceSessionIdsRef.current.has(session.sessionId))
        .map((session) => [session.sessionId, session]));
      const nextIds = new Set(next.keys());
      const changed = nextIds.size !== previousIds.size || [...nextIds].some((id) => !previousIds.has(id));
      previousIds = nextIds;
      setRunningSessionStatuses(next);
      // Session modified timestamps and newly-created sessions only need a
      // refresh at semantic turn boundaries, never on a periodic timer.
      if (changed) setRefreshKey((key) => key + 1);
    });
  }, [loadRunningSessions]);

  // Poll WeChat bot status for the settings dropdown inline indicator
  useEffect(() => {
    const fetchWechat = () => {
      fetch("/api/wechat", { cache: "no-store" })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => {
          if (!data) return;
          setWechatStatus(data);
          if (!wechatAutoStartAttemptedRef.current && data.connected && !data.polling) {
            wechatAutoStartAttemptedRef.current = true;
            fetch("/api/wechat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "start" }),
            })
              .then((res) => res.ok ? fetchWechat() : null)
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    fetchWechat();
    const interval = setInterval(fetchWechat, 5000);
    return () => clearInterval(interval);
  }, []);

  const setSessionRunning = useCallback((sessionId: string | null | undefined, running: boolean) => {
    if (!sessionId || (running && ignoredWorkspaceSessionIdsRef.current.has(sessionId))) return;
    setRunningSessionStatuses((prev) => {
      const next = new Map(prev);
      if (running) {
        const existing = next.get(sessionId);
        next.set(sessionId, existing ?? {
          sessionId,
          isStreaming: true,
          isCompacting: false,
          lastEventType: "agent_start",
          eventCount: 0,
          eventRate: 0,
          eventIdleMs: 0,
          contentIdleMs: 0,
        });
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }, []);

  const handleCwdChange = useCallback((cwd: string | null) => {
    setActiveCwd(cwd);
    activeCwdRef.current = cwd;
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    // URL restore deliberately keeps the restored session workspace intact.
    if (!cwd || suppressCwdBumpRef.current) return;

    const workspace = retainCwdWorkspaceState({
      sessionTabs: sessionTabsRef.current,
      chatSlotIds: chatSlotIdsRef.current,
      selectedSession: selectedSessionRef.current,
      pendingSession: pendingSessionRef.current,
      activeSessionTabId: activeSessionTabIdRef.current,
      newSessionCwd: newSessionCwdRef.current,
      focusedChatSlotIndex: focusedChatSlotIndexRef.current,
      placeholderTabIds: placeholderTabIdsRef.current,
      pendingSessionIdsBySlot: pendingSessionIdsBySlotRef.current,
      pendingTempTabIdsBySlot: pendingTempTabIdsBySlotRef.current,
      runningSessionIds: runningSessionIdsRef.current,
    }, cwd);

    // Keep refs in sync before React commits. Async ChatWindow callbacks read
    // these refs, so leaving the old values until an effect runs can resurrect
    // a tab from the previously selected project.
    const retainedSessionIds = new Set(workspace.sessionTabs.map((session) => session.id));
    ignoredWorkspaceSessionIdsRef.current = new Set([
      ...[...ignoredWorkspaceSessionIdsRef.current].filter((sessionId) => !retainedSessionIds.has(sessionId)),
      ...workspace.staleSessionIds,
    ]);
    sessionTabsRef.current = workspace.sessionTabs;
    chatSlotIdsRef.current = workspace.chatSlotIds;
    selectedSessionRef.current = workspace.selectedSession;
    pendingSessionRef.current = workspace.pendingSession;
    activeSessionTabIdRef.current = workspace.activeSessionTabId;
    newSessionCwdRef.current = workspace.newSessionCwd;
    focusedChatSlotIndexRef.current = workspace.focusedChatSlotIndex;
    placeholderTabIdsRef.current = workspace.placeholderTabIds;
    pendingSessionIdsBySlotRef.current = workspace.pendingSessionIdsBySlot;
    pendingTempTabIdsBySlotRef.current = workspace.pendingTempTabIdsBySlot;
    runningSessionIdsRef.current = workspace.runningSessionIds;

    setSessionTabs(workspace.sessionTabs);
    setChatSlotIds(workspace.chatSlotIds);
    setSelectedSession(workspace.selectedSession);
    setPendingSession(workspace.pendingSession);
    setActiveSessionTabId(workspace.activeSessionTabId);
    setNewSessionCwd(workspace.newSessionCwd);
    setFocusedChatSlotIndex(workspace.focusedChatSlotIndex);
    setRunningSessionStatuses((previous) => new Map(
      [...previous].filter(([sessionId]) => workspace.runningSessionIds.has(sessionId)),
    ));
    replaceUrl("/");
  }, [replaceUrl]);

  const handleNewSessionProjectChange = useCallback((cwd: string, slotIndex: number) => {
    const previousTempId = chatSlotIdsRef.current[slotIndex] ?? null;
    if (!previousTempId || !placeholderTabIdsRef.current.has(previousTempId)) return;

    // 项目选择属于当前空白聊天槽位，而不是整个工作区。为目标项目创建一个
    // 全新的会话占位项；不能复用 handleCwdChange，因为后者会按 CWD 过滤所有
    // 已打开的槽位，导致其他项目的会话看起来被关闭。
    const nextTempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const previousDraft = chatDraftsRef.current.get(slotIndex, previousTempId);
    chatDraftsRef.current.clear(slotIndex, previousTempId);
    if (previousDraft) {
      // 文本可以作为新会话草稿保留；项目相关资源绝不能跨项目携带。
      chatDraftsRef.current.set(slotIndex, nextTempId, clearCwdScopedDraftResources(previousDraft));
    }

    const nextPlaceholder: SessionInfo = {
      path: "",
      id: nextTempId,
      cwd,
      name: "新会话",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    const nextTabs = sessionTabsRef.current.map((tab) => (
      tab.id === previousTempId ? nextPlaceholder : tab
    ));
    const nextSlotIds = chatSlotIdsRef.current.map((id, index) => (
      index === slotIndex ? nextTempId : id
    ));
    // 项目变化意味着一个新的逻辑聊天。不要继承旧占位窗口的 React 身份，
    // 否则旧项目的 Hook 状态、历史和迟到异步结果会进入新项目。
    chatRenderKeysRef.current.delete(previousTempId);

    // 先同步所有 imperative ref，避免旧 ChatWindow 的异步回调把已切换的
    // 占位项或其他槽位重新写回状态。
    sessionTabsRef.current = nextTabs;
    chatSlotIdsRef.current = nextSlotIds;
    placeholderTabIdsRef.current.delete(previousTempId);
    placeholderTabIdsRef.current.add(nextTempId);
    pendingSessionIdsBySlotRef.current.delete(slotIndex);
    pendingTempTabIdsBySlotRef.current.set(slotIndex, nextTempId);
    activeCwdRef.current = cwd;
    focusedChatSlotIndexRef.current = slotIndex;
    activeSessionTabIdRef.current = nextTempId;
    selectedSessionRef.current = null;
    newSessionCwdRef.current = cwd;

    // 仅更新当前项目指向，绝不运行全局 CWD 收敛/清理逻辑。
    setActiveCwd(cwd);
    setSessionTabs(nextTabs);
    setChatSlotIds(nextSlotIds);
    setFocusedChatSlotIndex(slotIndex);
    setActiveSessionTabId(nextTempId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    replaceUrl("/");
  }, [replaceUrl]);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const close = () => setSettingsMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [settingsMenuOpen]);

  useEffect(() => {
    chatSlotIdsRef.current = chatSlotIds;
  }, [chatSlotIds]);

  const showChatWindowLimitMessage = useCallback(() => {
    setChatWindowLimitNotice(CHAT_WINDOW_LIMIT_MESSAGE);
    if (chatWindowLimitNoticeTimerRef.current) {
      clearTimeout(chatWindowLimitNoticeTimerRef.current);
    }
    chatWindowLimitNoticeTimerRef.current = setTimeout(() => {
      setChatWindowLimitNotice(null);
      chatWindowLimitNoticeTimerRef.current = null;
    }, 2200);
  }, []);

  const hasOpenChatWindowCapacity = useCallback(() => {
    return chatSlotIdsRef.current.some((id) => id === null);
  }, []);

  useEffect(() => {
    return () => {
      if (chatWindowLimitNoticeTimerRef.current) {
        clearTimeout(chatWindowLimitNoticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setChatSlotIds((prev) => {
      const tabIds = new Set(sessionTabs.map((tab) => tab.id));
      const assignedIds: string[] = [];
      for (const id of prev) {
        if (id && tabIds.has(id) && !assignedIds.includes(id)) assignedIds.push(id);
      }
      for (const tab of sessionTabs) {
        if (!assignedIds.includes(tab.id)) assignedIds.push(tab.id);
      }
      const next = [...assignedIds.slice(0, MAX_CHAT_WINDOWS), ...Array(Math.max(0, MAX_CHAT_WINDOWS - assignedIds.length)).fill(null)].slice(0, MAX_CHAT_WINDOWS);
      const changed = next.some((id, index) => id !== prev[index]);
      if (changed) chatSlotIdsRef.current = next;
      return changed ? next : prev;
    });
  }, [sessionTabs]);

  const occupiedChatSlotCount = chatSlotIds.filter(Boolean).length;
  const chatLayoutMode = layoutModeForSlotCount(occupiedChatSlotCount);
  const visibleChatSlotCount = CHAT_LAYOUT_COUNTS[chatLayoutMode];
  const visibleChatSlotIds = chatSlotIds.slice(0, visibleChatSlotCount);

  useEffect(() => {
    setFocusedChatSlotIndex((index) => Math.min(index, visibleChatSlotCount - 1));
  }, [visibleChatSlotCount]);

  useEffect(() => {
    const focusedSessionId = chatSlotIds[focusedChatSlotIndex] ?? null;
    if (!focusedSessionId) {
      if (sessionTabs.length === 0) {
        setSelectedSession(null);
        setActiveSessionTabId(null);
        setNewSessionCwd(null);
      }
      return;
    }

    const focusedSession = sessionTabs.find((tab) => tab.id === focusedSessionId) ?? null;
    if (!focusedSession) return;

    setActiveSessionTabId(focusedSession.id);
    if (placeholderTabIdsRef.current.has(focusedSession.id)) {
      setSelectedSession(null);
      setNewSessionCwd(focusedSession.cwd);
      replaceUrl("/");
      return;
    }

    setSelectedSession(focusedSession);
    setNewSessionCwd(null);
    replaceUrl(`?session=${encodeURIComponent(focusedSession.id)}`);
  }, [chatSlotIds, focusedChatSlotIndex, replaceUrl, sessionTabs]);

  const isPlaceholderSession = useCallback((sessionId: string) => {
    return placeholderTabIdsRef.current.has(sessionId);
  }, []);

  const getTargetChatSlotIndex = useCallback((sessionId: string) => {
    const slots = chatSlotIdsRef.current;
    const existingSlotIndex = slots.indexOf(sessionId);
    const firstEmptyIndex = slots.findIndex((id) => id === null);
    return existingSlotIndex >= 0 ? existingSlotIndex : firstEmptyIndex >= 0 ? firstEmptyIndex : focusedChatSlotIndex;
  }, [focusedChatSlotIndex]);

  const placeSessionInFocusedSlot = useCallback((sessionId: string) => {
    const targetIndex = getTargetChatSlotIndex(sessionId);
    setFocusedChatSlotIndex(targetIndex);
    setChatSlotIds((prev) => {
      const hasDuplicate = prev.some((id, index) => id === sessionId && index !== targetIndex);
      if (prev[targetIndex] === sessionId && !hasDuplicate) return prev;
      const next = prev.map((id, index) => (id === sessionId && index !== targetIndex ? null : id));
      next[targetIndex] = sessionId;
      chatSlotIdsRef.current = next;
      return next;
    });
  }, [getTargetChatSlotIndex]);

  const placeSessionInLeftmostSlot = useCallback((sessionId: string) => {
    setFocusedChatSlotIndex(0);
    setChatSlotIds((prev) => {
      const remainingIds = prev.filter((id): id is string => Boolean(id) && id !== sessionId);
      const next = [sessionId, ...remainingIds, ...Array(MAX_CHAT_WINDOWS).fill(null)].slice(0, MAX_CHAT_WINDOWS);
      const changed = next.some((id, index) => id !== prev[index]);
      if (changed) chatSlotIdsRef.current = next;
      return changed ? next : prev;
    });
  }, []);

  const handleFocusChatSlot = useCallback((slotIndex: number) => {
    setFocusedChatSlotIndex(slotIndex);
  }, []);

  const getSessionRenderKey = useCallback((sessionId: string) => {
    return getChatRenderKey(chatRenderKeysRef.current, sessionId);
  }, []);

  const getChatDraft = useCallback((slotIndex: number, sessionId: string) => {
    return chatDraftsRef.current.get(slotIndex, sessionId);
  }, []);

  const saveChatDraft = useCallback((slotIndex: number, sessionId: string, draft: ChatInputState) => {
    chatDraftsRef.current.set(slotIndex, sessionId, draft);
  }, []);

  const handleClearChatSlot = useCallback((slotIndex: number) => {
    const removedSessionId = chatSlotIds[slotIndex] ?? null;
    if (removedSessionId) chatDraftsRef.current.clear(slotIndex, removedSessionId);
    setChatSlotIds((prev) => {
      if (!prev[slotIndex]) return prev;
      const next = [...prev];
      next[slotIndex] = null;
      chatSlotIdsRef.current = next;
      return next;
    });
    if (removedSessionId) {
      chatRenderKeysRef.current.delete(removedSessionId);
      const pendingId = pendingSessionIdsBySlotRef.current.get(slotIndex);
      if (pendingId) setSessionRunning(pendingId, false);
      pendingSessionIdsBySlotRef.current.delete(slotIndex);
      pendingTempTabIdsBySlotRef.current.delete(slotIndex);
      placeholderTabIdsRef.current.delete(removedSessionId);
      setSessionTabs((prev) => prev.filter((tab) => tab.id !== removedSessionId));
      if (selectedSession?.id === removedSessionId || activeSessionTabId === removedSessionId) {
        setSelectedSession(null);
        setActiveSessionTabId(null);
        setNewSessionCwd(null);
        replaceUrl("/");
      }
    }
    if (slotIndex === focusedChatSlotIndex) {
      setSelectedSession(null);
    }
  }, [activeSessionTabId, chatSlotIds, focusedChatSlotIndex, replaceUrl, selectedSession?.id]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    ignoredWorkspaceSessionIdsRef.current.delete(session.id);
    // Do not clear pendingSession here: a newly-created session is not written
    // to disk by DeerHux until the first assistant message exists. If the user
    // switches away while that first response is still running, /api/sessions
    // cannot list it yet, so the sidebar must keep showing the optimistic row.
    // Only placeholder sessions show the new-session UI.
    if (placeholderTabIdsRef.current.has(session.id)) {
      newSessionCwdRef.current = session.cwd;
      selectedSessionRef.current = null;
      activeSessionTabIdRef.current = session.id;
      placeSessionInLeftmostSlot(session.id);
      setNewSessionCwd(session.cwd);
      setSelectedSession(null);
      setActiveSessionTabId(session.id);
      replaceUrl("/");
      return;
    }
    if (!chatSlotIdsRef.current.includes(session.id) && !hasOpenChatWindowCapacity()) {
      showChatWindowLimitMessage();
      return;
    }
    setNewSessionCwd(null);
    newSessionCwdRef.current = null;
    selectedSessionRef.current = session;
    activeSessionTabIdRef.current = session.id;
    // If the session came from the sidebar it may have updated fields (e.g. path,
    // name). Update the tracked session in place so subsequent slot renders have the real data.
    setSessionTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.id === session.id);
      if (existingIdx >= 0) {
        const updated = [...prev];
        updated[existingIdx] = { ...updated[existingIdx], ...session };
        return updated;
      }
      return [...prev, session];
    });
    placeSessionInLeftmostSlot(session.id);
    setSelectedSession(session);
    setActiveSessionTabId(session.id);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress redundant cwd handling that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
      setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
    }
    // Skip URL replacement when restoring from URL — the param is already correct
    // and touching App Router during production restore previously caused remount loops
    if (!isRestore) {
      replaceUrl(`?session=${encodeURIComponent(session.id)}`);
    }
  }, [hasOpenChatWindowCapacity, placeSessionInLeftmostSlot, replaceUrl, showChatWindowLimitMessage]);

  // worker tag 点击跳转到对应 worker session。
  // 注意：/api/sessions/[id] 返回的是包装对象 { sessionId, filePath, info, leafId, context }，
  // 真正的 SessionInfo 在 info 字段里，不能直接把整个响应当 SessionInfo 用，
  // 否则 session.id 为 undefined，会导致 tab 闪现后被槽位同步逻辑清除。
  const handleOpenSessionById = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as { info?: SessionInfo };
        // info 在 header 缺失时可能为 null；只要拿到合法 id 就直接打开。
        if (payload?.info?.id) {
          handleSelectSession(payload.info);
          return;
        }
      }
    } catch (err) {
      console.warn("获取 worker session 失败，尝试最小构造", err);
    }
    // 兜底：构造最小 SessionInfo
    const fallback: SessionInfo = {
      id: sessionId,
      cwd: activeCwd ?? defaultCwd ?? "",
      path: "",
      name: `Worker ${sessionId.slice(0, 8)}`,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    handleSelectSession(fallback);
  }, [handleSelectSession, activeCwd, defaultCwd]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    if (!hasOpenChatWindowCapacity()) {
      showChatWindowLimitMessage();
      return;
    }
    const targetSlotIndex = getTargetChatSlotIndex(_sessionId);
    // Create a placeholder session so the chat area shows up.
    const placeholder: SessionInfo = {
      path: "",
      id: _sessionId,
      cwd,
      name: "新会话",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    setSessionTabs((prev) => [...prev, placeholder]);
    placeSessionInFocusedSlot(_sessionId);
    setActiveSessionTabId(_sessionId);
    pendingTempTabIdsBySlotRef.current.set(targetSlotIndex, _sessionId);
    // Track this as a genuine placeholder so handleSelectSession shows
    // the new-session UI, not a real session load.
    placeholderTabIdsRef.current.add(_sessionId);
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    replaceUrl("/");
  }, [getTargetChatSlotIndex, hasOpenChatWindowCapacity, placeSessionInFocusedSlot, replaceUrl, showChatWindowLimitMessage]);

  const topNewSessionCwd = effectiveProjectCwd ?? projectOptions[0]?.cwd ?? defaultCwd;
  const canCreateTopSession = Boolean(topNewSessionCwd);

  const handleTopNewSession = useCallback(() => {
    const cwd = topNewSessionCwd;
    if (!cwd) return;
    if (!hasOpenChatWindowCapacity()) {
      showChatWindowLimitMessage();
      return;
    }
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const targetSlotIndex = getTargetChatSlotIndex(tempId);
    // Add a placeholder session immediately.
    const placeholder: SessionInfo = {
      path: "",
      id: tempId,
      cwd,
      name: "新会话",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 0,
      firstMessage: "",
    };
    setSessionTabs((prev) => [...prev, placeholder]);
    placeSessionInFocusedSlot(tempId);
    setActiveSessionTabId(tempId);
    pendingTempTabIdsBySlotRef.current.set(targetSlotIndex, tempId);
    // Track this as a genuine placeholder so handleSelectSession shows
    // the new-session UI, not a real session load.
    placeholderTabIdsRef.current.add(tempId);
    setPendingSession(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    replaceUrl("/");
  }, [getTargetChatSlotIndex, hasOpenChatWindowCapacity, placeSessionInFocusedSlot, replaceUrl, showChatWindowLimitMessage, topNewSessionCwd]);

  const handleSessionStarted = useCallback((session: SessionInfo | null, slotIndex: number, sourceSessionId?: string | null) => {
    // A ChatWindow can finish starting after its slot has switched to another
    // session. Ignore every late callback from the old logical window.
    if (sourceSessionId && chatSlotIdsRef.current[slotIndex] !== sourceSessionId) return;
    const sourceSession = sourceSessionId
      ? sessionTabsRef.current.find((candidate) => candidate.id === sourceSessionId)
      : null;
    if (session && sourceSession?.cwd && session.cwd !== sourceSession.cwd) return;
    if (!session) {
      const pendingId = pendingSessionIdsBySlotRef.current.get(slotIndex);
      if (pendingId) {
        setSessionRunning(pendingId, false);
      }
      pendingSessionIdsBySlotRef.current.delete(slotIndex);
      setPendingSession((prev) => (prev && prev.id === pendingId ? null : prev));
      return;
    }
    pendingSessionIdsBySlotRef.current.set(slotIndex, session.id);
    setPendingSession(session);
    setSessionRunning(session.id, true);
    setRefreshKey((k) => k + 1);
  }, [setSessionRunning]);

  // Called by ChatWindow when a new session gets its real id from DeerHux
  const handleSessionCreated = useCallback((session: SessionInfo, slotIndex = focusedChatSlotIndex, sourceSessionId?: string | null) => {
    // 回调必须仍属于发起它的槽位身份。仅凭 cwd 不够：同一项目内也可能在
    // 请求期间换了 session；迟到的创建结果绝不能覆盖新窗口。
    const currentSlotId = chatSlotIdsRef.current[slotIndex] ?? null;
    if (sourceSessionId && currentSlotId !== sourceSessionId) return;
    const sourceSession = sourceSessionId
      ? sessionTabsRef.current.find((candidate) => candidate.id === sourceSessionId)
      : null;
    if (sourceSession?.cwd && session.cwd !== sourceSession.cwd) return;
    const pendingId = pendingSessionIdsBySlotRef.current.get(slotIndex);
    if (pendingId) setSessionRunning(pendingId, false);
    pendingSessionIdsBySlotRef.current.delete(slotIndex);
    setSessionRunning(session.id, true);
    // Keep an optimistic entry with the real id until SessionManager.listAll()
    // can see the file. For brand-new sessions DeerHux delays writing the jsonl
    // until an assistant message is persisted, so clearing this immediately
    // makes the session disappear from the sidebar when switching away mid-run.
    setPendingSession(session);
    if (slotIndex === focusedChatSlotIndex) {
      setNewSessionCwd(null);
      setSelectedSession(session);
    }
    // Replace the placeholder in this slot with the real session. In practice the
    // pending-temp map can miss if focus/layout changed while the first prompt was
    // creating the real DeerHux session, so also treat the current slot id as the
    // placeholder fallback.
    const mappedTempId = pendingTempTabIdsBySlotRef.current.get(slotIndex) ?? null;
    const slotTempId = chatSlotIdsRef.current[slotIndex] ?? null;
    const tempId = mappedTempId ?? (slotTempId && placeholderTabIdsRef.current.has(slotTempId) ? slotTempId : null);
    if (tempId) {
      const placeholderDraft = chatDraftsRef.current.get(slotIndex, tempId);
      const sessionDraft = chatDraftsRef.current.get(slotIndex, session.id);
      const promotedDraft = promoteNewSessionDraft(placeholderDraft, sessionDraft, () => ({
        value: "",
        attachedImages: [],
        selectedSkill: null,
        fileReferences: [],
      }));
      chatDraftsRef.current.clear(slotIndex, tempId);
      if (promotedDraft) chatDraftsRef.current.set(slotIndex, session.id, promotedDraft);
    }
    pendingTempTabIdsBySlotRef.current.delete(slotIndex);
    // The placeholder is now a real session. Preserve the ChatWindow identity
    // so its optimistic user message and live stream survive id promotion.
    if (tempId) placeholderTabIdsRef.current.delete(tempId);
    promoteChatRenderKey(chatRenderKeysRef.current, tempId, session.id);
    setChatSlotIds((prev) => {
      const next = prev.map((id) => (id === session.id || (tempId && id === tempId) ? null : id));
      next[slotIndex] = session.id;
      chatSlotIdsRef.current = next;
      return next;
    });
    setSessionTabs((prev) => {
      const replacementId = tempId;
      const next: SessionInfo[] = [];
      let replaced = false;
      for (const tab of prev) {
        if (tab.id === session.id) continue;
        if (replacementId && tab.id === replacementId) {
          if (!replaced) {
            next.push(session);
            replaced = true;
          }
          continue;
        }
        next.push(tab);
      }
      return replaced ? next : [...next, session];
    });
    setActiveSessionTabId((cur) => (cur === tempId || slotIndex === focusedChatSlotIndex) ? session.id : cur);
    setRefreshKey((k) => k + 1);
    if (slotIndex === focusedChatSlotIndex) {
      replaceUrl(`?session=${encodeURIComponent(session.id)}`);
    }
  }, [focusedChatSlotIndex, replaceUrl, setSessionRunning]);

  const handleSessionForked = useCallback((newSessionId: string, slotIndex = focusedChatSlotIndex, sourceSessionId?: string | null) => {
    const currentSlotId = chatSlotIdsRef.current[slotIndex] ?? null;
    if (sourceSessionId && currentSlotId !== sourceSessionId) return;
    setRefreshKey((k) => k + 1);
    const previousSessionId = currentSlotId;
    const previousSession = previousSessionId ? sessionTabs.find((tab) => tab.id === previousSessionId) ?? null : null;
    const forkedSession: SessionInfo = {
      ...(previousSession ?? selectedSession ?? { path: "", cwd: activeCwd ?? defaultCwd ?? "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    };
    // Fork 是新的独立 session，不是 id 升级。必须让旧 ChatWindow 卸载，
    // 避免原 session 的消息缓存、订阅与异步请求跟进 fork 后的窗口。
    if (previousSessionId) chatRenderKeysRef.current.delete(previousSessionId);
    setChatSlotIds((prev) => {
      const next = prev.map((id) => (id === newSessionId ? null : id));
      next[slotIndex] = newSessionId;
      chatSlotIdsRef.current = next;
      return next;
    });
    setSessionTabs((prev) => {
      const filtered = prev.filter((tab) => tab.id !== newSessionId);
      const previousIndex = previousSessionId ? filtered.findIndex((tab) => tab.id === previousSessionId) : -1;
      if (previousIndex >= 0) {
        const next = [...filtered];
        next[previousIndex] = forkedSession;
        return next;
      }
      return [...filtered, forkedSession];
    });
    setFocusedChatSlotIndex(slotIndex);
    if (slotIndex === focusedChatSlotIndex) {
      setNewSessionCwd(null);
      setSelectedSession(forkedSession);
      setActiveSessionTabId(newSessionId);
      replaceUrl(`?session=${encodeURIComponent(newSessionId)}`);
    }
  }, [activeCwd, chatSlotIds, defaultCwd, focusedChatSlotIndex, replaceUrl, selectedSession, sessionTabs]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  // ── Sidebar resize handlers ──
  const finishSidebarResize = useCallback(() => {
    setIsResizing(false);
    setSidebarWidth((w) => {
      if (typeof window !== "undefined") window.localStorage.setItem("deerhux.sidebar-width", String(w));
      return w;
    });
  }, []);

  const handleResizeStart = useCallback((e: PointerEventType<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: PointerEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, resizeStartWidth.current + delta));
      setSidebarWidth(next);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) finishSidebarResize();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishSidebarResize);
    window.addEventListener("pointercancel", finishSidebarResize);
    window.addEventListener("blur", finishSidebarResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishSidebarResize);
      window.removeEventListener("pointercancel", finishSidebarResize);
      window.removeEventListener("blur", finishSidebarResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [finishSidebarResize, isResizing]);

  // ── Right panel resize handlers ──
  const finishRightPanelResize = useCallback(() => {
    setIsResizingRightPanel(false);
    setRightPanelWidth((w) => {
      if (typeof window !== "undefined") window.localStorage.setItem("deerhux.right-panel-width", String(w));
      return w;
    });
  }, []);

  const handleRightPanelResizeStart = useCallback((e: PointerEventType<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizingRightPanel(true);
    rightPanelResizeStartX.current = e.clientX;
    rightPanelResizeStartWidth.current = rightPanelWidth;
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!isResizingRightPanel) return;
    const handleMove = (e: PointerEvent) => {
      const delta = rightPanelResizeStartX.current - e.clientX;
      const next = Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, rightPanelResizeStartWidth.current + delta));
      setRightPanelWidth(next);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) finishRightPanelResize();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finishRightPanelResize);
    window.addEventListener("pointercancel", finishRightPanelResize);
    window.addEventListener("blur", finishRightPanelResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finishRightPanelResize);
      window.removeEventListener("pointercancel", finishRightPanelResize);
      window.removeEventListener("blur", finishRightPanelResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [finishRightPanelResize, isResizingRightPanel]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    setPendingSession((prev) => (prev?.id === sessionId ? null : prev));
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      replaceUrl("/");
    }
  }, [selectedSession, replaceUrl]);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      if (prev.find((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, label: fileName, filePath }];
    });
    setActiveFileTabId(tabId);
    setRightPanelOpen(filePreviewDetached ? false : true);
  }, [filePreviewDetached]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    if (rightPanelOpen && tabId === activeFileTabId) {
      const tab = fileTabs.find((t) => t.id === tabId);
      if (tab) {
        chatInputRef.current?.toggleReference(getRelativeFilePath(tab.filePath, effectiveProjectCwd ?? undefined));
        return;
      }
    }
    setActiveFileTabId(tabId);
  }, [activeFileTabId, effectiveProjectCwd, fileTabs, rightPanelOpen]);

  const handleAgentEnd = useCallback((sessionId: string, _changedFiles?: string[]) => {
    setSessionRunning(sessionId, false);
    // Keep pendingSession until /api/sessions has actually listed it. The
    // session list is cached and DeerHux may flush the new jsonl slightly after
    // the final event; clearing the optimistic row here makes it disappear.
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, [setSessionRunning]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleCloseFileTabs = useCallback((tabIds: string[]) => {
    const ids = new Set(tabIds);
    if (ids.size === 0) return;

    const nextFileTabs = fileTabs.filter((tab) => !ids.has(tab.id));
    setFileTabs(nextFileTabs);

    setActiveFileTabId((cur) => {
      if (cur && !ids.has(cur)) return cur;
      return nextFileTabs.length > 0 ? nextFileTabs[nextFileTabs.length - 1].id : null;
    });

    if (nextFileTabs.length === 0) setRightPanelOpen(false);
  }, [fileTabs]);

  const currentFilePreviewState = useMemo<FilePreviewState>(() => ({
    tabs: fileTabs,
    activeTabId: activeFileTabId,
    cwd: effectiveProjectCwd,
    viewerCwd: activeCwd,
  }), [activeCwd, activeFileTabId, effectiveProjectCwd, fileTabs]);

  useEffect(() => {
    filePreviewStateRef.current = currentFilePreviewState;
    try {
      window.localStorage.setItem(FILE_PREVIEW_STATE_STORAGE_KEY, JSON.stringify(currentFilePreviewState));
    } catch {
      // ignore quota / private mode errors
    }
    if (filePreviewDetached) {
      filePreviewChannelRef.current?.postMessage({ type: "state", state: currentFilePreviewState } satisfies FilePreviewChannelMessage);
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(FILE_PREVIEW_TAURI_STATE_EVENT, currentFilePreviewState))
        .catch(() => {});
    }
  }, [currentFilePreviewState, filePreviewDetached]);

  const restoreEmbeddedFilePreview = useCallback(() => {
    setFilePreviewDetached(false);
    if (filePreviewStateRef.current.tabs.length > 0) {
      setRightPanelOpen(true);
    }
  }, []);

  const handleReturnFilePreview = useCallback(() => {
    restoreEmbeddedFilePreview();
    filePreviewPopupRef.current?.close();
    filePreviewPopupRef.current = null;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ WebviewWindow }) => WebviewWindow.getByLabel(FILE_PREVIEW_WINDOW_LABEL))
      .then((previewWindow) => previewWindow?.close())
      .catch(() => {});
  }, [restoreEmbeddedFilePreview]);

  const handleFilePreviewMessage = useCallback((message: FilePreviewChannelMessage) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "ready") {
      filePreviewChannelRef.current?.postMessage({ type: "state", state: filePreviewStateRef.current } satisfies FilePreviewChannelMessage);
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(FILE_PREVIEW_TAURI_STATE_EVENT, filePreviewStateRef.current))
        .catch(() => {});
      return;
    }
    if (message.type === "open") {
      handleOpenFile(message.filePath, message.fileName);
      return;
    }
    if (message.type === "select") {
      setActiveFileTabId(message.tabId);
      return;
    }
    if (message.type === "close") {
      setFileTabs((prev) => {
        const next = prev.filter((tab) => tab.id !== message.tabId);
        if (next.length === 0) setRightPanelOpen(false);
        setActiveFileTabId((cur) => {
          if (cur !== message.tabId) return cur;
          return next.length > 0 ? next[next.length - 1].id : null;
        });
        return next;
      });
      return;
    }
    if (message.type === "closeMany") {
      const ids = new Set(message.tabIds);
      setFileTabs((prev) => {
        const next = prev.filter((tab) => !ids.has(tab.id));
        if (next.length === 0) setRightPanelOpen(false);
        setActiveFileTabId((cur) => {
          if (cur && !ids.has(cur)) return cur;
          return next.length > 0 ? next[next.length - 1].id : null;
        });
        return next;
      });
      return;
    }
    if (message.type === "closed") {
      restoreEmbeddedFilePreview();
    }
  }, [handleOpenFile, restoreEmbeddedFilePreview]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(FILE_PREVIEW_CHANNEL_NAME);
    filePreviewChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<FilePreviewChannelMessage>) => {
      handleFilePreviewMessage(event.data);
    };

    return () => {
      channel.close();
      if (filePreviewChannelRef.current === channel) filePreviewChannelRef.current = null;
    };
  }, [handleFilePreviewMessage]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<FilePreviewChannelMessage>(FILE_PREVIEW_TAURI_COMMAND_EVENT, (event) => {
        handleFilePreviewMessage(event.payload);
      }))
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleFilePreviewMessage]);

  const handleDetachFilePreview = useCallback(() => {
    if (fileTabs.length === 0) return;

    const state = filePreviewStateRef.current;
    try {
      window.localStorage.setItem(FILE_PREVIEW_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota / private mode errors
    }

    setFilePreviewDetached(true);
    setRightPanelOpen(false);

    const url = new URL("/file-preview", window.location.href).toString();
    const postStateSoon = () => {
      window.setTimeout(() => {
        filePreviewChannelRef.current?.postMessage({ type: "state", state } satisfies FilePreviewChannelMessage);
        void import("@tauri-apps/api/event")
          .then(({ emit }) => emit(FILE_PREVIEW_TAURI_STATE_EVENT, state))
          .catch(() => {});
      }, 150);
    };

    void import("@tauri-apps/api/webviewWindow")
      .then(({ WebviewWindow }) => {
        const previewWindow = new WebviewWindow(FILE_PREVIEW_WINDOW_LABEL, {
          url,
          title: "文件预览",
          width: 900,
          height: 700,
          minWidth: 520,
          minHeight: 360,
        });
        previewWindow.once("tauri://created", postStateSoon);
        previewWindow.once("tauri://destroyed", restoreEmbeddedFilePreview);
        previewWindow.once("tauri://error", () => {
          const opened = window.open(url, FILE_PREVIEW_WINDOW_LABEL, "width=900,height=700");
          if (!opened) {
            restoreEmbeddedFilePreview();
          } else {
            filePreviewPopupRef.current = opened;
            postStateSoon();
          }
        });
      })
      .catch(() => {
        const opened = window.open(url, FILE_PREVIEW_WINDOW_LABEL, "width=900,height=700");
        if (!opened) {
          restoreEmbeddedFilePreview();
        } else {
          filePreviewPopupRef.current = opened;
          postStateSoon();
        }
      });
  }, [fileTabs.length, restoreEmbeddedFilePreview]);

  const hasVisibleChatSlots = visibleChatSlotIds.some((id) => id !== null);
  // Show chat area only when a session tab is assigned to a visible chat slot.
  const hasSessionTabs = sessionTabs.length > 0;
  const showChat = hasSessionTabs && hasVisibleChatSlots;
  const topActionBarAutoCollapse = occupiedChatSlotCount > 1;
  const topActionBarExpanded = !topActionBarAutoCollapse || topActionBarHovered || settingsMenuOpen;

  const clearTopActionBarHoverTimer = useCallback(() => {
    if (topActionBarHoverTimerRef.current) {
      clearTimeout(topActionBarHoverTimerRef.current);
      topActionBarHoverTimerRef.current = null;
    }
  }, []);

  const scheduleTopActionBarHover = useCallback((hovered: boolean) => {
    clearTopActionBarHoverTimer();
    if (!topActionBarAutoCollapse) {
      setTopActionBarHovered(false);
      return;
    }
    if (hovered) {
      setTopActionBarHovered(true);
    } else {
      topActionBarHoverTimerRef.current = setTimeout(() => {
        setTopActionBarHovered(false);
        topActionBarHoverTimerRef.current = null;
      }, 500);
    }
  }, [clearTopActionBarHoverTimer, topActionBarAutoCollapse]);

  useEffect(() => {
    if (!topActionBarAutoCollapse) setTopActionBarHovered(false);
    return clearTopActionBarHoverTimer;
  }, [clearTopActionBarHoverTimer, topActionBarAutoCollapse]);

  // Show watermark only when absolutely nothing is open (no tabs, no session, no new-session cwd)
  const showWatermark = !showChat && !hasSessionTabs;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat && hasSessionTabs;

  const headerProjectOptions = useMemo(() => {
    const byCwd = new Map<string, string>();
    for (const project of projectOptions) byCwd.set(project.cwd, project.displayName);
    for (const cwd of customCwds) if (!byCwd.has(cwd)) byCwd.set(cwd, getProjectDisplayName(cwd));
    if (defaultCwd && !byCwd.has(defaultCwd)) byCwd.set(defaultCwd, "默认");
    if (effectiveProjectCwd && !byCwd.has(effectiveProjectCwd)) byCwd.set(effectiveProjectCwd, getProjectDisplayName(effectiveProjectCwd));
    return [...byCwd.entries()].map(([cwd, displayName]) => ({ cwd, displayName }));
  }, [customCwds, defaultCwd, effectiveProjectCwd, projectOptions]);

  const lastTitlebarPointerDownRef = useRef<{ time: number; x: number; y: number } | null>(null);

  const handleWindowDragPointerDown = useCallback((event: PointerEventType<HTMLDivElement>) => {
    if (!shouldStartWindowDrag(event)) return;
    if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;

    const now = Date.now();
    const prev = lastTitlebarPointerDownRef.current;
    const DOUBLE_CLICK_THRESHOLD_MS = 400;
    const DOUBLE_CLICK_DISTANCE = 10;

    const isDoubleClick =
      prev !== null &&
      now - prev.time < DOUBLE_CLICK_THRESHOLD_MS &&
      Math.abs(event.clientX - prev.x) < DOUBLE_CLICK_DISTANCE &&
      Math.abs(event.clientY - prev.y) < DOUBLE_CLICK_DISTANCE;

    lastTitlebarPointerDownRef.current = { time: now, x: event.clientX, y: event.clientY };

    if (isDoubleClick) {
      // 双击顶栏区域 → 切换窗口最大化/还原
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
        .catch(() => {
          // Browser/dev fallback: ignore.
        });
      return;
    }

    // 不使用覆盖层抢事件，而是在空白顶栏区域按下时主动通知 Tauri 开始拖动。
    // 这样顶栏里的按钮、输入框、标签页、右键菜单、resize handle 等元素仍然保留原生左右键/拖拽事件。
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {
        // Browser/dev fallback: ignore.
      });
  }, []);

  const sidebarContent = (
    <div
      style={{
        width: "100%",
        minWidth: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        overflow: "hidden",
      }}
    >
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        optimisticSessions={sidebarOptimisticSessions}
        onOptimisticSessionResolved={(sessionId) => {
          setPendingSession((prev) => (prev?.id === sessionId ? null : prev));
        }}
        runningSessionStatuses={runningSessionStatuses}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
        onProjectsChange={handleProjectsChange}
        onRefreshRunningSessions={loadRunningSessions}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        {([
          {
            label: "模型配置",
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            label: "记忆",
            onClick: () => setQuickConfigOpen("memory"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 1 4 17.5z" />
                <path d="M8 8h8" />
                <path d="M8 12h6" />
                <path d="M8 16h7" />
              </svg>
            ),
          },
          {
            label: "MCP",
            onClick: () => setQuickConfigOpen("mcp"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
                <path d="M10 6.5h4" />
                <path d="M17.5 10v2a2 2 0 0 1-2 2H12" />
                <path d="M6.5 10v2a2 2 0 0 0 2 2H12" />
              </svg>
            ),
          },
          {
            label: "角色",
            onClick: () => setQuickConfigOpen("role"),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            ),
          },
          {
            label: "技能配置",
            onClick: () => setSkillsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            label: "定时任务",
            onClick: () => setSchedulerPanelOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: ReactNode }[]).map(({ label, onClick, disabled, icon }, index) => (
          <button
            key={`${label}-${index}`}
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            style={{
              flex: 1,
              height: 32,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: 0,
              background: "none",
              border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
    {chatWindowLimitNotice && (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          top: 14,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1200,
          padding: "9px 14px",
          borderRadius: 999,
          background: "var(--bg-panel)",
          border: "1px solid color-mix(in srgb, var(--accent) 42%, var(--border))",
          color: "var(--text)",
          boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
          fontSize: 13,
          fontWeight: 650,
          pointerEvents: "none",
        }}
      >
        {chatWindowLimitNotice}
      </div>
    )}
    {needsWindowControls && <WindowControls />}
    <button
      data-tauri-drag-region="false"
      onClick={() => setSidebarMode((mode) => mode === "open" ? "closed" : "open")}
      title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      aria-pressed={sidebarOpen}
      style={{
        position: "fixed",
        left: 76,
        top: -1,
        zIndex: 700,
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {sidebarOpen ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      )}
    </button>
    <div
      onPointerDownCapture={handleWindowDragPointerDown}
      style={{ display: "flex", height: "100dvh", overflow: "hidden", background: "var(--bg)" }}
    >
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: 0,
          pointerEvents: "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}
        style={{
          width: sidebarOpen ? sidebarWidth : 0,
          minWidth: sidebarOpen ? SIDEBAR_MIN : 0,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          transition: isResizing ? "none" : undefined,
        }}
      >
        {sidebarContent}
      </div>

      {/* Resize handle */}
      {sidebarMode === "open" && (
        <div
          data-no-window-drag
          onPointerDown={handleResizeStart}
          style={{
            width: 5,
            cursor: "col-resize",
            touchAction: "none",
            flexShrink: 0,
            background: isResizing ? "var(--accent)" : "transparent",
            transition: isResizing ? "none" : "background 0.15s",
            zIndex: 201,
            marginLeft: -2,
            marginRight: -2,
          }}
          onMouseEnter={(e) => { if (!isResizing) e.currentTarget.style.background = "var(--border)"; }}
          onMouseLeave={(e) => { if (!isResizing) e.currentTarget.style.background = "transparent"; }}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Top-right action buttons */}
          <div
            data-tauri-drag-region="false"
            onClick={(event) => event.stopPropagation()}
            onMouseEnter={() => scheduleTopActionBarHover(true)}
            onMouseLeave={() => scheduleTopActionBarHover(false)}
            style={{
              position: "absolute",
              top: topActionBarAutoCollapse ? 42 : 8,
              right: 8,
              zIndex: 60,
              display: "flex",
              alignItems: "center",
              gap: 2,
              background: "color-mix(in srgb, var(--bg-panel) 85%, transparent)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              borderRadius: 10,
              border: "1px solid var(--border)",
              padding: 2,
              boxShadow: topActionBarAutoCollapse && !topActionBarExpanded ? "0 8px 22px rgba(0,0,0,0.12)" : "none",
              transform: topActionBarAutoCollapse && !topActionBarExpanded ? "translateX(calc(100% - 30px))" : "translateX(0)",
              transition: "transform 0.18s ease, box-shadow 0.18s ease",
            }}
          >
            {topActionBarAutoCollapse && (
              <div
                aria-hidden="true"
                style={{
                  width: 26,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  flexShrink: 0,
                  pointerEvents: "none",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: topActionBarExpanded ? "rotate(180deg)" : "none", transition: "transform 0.18s ease" }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            )}
            {([
              {
                label: topNewSessionCwd ? `在 ${topNewSessionCwd} 中新建会话` : "新建会话",
                onClick: handleTopNewSession,
                disabled: !canCreateTopSession,
                active: false,
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                ),
              },
              {
                label: "设置",
                onClick: (event: MouseEventType<HTMLButtonElement>) => {
                  event.stopPropagation();
                  setSettingsMenuOpen((v) => !v);
                },
                disabled: false,
                active: settingsMenuOpen,
                icon: (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                ),
              },
              {
                label: isDark ? "切换为浅色模式" : "切换为深色模式",
                onClick: (event: MouseEventType<HTMLButtonElement>) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                },
                disabled: false,
                active: isDark,
                icon: isDark ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                ),
              },
              {
                label: filePreviewDetached ? "收回文件面板" : rightPanelOpen ? "隐藏文件面板" : "显示文件面板",
                onClick: filePreviewDetached ? handleReturnFilePreview : () => setRightPanelOpen((v) => !v),
                disabled: false,
                active: rightPanelOpen || filePreviewDetached,
                icon: filePreviewDetached ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /><path d="M10 8 6 12l4 4" /><path d="M6 12h7" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
                  </svg>
                ),
              },
            ] as { label: string; onClick: (event: MouseEventType<HTMLButtonElement>) => void; disabled: boolean; active: boolean; icon: ReactNode }[]).map(({ label, onClick, disabled, active, icon }, index) => (
              <button
                key={`chat-action-${index}`}
                onClick={onClick}
                disabled={disabled}
                title={label}
                aria-label={label}
                aria-pressed={active}
                style={{
                  width: 30,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  background: active ? "var(--bg-selected)" : "transparent",
                  border: "none",
                  borderRadius: 8,
                  color: active ? "var(--text)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                  cursor: disabled ? "default" : "pointer",
                  opacity: disabled ? 0.35 : 1,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                onMouseLeave={(e) => { e.currentTarget.style.background = active ? "var(--bg-selected)" : "transparent"; e.currentTarget.style.color = active ? "var(--text)" : disabled ? "var(--text-dim)" : "var(--text-muted)"; }}
              >
                {icon}
              </button>
            ))}
          </div>
          {/* Settings dropdown for chat area */}
          {settingsMenuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: 46,
                right: 8,
                width: 180,
                padding: 6,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
                zIndex: 100,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {([
                { label: "扩展总览", disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd, onClick: () => { setSettingsMenuOpen(false); setExtensionsConfigOpen(true); } },
                { label: "微信 Bot", disabled: false, onClick: () => { setSettingsMenuOpen(false); setWechatConfigOpen(true); } },
              ] as { label: string; disabled?: boolean; onClick: () => void }[]).map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  onClick={item.onClick}
                  disabled={item.disabled}
                  style={{
                    width: "100%",
                    padding: "8px 9px",
                    border: "none",
                    borderRadius: 8,
                    background: "transparent",
                    color: item.disabled ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: item.disabled ? "default" : "pointer",
                    textAlign: "left",
                    fontSize: 12,
                    opacity: item.disabled ? 0.4 : 1,
                  }}
                  onMouseEnter={(e) => { if (!item.disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = item.disabled ? "var(--text-dim)" : "var(--text-muted)"; }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {/* Watermark when no session tabs */}
          {!hasSessionTabs && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 64,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  maxWidth: "96%",
                  boxSizing: "border-box",
                  color: "var(--text)",
                  opacity: isDark ? 0.035 : 0.045,
                  fontSize: "clamp(48px, 10vw, 160px)",
                  fontWeight: 900,
                  letterSpacing: "-0.05em",
                  lineHeight: 1.15,
                  padding: "0.12em 0.08em",
                  textAlign: "center",
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  userSelect: "none",
                }}
              >
                DeerHux
              </div>
            </div>
          )}
          {!hasSessionTabs && initialSessionRestored && (
            <div
              aria-label="快速新建会话"
              style={{
                position: "absolute",
                left: "50%",
                bottom: 112,
                transform: "translateX(-50%)",
                zIndex: 2,
                width: "min(560px, calc(100% - 96px))",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                textAlign: "center",
              }}
            >
              <button
                onClick={handleTopNewSession}
                disabled={!canCreateTopSession}
                title={topNewSessionCwd ? `在 ${topNewSessionCwd} 新建会话` : "请先在左侧选择项目目录"}
                style={{
                  minHeight: 58,
                  minWidth: 300,
                  maxWidth: "100%",
                  padding: "8px 12px 8px 10px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 11,
                  borderRadius: 18,
                  border: canCreateTopSession
                    ? "1px solid color-mix(in srgb, var(--text) 18%, var(--border))"
                    : "1px solid var(--border)",
                  background: canCreateTopSession
                    ? isDark
                      ? "linear-gradient(135deg, color-mix(in srgb, var(--text) 7%, var(--bg-panel)), var(--bg-panel) 62%, color-mix(in srgb, #fff 3%, var(--bg)))"
                      : "linear-gradient(135deg, #ffffff, var(--bg-panel) 62%, color-mix(in srgb, var(--text) 3%, var(--bg)))"
                    : "var(--bg-panel)",
                  color: canCreateTopSession ? "var(--text)" : "var(--text-dim)",
                  boxShadow: canCreateTopSession
                    ? isDark
                      ? "0 18px 42px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)"
                      : "0 18px 42px rgba(15,23,42,0.10), inset 0 1px 0 rgba(255,255,255,0.7)"
                    : "inset 0 1px 0 rgba(255,255,255,0.08)",
                  cursor: canCreateTopSession ? "pointer" : "not-allowed",
                  fontSize: 14,
                  fontFamily: "inherit",
                  textAlign: "left",
                  userSelect: "none",
                  transition: "transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease",
                }}
                onMouseEnter={(e) => {
                  if (!canCreateTopSession) return;
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--text) 28%, var(--border))";
                  e.currentTarget.style.boxShadow = isDark
                    ? "0 24px 56px rgba(0,0,0,0.34), 0 0 0 4px color-mix(in srgb, #fff 7%, transparent), inset 0 1px 0 rgba(255,255,255,0.08)"
                    : "0 24px 56px rgba(15,23,42,0.14), 0 0 0 4px rgba(0,0,0,0.045), inset 0 1px 0 rgba(255,255,255,0.78)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.borderColor = canCreateTopSession
                    ? "color-mix(in srgb, var(--text) 18%, var(--border))"
                    : "var(--border)";
                  e.currentTarget.style.boxShadow = canCreateTopSession
                    ? isDark
                      ? "0 18px 42px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.06)"
                      : "0 18px 42px rgba(15,23,42,0.10), inset 0 1px 0 rgba(255,255,255,0.7)"
                    : "inset 0 1px 0 rgba(255,255,255,0.08)";
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 14,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: canCreateTopSession ? (isDark ? "#111" : "#fff") : "var(--text-dim)",
                    background: canCreateTopSession
                      ? isDark
                        ? "linear-gradient(135deg, #f3f4f6, #c7c7c7)"
                        : "linear-gradient(135deg, #111827, #3f3f46)"
                      : "var(--bg-hover)",
                    boxShadow: canCreateTopSession
                      ? isDark
                        ? "0 10px 24px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.45)"
                        : "0 10px 24px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.18)"
                      : "none",
                  }}
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </span>
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
                  <span style={{ fontSize: 15, lineHeight: 1.15, fontWeight: 750, letterSpacing: "-0.01em" }}>新建会话</span>
                  <span
                    style={{
                      maxWidth: 210,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12,
                      lineHeight: 1.2,
                      color: "var(--text-muted)",
                    }}
                  >
                    {topNewSessionCwd ? `在 ${getProjectDisplayName(topNewSessionCwd)} 中开始` : "请先选择项目目录"}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    color: canCreateTopSession ? "var(--text-muted)" : "var(--text-dim)",
                    background: "var(--bg-hover)",
                    opacity: canCreateTopSession ? 1 : 0.55,
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" />
                    <path d="m13 6 6 6-6 6" />
                  </svg>
                </span>
              </button>
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  color: "var(--text-dim)",
                  background: "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {canCreateTopSession ? "也可以从左侧新建会话，布局会自动适配" : "从左侧选择项目后，这里会变成快速入口"}
              </div>
            </div>
          )}
          {showChat ? (
            <>
              <ChatWorkspace
                layoutMode={chatLayoutMode}
                slotIds={chatSlotIds}
                sessions={sessionTabs}
                focusedSlotIndex={focusedChatSlotIndex}
                isPlaceholderSession={isPlaceholderSession}
                runningSessionIds={new Set(runningSessionStatuses.keys())}
                onFocusSlot={handleFocusChatSlot}
                onClearSlot={handleClearChatSlot}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionStarted={handleSessionStarted}
                onAgentRunningChange={setSessionRunning}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onOpenFile={handleOpenFile}
                onAtMention={handleAtMention}
                explorerRefreshKey={explorerRefreshKey}
                onOpenRoleConfig={() => setQuickConfigOpen("role")}
                projectOptions={headerProjectOptions}
                onNewSessionCwdChange={handleNewSessionProjectChange}
                onOpenSession={handleOpenSessionById}
                getSessionRenderKey={getSessionRenderKey}
                getInputState={getChatDraft}
                saveInputState={saveChatDraft}
              />
            </>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                从侧边栏中选择一个会话
              </div>
            ) : (
              <div style={{ position: "absolute", top: 64, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>开始使用</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>从侧边栏选择项目目录<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>点击底部的 “模型配置” 图标配置模型
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* Right panel resize handle */}
      {rightPanelOpen && !filePreviewDetached && (
        <div
          data-no-window-drag
          onPointerDown={handleRightPanelResizeStart}
          style={{
            width: 5,
            cursor: "col-resize",
            touchAction: "none",
            flexShrink: 0,
            background: isResizingRightPanel ? "var(--accent)" : "transparent",
            transition: isResizingRightPanel ? "none" : "background 0.15s",
            zIndex: 201,
            marginLeft: -2,
            marginRight: -2,
          }}
          onMouseEnter={(e) => { if (!isResizingRightPanel) e.currentTarget.style.background = "var(--border)"; }}
          onMouseLeave={(e) => { if (!isResizingRightPanel) e.currentTarget.style.background = "transparent"; }}
        />
      )}

      {/* Right panel: file viewer — width via inline style, CSS class for mobile */}
      <div
        className={`right-panel-container${rightPanelOpen && !filePreviewDetached ? " right-panel-open" : " right-panel-closed"}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          width: rightPanelOpen && !filePreviewDetached ? rightPanelWidth : 0,
          minWidth: rightPanelOpen && !filePreviewDetached ? RIGHT_PANEL_MIN : 0,
          transition: isResizingRightPanel ? "none" : undefined,
        }}
      >
        <FilePreviewPanel
          tabs={fileTabs}
          activeTabId={activeFileTabId}
          cwd={effectiveProjectCwd}
          viewerCwd={activeCwd}
          onSelectTab={handleSelectFileTab}
          onCloseTab={handleCloseFileTab}
          onCloseTabs={handleCloseFileTabs}
          onOpenFile={handleOpenFile}
          onDetach={handleDetachFilePreview}
        />
      </div>
    </div>
    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} onSaved={() => setModelsRefreshKey((k) => k + 1)} />}
    {skillsConfigOpen && (
      <SkillsConfig projects={headerProjectOptions} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {extensionsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <ExtensionsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setExtensionsConfigOpen(false)} />
    )}
    {schedulerPanelOpen && (
      <SchedulerPanel onClose={() => setSchedulerPanelOpen(false)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />
    )}
    {quickConfigOpen === "role" && <RoleConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} projects={projectOptions} />}
    {quickConfigOpen === "memory" && <MemoryConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />}
    {quickConfigOpen === "mcp" && <McpConfig onClose={() => setQuickConfigOpen(null)} cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? undefined} />}
    {wechatConfigOpen && <WeChatConfig onClose={() => setWechatConfigOpen(false)} />}
    </>
  );
}
