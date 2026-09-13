"use client";

import { ProjectPicker } from "./ProjectPicker";

import { AppIcon } from "./AppIcon";
import FallingText from "./FallingText";

import { getExplorerRevealTarget } from "@/lib/file-paths";
import { AiLinkWorkspace } from "./AiOutputLink";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { PointerEvent as PointerEventType, MouseEvent as MouseEventType, ReactNode } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { ShareManager } from "./ShareManager";
import { SessionSidebar } from "./SessionSidebar";
import { CHAT_LAYOUT_COUNTS, ChatWorkspace, type ChatLayoutMode } from "./ChatWorkspace";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { WorkspaceExplorer } from "./WorkspaceExplorer";
import "./workspace-panel.css";
import "./workbench.css";
import "./tool-buttons.css";
import { WindowControls, useNeedsWindowControls } from "./WindowControls";
import type { Tab } from "./TabBar";
import { getLocalStorageItem } from "@/lib/client-storage";
import {
  normalizeExternalHref,
  openExternalLink,
  openLocalFileLink,
  resolveLocalFileHref,
} from "@/lib/external-links";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
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
import { restoreQuickSessionVisibility } from "@/lib/quick-session-visibility";
import { subscribeToAppNotification } from "@/lib/app-notifications";

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
          borderRadius: "var(--radius-panel)",
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
  const [explorerReveal, setExplorerReveal] = useState<{ id: number; path: string; root: string; sourceCwd: string } | null>(null);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);

  useEffect(() => subscribeToAppNotification("deerhux.project-files-updated", () => {
    setExplorerRefreshKey((key) => key + 1);
  }), []);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [extensionsConfigOpen, setExtensionsConfigOpen] = useState(false);
  const [quickConfigOpen, setQuickConfigOpen] = useState<"memory" | "mcp" | "role" | null>(null);
  const [schedulerPanelOpen, setSchedulerPanelOpen] = useState(false);
  const [wechatConfigOpen, setWechatConfigOpen] = useState(false);
  const [shareManagerOpen, setShareManagerOpen] = useState(false);
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

  // Right workspace: remember explorer and preview widths separately.
  const RIGHT_PANEL_MIN = 250;
  const EXPLORER_PANEL_MIN = 200;
  const RIGHT_PANEL_MAX = 1000;
  const [rightPanelView, setRightPanelView] = useState<"explorer" | "preview">("explorer");
  const rightPanelMinWidth = rightPanelView === "explorer" ? EXPLORER_PANEL_MIN : RIGHT_PANEL_MIN;
  const [explorerPanelWidth, setExplorerPanelWidth] = useState(320);
  const [previewPanelWidth, setPreviewPanelWidth] = useState(500);
  const rightPanelWidth = rightPanelView === "explorer" ? explorerPanelWidth : previewPanelWidth;
  const setRightPanelWidth = rightPanelView === "explorer" ? setExplorerPanelWidth : setPreviewPanelWidth;
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

  // Right workspace and preview tabs
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelPinned, setRightPanelPinned] = useState(false);
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
  const [idleProjectCwd, setIdleProjectCwd] = useState<string | null>(null);
  const [customCwds, setCustomCwds] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<{ cwd: string; displayName: string }[]>([]);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [headerHovered, setHeaderHovered] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(false);
  const headerVisible = sidebarOpen || headerHovered || headerFocused || settingsMenuOpen;
  useEffect(() => {
    // macOS uses the same native hit test for both traffic lights and toolbar.
    if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ && navigator.platform.toUpperCase().includes("MAC")) return;
    const move = (event: MouseEvent) => setHeaderHovered(event.clientX >= 0 && event.clientX <= 246 && event.clientY >= 0 && event.clientY <= 48);
    const leave = () => setHeaderHovered(false);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", leave);
    return () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseleave", leave); };
  }, []);
  useEffect(() => {
    if (!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || !navigator.platform.toUpperCase().includes("MAC")) return;
    let cancelled = false;
    let syncErrorReported = false;
    let timer: ReturnType<typeof setTimeout>;
    const sync = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const hovered = await invoke<boolean>("sync_header_controls", { keepVisible: sidebarOpen || settingsMenuOpen || headerFocused });
        if (!cancelled) setHeaderHovered(hovered);
        syncErrorReported = false;
      } catch (error) {
        if (!cancelled && !syncErrorReported) {
          console.error("Failed to synchronize native header controls", error);
          syncErrorReported = true;
        }
      }
      if (!cancelled) timer = setTimeout(sync, 100);
    };
    void sync();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sidebarOpen, settingsMenuOpen, headerFocused]);
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
      if (Number.isFinite(parsed)) setPreviewPanelWidth(Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, parsed)));
    }
    const storedExplorerWidth = Number(getLocalStorageItem("deerhux.explorer-panel-width"));
    if (Number.isFinite(storedExplorerWidth) && storedExplorerWidth >= EXPLORER_PANEL_MIN) {
      setExplorerPanelWidth(Math.min(RIGHT_PANEL_MAX, storedExplorerWidth));
    }
    setRightPanelPinned(getLocalStorageItem("deerhux.right-panel-pinned") === "true");
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
  const focusedExplorerCwd = chatLayoutMode !== "single" && !chatSlotIds[focusedChatSlotIndex]
    ? null
    : effectiveProjectCwd;
  const currentExplorerReveal = explorerReveal?.sourceCwd === focusedExplorerCwd ? explorerReveal : null;
  const explorerCwd = currentExplorerReveal?.root ?? focusedExplorerCwd;
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

  const topNewSessionCwd = sessionTabs.length === 0
    ? idleProjectCwd ?? defaultCwd
    : effectiveProjectCwd ?? projectOptions[0]?.cwd ?? defaultCwd;
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
    if (session?.path) restoreQuickSessionVisibility(session.id);
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
  const handleSessionCreated = useCallback((session: SessionInfo, slotIndex = focusedChatSlotIndex, sourceSessionId?: string | null, running = true) => {
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
    // 微信接入只创建空会话；只有已提交 prompt 的创建才进入运行态。
    setSessionRunning(session.id, running);
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
      if (typeof window !== "undefined") window.localStorage.setItem(rightPanelView === "explorer" ? "deerhux.explorer-panel-width" : "deerhux.right-panel-width", String(w));
      return w;
    });
  }, [rightPanelView, setRightPanelWidth]);

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
      const next = Math.min(RIGHT_PANEL_MAX, Math.max(rightPanelMinWidth, rightPanelResizeStartWidth.current + delta));
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
  }, [finishRightPanelResize, isResizingRightPanel, rightPanelMinWidth, setRightPanelWidth]);

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
    if (!filePreviewDetached && !rightPanelPinned) {
      setRightPanelView("preview");
      setRightPanelOpen(true);
    }
  }, [filePreviewDetached, rightPanelPinned]);

  const handleOpenWebLink = useCallback((url: string, label?: string) => {
    const tabId = `web:${url}`;
    let fallbackLabel = url;
    try {
      fallbackLabel = new URL(url).hostname;
    } catch {
      // normalizeExternalHref has already validated the URL.
    }
    setFileTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev;
      return [...prev, {
        id: tabId,
        label: label?.trim() || fallbackLabel,
        filePath: url,
        kind: "web",
      }];
    });
    setActiveFileTabId(tabId);
    if (!filePreviewDetached && !rightPanelPinned) {
      setRightPanelView("preview");
      setRightPanelOpen(true);
    }
  }, [filePreviewDetached, rightPanelPinned]);

  useEffect(() => {
    const handleAiOutputLinkClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        (event.button !== 0 && event.button !== 1) ||
        !(event.target instanceof Element)
      ) return;

      const anchor = event.target.closest("[data-ai-output] a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const href = anchor.getAttribute("href");
      if (!href) { event.preventDefault(); return; }

      const filePath = anchor.dataset.localFilePath ?? resolveLocalFileHref(href, effectiveProjectCwd);
      if (filePath) {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
          void openLocalFileLink(filePath).then((opened) => {
            if (!opened) window.alert("无法使用系统默认应用打开此文件，请检查文件是否存在及访问权限。");
          });
        } else {
          handleOpenFile(filePath, getFileName(filePath));
        }
        return;
      }

      const externalUrl = normalizeExternalHref(href);
      if (!externalUrl) { event.preventDefault(); return; }

      event.preventDefault();
      const windowsDesktop = Boolean(window.__TAURI_INTERNALS__) && /WIN/i.test(navigator.platform);
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1 || windowsDesktop || !/^https?:/i.test(externalUrl)) {
        void openExternalLink(externalUrl).then((opened) => {
          if (!opened) window.alert("无法打开外部链接，请复制链接到浏览器中打开。");
        });
      } else {
        handleOpenWebLink(externalUrl, anchor.textContent ?? undefined);
      }
    };

    document.addEventListener("click", handleAiOutputLinkClick, true);
    document.addEventListener("auxclick", handleAiOutputLinkClick, true);
    return () => {
      document.removeEventListener("click", handleAiOutputLinkClick, true);
      document.removeEventListener("auxclick", handleAiOutputLinkClick, true);
    };
  }, [effectiveProjectCwd, handleOpenFile, handleOpenWebLink]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    if (rightPanelOpen && tabId === activeFileTabId) {
      const tab = fileTabs.find((t) => t.id === tabId);
      if (tab && tab.kind !== "web") {
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
      if (next.length === 0) setRightPanelView("explorer");
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

    if (nextFileTabs.length === 0) setRightPanelView("explorer");
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
    setRightPanelView("preview");
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
        if (next.length === 0) setRightPanelView("explorer");
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
        if (next.length === 0) setRightPanelView("explorer");
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
    setRightPanelView("explorer");

    const url = new URL("/file-preview", window.location.href).toString();
    const postStateSoon = () => {
      window.setTimeout(() => {
        filePreviewChannelRef.current?.postMessage({ type: "state", state } satisfies FilePreviewChannelMessage);
        void import("@tauri-apps/api/event")
          .then(({ emit }) => emit(FILE_PREVIEW_TAURI_STATE_EVENT, state))
          .catch(() => {});
      }, 150);
    };

    const openBrowserPreview = () => {
      const opened = window.open(url, FILE_PREVIEW_WINDOW_LABEL, "width=900,height=700");
      if (!opened) {
        restoreEmbeddedFilePreview();
      } else {
        filePreviewPopupRef.current = opened;
        postStateSoon();
      }
    };
    if (!window.__TAURI_INTERNALS__) {
      openBrowserPreview();
      return;
    }

    void import("@tauri-apps/api/webviewWindow")
      .then(async ({ WebviewWindow }) => {
        const previewWindow = new WebviewWindow(FILE_PREVIEW_WINDOW_LABEL, {
          url,
          title: "文件预览",
          width: 900,
          height: 700,
          minWidth: 520,
          minHeight: 360,
        });
        await Promise.all([
          previewWindow.once("tauri://created", postStateSoon),
          previewWindow.once("tauri://destroyed", restoreEmbeddedFilePreview),
          previewWindow.once("tauri://error", openBrowserPreview),
        ]);
      })
      .catch(openBrowserPreview);
  }, [fileTabs.length, restoreEmbeddedFilePreview]);

  const hasVisibleChatSlots = visibleChatSlotIds.some((id) => id !== null);
  // Show chat area only when a session tab is assigned to a visible chat slot.
  const hasSessionTabs = sessionTabs.length > 0;
  const showChat = hasSessionTabs && hasVisibleChatSlots;
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
        explorerRefreshKey={explorerRefreshKey}
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
              <AppIcon name="model" size="compact" />
            ),
          },
          {
            label: "记忆",
            onClick: () => setQuickConfigOpen("memory"),
            disabled: false,
            icon: (
              <AppIcon name="memory" size="compact" />
            ),
          },
          {
            label: "MCP",
            onClick: () => setQuickConfigOpen("mcp"),
            disabled: false,
            icon: (
              <AppIcon name="mcp" size="compact" />
            ),
          },
          {
            label: "角色",
            onClick: () => setQuickConfigOpen("role"),
            disabled: false,
            icon: (
              <AppIcon name="role" size="compact" />
            ),
          },
          {
            label: "技能配置",
            onClick: () => setSkillsConfigOpen(true),
            disabled: false,
            icon: (
              <AppIcon name="skills" size="compact" />
            ),
          },
          {
            label: "定时任务",
            onClick: () => setSchedulerPanelOpen(true),
            disabled: false,
            icon: (
              <AppIcon name="schedule" size="compact" />
            ),
          },
        ] as { label: string; onClick: () => void; disabled: boolean; icon: ReactNode }[]).map(({ label, onClick, disabled, icon }, index) => (
          <button
            key={`${label}-${index}`}
            className="app-tool-button"
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
              borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
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
    <AiLinkWorkspace.Provider value={effectiveProjectCwd ?? null}>
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
          borderRadius: "var(--radius-control)",
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
    <div className="app-header-reveal" data-visible={headerVisible} onFocusCapture={(event) => setHeaderFocused(event.target.matches(":focus-visible"))} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHeaderFocused(false); }}>
    {needsWindowControls && <WindowControls />}
    <div
      className="app-header-actions"
      style={needsWindowControls ? { left: 76, top: 6 } : undefined}
      data-tauri-drag-region="false"
      role="group"
      aria-label="应用工具栏"
      onClick={(event) => event.stopPropagation()}
    >
    <button
      data-tauri-drag-region="false"
      onClick={() => setSidebarMode((mode) => mode === "open" ? "closed" : "open")}
      title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
      aria-pressed={sidebarOpen}
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: "var(--radius-control)",
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
      <AppIcon name="panel-left" size="toolbar" />
    </button>
            {([
              {
                label: topNewSessionCwd ? `在 ${topNewSessionCwd} 中新建会话` : "新建会话",
                onClick: handleTopNewSession,
                disabled: !canCreateTopSession,
                active: false,
                icon: (
                  <AppIcon name="add" size="toolbar" />
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
                  <AppIcon name="settings" size="toolbar" />
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
                  <AppIcon name="theme-light" size="toolbar" />
                ) : (
                  <AppIcon name="theme-dark" size="toolbar" />
                ),
              },
              {
                label: rightPanelOpen ? "隐藏右侧扩展栏" : "显示资源管理器与预览",
                onClick: () => setRightPanelOpen((v) => !v),
                disabled: false,
                active: rightPanelOpen,
                icon: (
                  <AppIcon name="panel-right" size="toolbar" />
                ),
              },
            ] as { label: string; onClick: (event: MouseEventType<HTMLButtonElement>) => void; disabled: boolean; active: boolean; icon: ReactNode }[]).map(({ label, onClick, disabled, active, icon }, index) => (
              <button
                key={`header-action-${index}`}
                type="button"
                onClick={onClick}
                disabled={disabled}
                title={label}
                aria-label={label}
                aria-pressed={active}
                style={{
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  background: active ? "var(--bg-selected)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-control)",
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
    </div>
          {settingsMenuOpen && (
            <div
              role="menu"
              style={{
                position: "fixed",
                top: 39,
                left: `min(${needsWindowControls ? 136 : 142}px, calc(100vw - 248px))`,
                width: 240,
                padding: 6,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-panel)",
                boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
                zIndex: 710,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {([
                { label: "分享窗口", disabled: false, onClick: () => { setSettingsMenuOpen(false); setShareManagerOpen(true); } },
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
                    borderRadius: "var(--radius-control)",
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

    <div
      onPointerDownCapture={handleWindowDragPointerDown}
      className="deer-workbench"
      style={{ display: "flex", height: "100dvh", overflow: "hidden" }}
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
          background: "transparent",
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

      <div className="workbench-content-layout">
      {/* Center: chat */}
      <div className={`workbench-main${!hasSessionTabs ? " workbench-idle-surface" : ""}`} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {!hasSessionTabs && initialSessionRestored && topNewSessionCwd && (
            <div className="workbench-idle-project">
              <ProjectPicker
                currentCwd={topNewSessionCwd}
                projectOptions={[
                  ...(defaultCwd ? [{ cwd: defaultCwd, displayName: "默认" }] : []),
                  ...headerProjectOptions.filter((project) => project.cwd !== defaultCwd),
                ]}
                onSelect={setIdleProjectCwd}
              />
            </div>
          )}
          {!hasSessionTabs && initialSessionRestored && (
            <div
              className="workbench-empty"
              aria-label="快速新建会话"
            >
              <h1 className="workbench-empty-brand workbench-falling-brand">
                <FallingText
                  text="DeerHux deerhux DEERHUX Deerhux DEERhux deerHUX dEERhUX DEERHux"
                  ariaLabel="DeerHux"
                  className="workbench-falling-words"
                  trigger="hover"
                  backgroundColor="transparent"
                  wireframes={false}
                  gravity={0.56}
                  fontSize="16px"
                  mouseConstraintStiffness={0.9}
                  wordSpacing="4px"
                  bounceOnClick
                  bounceRadius={130}
                />
              </h1>
              <button
                className="workbench-create"
                onClick={handleTopNewSession}
                disabled={!canCreateTopSession}
                title={topNewSessionCwd ? `在 ${topNewSessionCwd} 新建会话` : "请先在左侧选择项目目录"}
              >
                <AppIcon name="add" size="compact" />
                <span>新建会话</span>
              </button>

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
                onRevealFile={(filePath, cwd, slotIndex) => {
                  handleFocusChatSlot(slotIndex);
                  const target = getExplorerRevealTarget(filePath, cwd);
                  setExplorerReveal((previous) => ({ ...target, sourceCwd: cwd, id: (previous?.id ?? 0) + 1 }));
                  setRightPanelView("explorer");
                  setRightPanelOpen(true);
                }}
                onOpenExplorer={() => {
                  setRightPanelView("explorer");
                  setRightPanelOpen(true);
                }}
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
                <AppIcon name="back" size="section" style={{color: "var(--accent)", ...({ opacity: 0.7, flexShrink: 0 })}} />
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
      {rightPanelOpen && (
        <div
          data-no-window-drag
          className="right-panel-resize-handle"
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

      {/* Right workspace: explorer and preview share the same resizable panel. */}
      <div
        inert={!rightPanelOpen}
        aria-label="右侧扩展栏"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          width: rightPanelOpen ? rightPanelWidth : 0,
          minWidth: rightPanelOpen ? rightPanelMinWidth : 0,
          transition: isResizingRightPanel ? "none" : undefined,
        }}
      >
        <div className="workspace-panel-toolbar" role="group" aria-label="右侧扩展栏视图">
          {(["explorer", "preview"] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="workspace-panel-view"
              aria-label={view === "explorer" ? "资源管理器" : "预览"}
              aria-pressed={rightPanelView === view}
              title={view === "explorer" ? "资源管理器" : "预览"}
              onClick={() => setRightPanelView(view)}
            >
              <AppIcon name={view === "explorer" ? "files" : "preview"} size="toolbar" />
            </button>
          ))}
          <button
            type="button"
            className="workspace-panel-pin"
            aria-label={rightPanelPinned ? "取消固定右栏视图" : "固定右栏视图"}
            aria-pressed={rightPanelPinned}
            title={rightPanelPinned ? "已固定：打开文件不会自动切换视图，点击取消固定" : "固定当前视图，打开文件时不自动跳转预览"}
            onClick={() => {
              const next = !rightPanelPinned;
              setRightPanelPinned(next);
              try { window.localStorage.setItem("deerhux.right-panel-pinned", String(next)); } catch { /* Keep the toggle usable when storage is unavailable. */ }
            }}
          >
            <AppIcon name="pin" size="toolbar" />
          </button>
          <button
            type="button"
            className="workspace-panel-toggle"
            onClick={() => setRightPanelOpen((open) => !open)}
            title={rightPanelOpen ? "隐藏右侧扩展栏" : "显示资源管理器与预览"}
            aria-label={rightPanelOpen ? "隐藏右侧扩展栏" : "显示资源管理器与预览"}
            aria-pressed={rightPanelOpen}
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              background: rightPanelOpen ? "var(--bg-selected)" : "transparent",
              border: "none",
              borderRadius: "var(--radius-control)",
              color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = rightPanelOpen ? "var(--bg-selected)" : "transparent";
              event.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)";
            }}
          >
            <AppIcon name="panel-right" size="toolbar" />
          </button>
        </div>
        <div className="workspace-panel-body" style={{ display: rightPanelView === "explorer" ? "flex" : "none" }}>
          {rightPanelOpen && (explorerCwd ? (
            <WorkspaceExplorer key={explorerCwd} cwd={explorerCwd} revealRequest={currentExplorerReveal} refreshKey={explorerRefreshKey} onOpenFile={handleOpenFile} onAtMention={handleAtMention} />
          ) : <div className="workspace-panel-empty">选择项目后浏览文件</div>)}
        </div>
        <div className="workspace-panel-body" style={{ display: rightPanelView === "preview" ? "flex" : "none" }}>
          {filePreviewDetached ? (
            <div className="workspace-panel-empty">预览已在独立窗口打开<button type="button" onClick={handleReturnFilePreview}>收回预览</button></div>
          ) : (
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
          )}
        </div>
      </div>
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
    <ShareManager open={shareManagerOpen} onClose={() => setShareManagerOpen(false)} projects={projectOptions} />
    {wechatConfigOpen && <WeChatConfig onClose={() => setWechatConfigOpen(false)} />}
    </AiLinkWorkspace.Provider>
  );
}
