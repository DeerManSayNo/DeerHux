"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QuickSessionDrawer } from "./QuickSessionDrawer";
import { useTheme } from "@/hooks/useTheme";
import { getProjectDisplayName } from "@/lib/project-name";
import type { ProjectMeta } from "@/lib/project-meta";
import type { SessionInfo } from "@/lib/types";
import { readVisibleProjects, subscribeVisibleProjects } from "@/lib/visible-projects";
import { QUICK_SESSION_TAURI_CLOSE_EVENT, QUICK_SESSION_TAURI_NEW_EVENT, QUICK_SESSION_TAURI_OPEN_EVENT } from "@/lib/quick-session-drawer";
import {
  dismissQuickSession,
  readDismissedQuickSessionIds,
  subscribeDismissedQuickSessions,
} from "@/lib/quick-session-visibility";

type ProjectOption = { cwd: string; displayName: string };

function isScheduledTasksCwd(cwd: string): boolean {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return /[\\/]\.deerhux[\\/]agent[\\/]scheduled-tasks$/.test(normalized)
    || /[\\/]\.deerhux[\\/]agent[\\/]wechat[\\/]remote-cwd$/.test(normalized);
}

function buildSidebarProjects(
  sessions: SessionInfo[],
  meta: Pick<ProjectMeta, "customCwds" | "hiddenCwds" | "pinnedCwds">,
  defaultCwd: string,
): ProjectOption[] {
  const latestByCwd = new Map<string, string>();
  for (const session of sessions) {
    if (!session.cwd || session.isSubagent) continue;
    const latest = latestByCwd.get(session.cwd) ?? "";
    if (session.modified > latest) latestByCwd.set(session.cwd, session.modified);
  }
  for (const cwd of meta.customCwds) {
    if (!latestByCwd.has(cwd)) latestByCwd.set(cwd, "");
  }
  if (defaultCwd && !latestByCwd.has(defaultCwd)) latestByCwd.set(defaultCwd, "");

  return [...latestByCwd.entries()]
    .filter(([cwd]) => cwd === defaultCwd || !meta.hiddenCwds.includes(cwd))
    .sort(([aCwd, aModified], [bCwd, bModified]) => {
      const aIndex = meta.pinnedCwds.indexOf(aCwd);
      const bIndex = meta.pinnedCwds.indexOf(bCwd);
      if ((aIndex !== -1) !== (bIndex !== -1)) return aIndex !== -1 ? -1 : 1;
      if (aIndex !== -1) return aIndex - bIndex;
      return bModified.localeCompare(aModified);
    })
    .slice(0, 5)
    .map(([cwd]) => ({
      cwd,
      displayName: isScheduledTasksCwd(cwd)
        ? "定时任务"
        : cwd === defaultCwd
          ? "默认"
          : getProjectDisplayName(cwd),
    }));
}

