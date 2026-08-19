"use client";

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { FilePreviewPanel } from "./FilePreviewPanel";
import {
  FILE_PREVIEW_CHANNEL_NAME,
  FILE_PREVIEW_STATE_STORAGE_KEY,
  FILE_PREVIEW_TAURI_COMMAND_EVENT,
  FILE_PREVIEW_TAURI_STATE_EVENT,
  sanitizeFilePreviewState,
  type FilePreviewChannelMessage,
  type FilePreviewState,
} from "@/lib/file-preview-window";

function readInitialState(): FilePreviewState {
  if (typeof window === "undefined") {
    return { tabs: [], activeTabId: null, cwd: null, viewerCwd: null };
  }

  try {
    return sanitizeFilePreviewState(JSON.parse(window.localStorage.getItem(FILE_PREVIEW_STATE_STORAGE_KEY) ?? "{}"));
  } catch {
    return { tabs: [], activeTabId: null, cwd: null, viewerCwd: null };
  }
}

export function FilePreviewWindow() {
  useTheme();
  const [state, setState] = useState<FilePreviewState>({ tabs: [], activeTabId: null, cwd: null, viewerCwd: null });
  const [channel, setChannel] = useState<BroadcastChannel | null>(null);

  const postMessage = useCallback((message: FilePreviewChannelMessage) => {
    channel?.postMessage(message);
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit(FILE_PREVIEW_TAURI_COMMAND_EVENT, message))
      .catch(() => {});
  }, [channel]);

  useEffect(() => {
    setState(readInitialState());
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const nextChannel = new BroadcastChannel(FILE_PREVIEW_CHANNEL_NAME);
    setChannel(nextChannel);
    nextChannel.onmessage = (event: MessageEvent<FilePreviewChannelMessage>) => {
      const message = event.data;
      if (message?.type === "state") {
        setState(sanitizeFilePreviewState(message.state));
      }
    };
    nextChannel.postMessage({ type: "ready" } satisfies FilePreviewChannelMessage);

    return () => {
      nextChannel.close();
      setChannel(null);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void import("@tauri-apps/api/event")
      .then(({ emit, listen }) => Promise.all([
        listen<FilePreviewState>(FILE_PREVIEW_TAURI_STATE_EVENT, (event) => {
          setState(sanitizeFilePreviewState(event.payload));
        }),
        emit(FILE_PREVIEW_TAURI_COMMAND_EVENT, { type: "ready" } satisfies FilePreviewChannelMessage),
      ]))
      .then(([cleanup]) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!channel) return;

    const notifyClosed = () => {
      channel.postMessage({ type: "closed" } satisfies FilePreviewChannelMessage);
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(FILE_PREVIEW_TAURI_COMMAND_EVENT, { type: "closed" } satisfies FilePreviewChannelMessage))
        .catch(() => {});
    };
    window.addEventListener("beforeunload", notifyClosed);
    return () => {
      window.removeEventListener("beforeunload", notifyClosed);
    };
  }, [channel]);

  const handleSelectTab = useCallback((tabId: string) => {
    setState((prev) => ({ ...prev, activeTabId: tabId }));
    postMessage({ type: "select", tabId });
  }, [postMessage]);

  const handleCloseTab = useCallback((tabId: string) => {
    setState((prev) => {
      const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
      return {
        ...prev,
        tabs,
        activeTabId: prev.activeTabId === tabId ? tabs.at(-1)?.id ?? null : prev.activeTabId,
      };
    });
    postMessage({ type: "close", tabId });
  }, [postMessage]);

  const handleOpenFile = useCallback((filePath: string, fileName: string) => {
    postMessage({ type: "open", filePath, fileName });
  }, [postMessage]);

  const handleCloseTabs = useCallback((tabIds: string[]) => {
    const ids = new Set(tabIds);
    setState((prev) => {
      const tabs = prev.tabs.filter((tab) => !ids.has(tab.id));
      return {
        ...prev,
        tabs,
        activeTabId: prev.activeTabId && !ids.has(prev.activeTabId) ? prev.activeTabId : tabs.at(-1)?.id ?? null,
      };
    });
    postMessage({ type: "closeMany", tabIds });
  }, [postMessage]);

  return (
    <main style={{ height: "100dvh", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      <FilePreviewPanel
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        cwd={state.cwd}
        viewerCwd={state.viewerCwd}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onCloseTabs={handleCloseTabs}
        onOpenFile={handleOpenFile}
      />
    </main>
  );
}