export function QuickSessionWindow() {
  useTheme();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLocked, setDrawerLocked] = useState(false);
  const [newSessionRequestKey, setNewSessionRequestKey] = useState(0);
  const [dismissedSessionIds, setDismissedSessionIds] = useState<Set<string>>(() => readDismissedQuickSessionIds());
  const drawerPhaseRef = useRef<"closed" | "opening" | "open">("closed");
  const optimisticSessionsRef = useRef(new Map<string, SessionInfo>());
  const openFrameRef = useRef<number | undefined>(undefined);
  const hideFrameRef = useRef<number | undefined>(undefined);
  const blurTimerRef = useRef<number | undefined>(undefined);
  const focusRevisionRef = useRef(0);
  const drawerLockedRef = useRef(false);

  const mergeFetchedSessions = useCallback((fetched: SessionInfo[]): SessionInfo[] => {
    const byId = new Map<string, SessionInfo>();
    for (const session of fetched) {
      if (session.id && !session.isSubagent) byId.set(session.id, session);
    }
    for (const [sessionId, optimistic] of optimisticSessionsRef.current) {
      if (byId.has(sessionId)) {
        // The JSONL is now visible through SessionManager.listAll(); the server
        // result becomes authoritative from this point on.
        optimisticSessionsRef.current.delete(sessionId);
      } else {
        // New sessions are created before their first assistant message is
        // persisted. Keep them visible across drawer hide/show cycles until the
        // session reader can see the real file.
        byId.set(sessionId, optimistic);
      }
    }
    return [...byId.values()];
  }, []);

  useEffect(() => {
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/sessions", { cache: "no-store" }).then((response) => response.ok ? response.json() : { sessions: [] }),
      fetch("/api/project-meta", { cache: "no-store" }).then((response) => response.ok ? response.json() : { meta: {} }),
      fetch("/api/default-cwd", { method: "POST" }).then((response) => response.ok ? response.json() : { cwd: "" }),
    ]).then(([sessionPayload, metaPayload, defaultPayload]: [
      { sessions?: SessionInfo[] },
      { meta?: Partial<ProjectMeta> },
      { cwd?: string },
    ]) => {
      if (cancelled) return;
      const defaultProjectCwd = defaultPayload.cwd ?? "";
      const projects = buildSidebarProjects(
        sessionPayload.sessions ?? [],
        {
          customCwds: metaPayload.meta?.customCwds ?? [],
          hiddenCwds: metaPayload.meta?.hiddenCwds ?? [],
          pinnedCwds: metaPayload.meta?.pinnedCwds ?? [],
        },
        defaultProjectCwd,
      );
      setSessions(mergeFetchedSessions(sessionPayload.sessions ?? []));
      setSessionsLoaded(true);
      setProjects(readVisibleProjects() ?? projects);
    }).catch(() => setSessionsLoaded(true));
    return () => { cancelled = true; };
  }, [mergeFetchedSessions]);

  useEffect(() => {
    const syncProjects = () => {
      const visibleProjects = readVisibleProjects();
      if (visibleProjects) setProjects(visibleProjects);
    };
    syncProjects();
    window.addEventListener("focus", syncProjects);
    const unsubscribe = subscribeVisibleProjects(setProjects);
    return () => {
      window.removeEventListener("focus", syncProjects);
      unsubscribe();
    };
  }, []);

  useEffect(() => subscribeDismissedQuickSessions(setDismissedSessionIds), []);

  const hideWindow = useCallback((restoreFocus = true) => {
    if (!restoreFocus) {
      // Losing focus means macOS has already activated another application.
      // Use the built-in window command directly: production pages can always
      // access this capability, while a rejected custom invoke would leave an
      // invisible native window intercepting the right side of the screen.
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().hide())
        .catch(() => {});
      return;
    }

    // Shortcut/close-button closes should restore the application that was
    // active before the drawer opened. The native close path has an additional
    // revision-protected fallback if this custom command is unavailable.
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("hide_quick_session_window", { restoreFocus: true }))
      .catch(() => {});
  }, []);

  const cancelPendingHide = useCallback(() => {
    if (hideFrameRef.current === undefined) return;
    window.cancelAnimationFrame(hideFrameRef.current);
    hideFrameRef.current = undefined;
  }, []);

  const cancelPendingOpen = useCallback(() => {
    if (openFrameRef.current === undefined) return;
    window.cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = undefined;
  }, []);

  const cancelPendingBlur = useCallback(() => {
    focusRevisionRef.current += 1;
    if (blurTimerRef.current === undefined) return;
    window.clearTimeout(blurTimerRef.current);
    blurTimerRef.current = undefined;
  }, []);

  const hideWindowAfterClosedPaint = useCallback((restoreFocus: boolean) => {
    cancelPendingHide();
    // Let WKWebView composite the transparent closed state before the native
    // window is hidden, otherwise the next show can briefly reuse its open frame.
    hideFrameRef.current = window.requestAnimationFrame(() => {
      hideFrameRef.current = window.requestAnimationFrame(() => {
        hideFrameRef.current = undefined;
        if (drawerPhaseRef.current === "closed") hideWindow(restoreFocus);
      });
    });
  }, [cancelPendingHide, hideWindow]);

  const commitClose = useCallback((restoreFocus: boolean) => {
    cancelPendingBlur();
    cancelPendingOpen();
    drawerPhaseRef.current = "closed";
    drawerLockedRef.current = false;
    setDrawerLocked(false);
    setDrawerOpen(false);
    hideWindowAfterClosedPaint(restoreFocus);
  }, [cancelPendingBlur, cancelPendingOpen, hideWindowAfterClosedPaint]);

  const closeDrawer = useCallback(() => {
    commitClose(true);
  }, [commitClose]);

  const openDrawer = useCallback(() => {
    cancelPendingBlur();
    cancelPendingHide();
    cancelPendingOpen();
    if (drawerPhaseRef.current !== "closed") return;
    drawerPhaseRef.current = "opening";
    void fetch("/api/sessions", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : { sessions: [] })
      .then((payload) => {
        setSessions(mergeFetchedSessions(payload.sessions ?? []));
        setSessionsLoaded(true);
      })
      .catch(() => {});
    setDrawerOpen(false);
    openFrameRef.current = window.requestAnimationFrame(() => {
      openFrameRef.current = window.requestAnimationFrame(() => {
        openFrameRef.current = undefined;
        if (drawerPhaseRef.current !== "opening") return;
        drawerPhaseRef.current = "open";
        setDrawerOpen(true);
      });
    });
  }, [cancelPendingBlur, cancelPendingHide, cancelPendingOpen, mergeFetchedSessions]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        return appWindow.onFocusChanged(({ payload: focused }) => {
          cancelPendingBlur();
          if (focused) return;
          if (drawerLockedRef.current) return;

          // Focus events can arrive as focus -> blur -> focus while WKWebView
          // becomes key. Verify the native state before committing a close;
          // focus events never initiate a new opening cycle.
          const blurRevision = focusRevisionRef.current;
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = undefined;
            void appWindow.isFocused()
              .then((stillFocused) => {
                if (stillFocused || drawerLockedRef.current || focusRevisionRef.current !== blurRevision) return;
                commitClose(false);
              })
              .catch(() => {
                if (!drawerLockedRef.current && focusRevisionRef.current === blurRevision) commitClose(false);
              });
          }, 100);
        });
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cancelPendingOpen();
      cancelPendingBlur();
      cancelPendingHide();
      drawerPhaseRef.current = "closed";
      unlisten?.();
    };
  }, [cancelPendingBlur, cancelPendingHide, cancelPendingOpen, commitClose]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event")
      .then(({ listen }) => Promise.all([
        listen(QUICK_SESSION_TAURI_OPEN_EVENT, openDrawer),
        listen(QUICK_SESSION_TAURI_CLOSE_EVENT, closeDrawer),
        listen(QUICK_SESSION_TAURI_NEW_EVENT, () => setNewSessionRequestKey((current) => current + 1)),
      ]))
      .then((stopListening) => {
        if (disposed) stopListening.forEach((stop) => stop());
        else {
          unlisten = stopListening;
          void import("@tauri-apps/api/core")
            .then(({ invoke }) => invoke("mark_quick_session_ready"))
            .catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
    };
  }, [closeDrawer, openDrawer]);

  const discardTemporarySessions = useCallback((sessionIds: string[]) => {
    const discardedIds = new Set(sessionIds);
    for (const sessionId of sessionIds) optimisticSessionsRef.current.delete(sessionId);
    setSessions((current) => current.filter((session) => !discardedIds.has(session.id)));
  }, []);

  const changeTemporarySessionCwd = useCallback((sessionId: string, cwd: string) => {
    const optimistic = optimisticSessionsRef.current.get(sessionId);
    if (optimistic) optimisticSessionsRef.current.set(sessionId, { ...optimistic, cwd });
    setSessions((current) => current.map((session) => (
      session.id === sessionId ? { ...session, cwd } : session
    )));
  }, []);

  return (
    <QuickSessionDrawer
      open={drawerOpen}
      sessions={sessions.filter((session) => !dismissedSessionIds.has(session.id))}
      sessionsLoaded={sessionsLoaded}
      projectOptions={projects}
      newSessionRequestKey={newSessionRequestKey}
      locked={drawerLocked}
      onClose={closeDrawer}
      onToggleLocked={() => {
        const nextLocked = !drawerLockedRef.current;
        drawerLockedRef.current = nextLocked;
        setDrawerLocked(nextLocked);
        if (nextLocked) cancelPendingBlur();
      }}
      onDismissSession={(sessionId) => {
        dismissQuickSession(sessionId);
        setDismissedSessionIds((current) => new Set(current).add(sessionId));
      }}
      onDiscardTemporarySessions={discardTemporarySessions}
      onTemporarySessionCwdChange={changeTemporarySessionCwd}
      onSessionCreated={(created, replacedSessionId) => {
        if (replacedSessionId) optimisticSessionsRef.current.delete(replacedSessionId);
        optimisticSessionsRef.current.set(created.id, created);
        setSessions((current) => [
          ...current.filter((session) => session.id !== created.id && session.id !== replacedSessionId),
          created,
        ]);
      }}
      onAgentRunningChange={() => {}}
      onAgentEnd={() => {}}
    />
  );
}
