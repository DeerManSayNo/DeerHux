"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { subscribeAiBackgroundProcesses, subscribeAllAgentEvents } from "@/lib/agent-event-client";
import { AppIcon } from "./AppIcon";
import styles from "./TerminalPanel.module.css";

type TerminalEvent = { sessionId: string; data: string };
type TerminalExitEvent = { sessionId: string };
type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";
type TerminalTab = {
  id: string;
  number: number;
  kind: "shell" | "agent-process";
  cwd: string | null;
  status: TerminalStatus;
  command?: string;
  output?: string;
  backgroundProcess?: boolean;
};

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 280;
const STORAGE_KEY = "deerhux.terminal-height";
const AGENT_PROCESS_REVEAL_DELAY_MS = 10_000;

function textFromToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).filter(Boolean).join("\n");
}

function commandFromArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "bash";
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command.trim() : "bash";
}

function commandLabel(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 32 ? `${singleLine.slice(0, 31)}...` : singleLine;
}

function agentProcessTabId(processId: string): string {
  return `agent-process-${processId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function readStoredHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT;
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function terminalTheme(isDark: boolean) {
  return isDark
    ? { background: "#171717", foreground: "#d8d8d8", cursor: "#f0f0f0", selectionBackground: "#46505b" }
    : { background: "#ffffff", foreground: "#242628", cursor: "#242628", selectionBackground: "#cbd8e8" };
}

function statusLabel(status: TerminalStatus): string {
  if (status === "starting") return "启动中";
  if (status === "running") return "运行中";
  if (status === "exited") return "已退出";
  if (status === "error") return "错误";
  return "待启动";
}

function TerminalSession({ tab, active, panelOpen, isDark, onStatusChange }: {
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
  isDark: boolean;
  onStatusChange: (id: string, status: TerminalStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingOutputRef = useRef<TerminalEvent[]>([]);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const [error, setError] = useState<string | null>(null);

  const fit = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const sessionId = sessionIdRef.current;
    if (!terminal || !fitAddon || !panelOpen || !active) return;
    try {
      fitAddon.fit();
      if (sessionId) {
        void invoke("terminal_resize", {
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      }
    } catch {
      // Hidden tab panels briefly have zero dimensions while switching.
    }
  }, [active, panelOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const unlisten of unlistenRef.current) unlisten();
      const sessionId = sessionIdRef.current;
      if (sessionId) void invoke("terminal_close", { sessionId }).catch(() => undefined);
      terminalRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!panelOpen || !active || terminalRef.current || startingRef.current || !hostRef.current) return;
    if (!window.__TAURI_INTERNALS__) {
      onStatusChange(tab.id, "error");
      setError("终端仅在 DeerHux 桌面应用中可用");
      return;
    }

    startingRef.current = true;
    onStatusChange(tab.id, "starting");
    setError(null);

    void (async () => {
      let terminal: XtermTerminal | null = null;
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        const host = hostRef.current;
        if (!mountedRef.current || !host) return;

        terminal = new Terminal({
          cursorBlink: true,
          convertEol: false,
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.35,
          scrollback: 10_000,
          theme: terminalTheme(isDark),
        });
        const activeTerminal = terminal;
        const fitAddon = new FitAddon();
        activeTerminal.loadAddon(fitAddon);
        activeTerminal.open(host);
        terminalRef.current = activeTerminal;
        fitAddonRef.current = fitAddon;

        const unlistenOutput = await listen<TerminalEvent>("terminal-output", ({ payload }) => {
          const sessionId = sessionIdRef.current;
          if (!sessionId) {
            pendingOutputRef.current.push(payload);
          } else if (payload.sessionId === sessionId) {
            activeTerminal.write(decodeBase64(payload.data));
          }
        });
        if (!mountedRef.current) {
          unlistenOutput();
          return;
        }
        const unlistenExit = await listen<TerminalExitEvent>("terminal-exit", ({ payload }) => {
          if (payload.sessionId !== sessionIdRef.current) return;
          onStatusChange(tab.id, "exited");
          activeTerminal.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
        });
        if (!mountedRef.current) {
          unlistenOutput();
          unlistenExit();
          return;
        }
        unlistenRef.current = [unlistenOutput, unlistenExit];
        fitAddon.fit();
        const sessionId = await invoke<string>("terminal_create", {
          cwd: tab.cwd,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        });
        if (!mountedRef.current) {
          await invoke("terminal_close", { sessionId });
          return;
        }
        sessionIdRef.current = sessionId;
        for (const payload of pendingOutputRef.current) {
          if (payload.sessionId === sessionId) activeTerminal.write(decodeBase64(payload.data));
        }
        pendingOutputRef.current = [];
        activeTerminal.onData((data) => {
          void invoke("terminal_write", { sessionId, data: encodeBase64(data) }).catch((reason) => {
            setError(String(reason));
            onStatusChange(tab.id, "error");
          });
        });
        onStatusChange(tab.id, "running");
        requestAnimationFrame(fit);
        activeTerminal.focus();
      } catch (reason) {
        setError(String(reason));
        onStatusChange(tab.id, "error");
        terminal?.write(`\r\n\x1b[31m${String(reason)}\x1b[0m\r\n`);
      } finally {
        startingRef.current = false;
      }
    })();
  }, [active, fit, isDark, onStatusChange, panelOpen, tab.cwd, tab.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(isDark);
  }, [isDark]);

  useEffect(() => {
    if (!active || !panelOpen) return;
    const frame = requestAnimationFrame(() => {
      fit();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fit, panelOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <div
      className={styles.session}
      role="tabpanel"
      id={`${tab.id}-panel`}
      aria-labelledby={`${tab.id}-tab`}
      hidden={!active}
    >
      <div ref={hostRef} className={styles.terminal} />
      {error && <div className={styles.error} role="status">{error}</div>}
    </div>
  );
}

function AgentProcessSession({ tab, active, panelOpen, isDark }: {
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
  isDark: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const renderedOutputRef = useRef("");
  const activeRef = useRef(active);
  const panelOpenRef = useRef(panelOpen);
  const isDarkRef = useRef(isDark);
  const latestOutputRef = useRef(tab.output ?? "");
  activeRef.current = active;
  panelOpenRef.current = panelOpen;
  isDarkRef.current = isDark;
  latestOutputRef.current = tab.output ?? "";

  const fit = useCallback(() => {
    if (!activeRef.current || !panelOpenRef.current) return;
    try { fitAddonRef.current?.fit(); } catch { /* Hidden panels can briefly have zero dimensions. */ }
  }, []);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;
    let disposed = false;
    let terminal: XtermTerminal | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: 1.35,
        scrollback: 10_000,
        theme: terminalTheme(isDarkRef.current),
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(hostRef.current);
      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      terminal.write(`\x1b[2m$ ${tab.command ?? "bash"}\x1b[0m\r\n\r\n`);
      const output = latestOutputRef.current;
      if (output) terminal.write(output);
      renderedOutputRef.current = output;
      requestAnimationFrame(fit);
    })();
    return () => {
      disposed = true;
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [fit, tab.command]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const previous = renderedOutputRef.current;
    const output = tab.output ?? "";
    if (output === previous) return;
    if (output.startsWith(previous)) {
      terminal.write(output.slice(previous.length));
    } else {
      terminal.reset();
      terminal.write(`\x1b[2m$ ${tab.command ?? "bash"}\x1b[0m\r\n\r\n${output}`);
    }
    renderedOutputRef.current = output;
  }, [tab.command, tab.output]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(isDark);
  }, [isDark]);

  useEffect(() => {
    if (!active || !panelOpen) return;
    requestAnimationFrame(fit);
  }, [active, fit, panelOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [fit]);

  return (
    <div className={styles.session} role="tabpanel" id={`${tab.id}-panel`} aria-labelledby={`${tab.id}-tab`} hidden={!active}>
      <div ref={hostRef} className={styles.terminal} />
    </div>
  );
}

export function TerminalPanel({ open, cwd, isDark, onClose }: {
  open: boolean;
  cwd: string | null;
  isDark: boolean;
  onClose: () => void;
}) {
  const nextTabNumberRef = useRef(1);
  const [height, setHeight] = useState(readStoredHeight);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const pendingAgentProcessesRef = useRef(new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    command: string;
    output: string;
  }>());
  const backgroundProcessIdsRef = useRef(new Set<string>());
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;
  onCloseRef.current = onClose;

  const commitTabs = useCallback((next: TerminalTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const commitActiveTab = useCallback((id: string | null) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  const addTab = useCallback(() => {
    const number = nextTabNumberRef.current;
    nextTabNumberRef.current += 1;
    const tab: TerminalTab = {
      id: `terminal-tab-${number}`,
      number,
      kind: "shell",
      cwd,
      status: "idle",
    };
    commitTabs([...tabsRef.current, tab]);
    commitActiveTab(tab.id);
  }, [commitActiveTab, commitTabs, cwd]);

  useEffect(() => {
    if (open && tabs.length === 0) addTab();
  }, [addTab, open, tabs.length]);

  const updateStatus = useCallback((id: string, status: TerminalStatus) => {
    commitTabs(tabsRef.current.map((tab) => tab.id === id && tab.status !== status ? { ...tab, status } : tab));
  }, [commitTabs]);

  const closeTab = useCallback((id: string) => {
    const current = tabsRef.current;
    const closingIndex = current.findIndex((tab) => tab.id === id);
    if (closingIndex < 0) return;
    const remaining = current.filter((tab) => tab.id !== id);
    commitTabs(remaining);
    if (remaining.length === 0) {
      commitActiveTab(null);
      onCloseRef.current();
      return;
    }
    if (activeTabIdRef.current === id) {
      commitActiveTab(remaining[Math.min(closingIndex, remaining.length - 1)].id);
    }
  }, [commitActiveTab, commitTabs]);

  useEffect(() => {
    const pending = pendingAgentProcessesRef.current;
    const unsubscribe = subscribeAllAgentEvents(({ sessionId, event }) => {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!toolCallId) return;
      const processId = `${sessionId}:${toolCallId}`;
      const tabId = agentProcessTabId(processId);

      if (event.type === "tool_execution_start" && event.toolName === "bash") {
        if (pending.has(processId) || tabsRef.current.some((tab) => tab.id === tabId)) return;
        const command = commandFromArgs(event.args);
        const process = {
          command,
          output: "",
          timer: setTimeout(() => {
            const latest = pending.get(processId);
            if (!latest) return;
            pending.delete(processId);
            const number = nextTabNumberRef.current;
            nextTabNumberRef.current += 1;
            const tab: TerminalTab = {
              id: tabId,
              number,
              kind: "agent-process",
              cwd: null,
              status: "running",
              command: latest.command,
              output: latest.output,
            };
            commitTabs([...tabsRef.current, tab]);
            commitActiveTab(tab.id);
          }, AGENT_PROCESS_REVEAL_DELAY_MS),
        };
        pending.set(processId, process);
        return;
      }

      if (event.type === "tool_execution_update") {
        const output = textFromToolResult(event.partialResult);
        const waiting = pending.get(processId);
        if (waiting) waiting.output = output;
        const current = tabsRef.current;
        if (current.some((tab) => tab.id === tabId)) {
          commitTabs(current.map((tab) => tab.id === tabId ? { ...tab, output } : tab));
        }
        return;
      }

      if (event.type === "tool_execution_end") {
        const waiting = pending.get(processId);
        if (waiting) {
          clearTimeout(waiting.timer);
          pending.delete(processId);
        }
        if (!backgroundProcessIdsRef.current.has(processId)) closeTab(tabId);
      }
    });

    return () => {
      unsubscribe();
      for (const process of pending.values()) clearTimeout(process.timer);
      pending.clear();
    };
  }, [closeTab, commitActiveTab, commitTabs]);

  useEffect(() => subscribeAiBackgroundProcesses((frame) => {
    const activeProcessIds = new Set(frame.processes.map((process) => process.processId));
    backgroundProcessIdsRef.current = activeProcessIds;

    for (const tab of [...tabsRef.current]) {
      if (!tab.backgroundProcess) continue;
      const matchingProcess = frame.processes.some((process) => agentProcessTabId(process.processId) === tab.id);
      if (!matchingProcess) closeTab(tab.id);
    }

    let next = tabsRef.current;
    let newestTabId: string | null = null;
    for (const process of frame.processes) {
      const tabId = agentProcessTabId(process.processId);
      const existingIndex = next.findIndex((tab) => tab.id === tabId);
      if (existingIndex >= 0) {
        next = next.map((tab, index) => index === existingIndex ? {
          ...tab,
          backgroundProcess: true,
          cwd: process.cwd,
          command: process.command,
          output: process.output || tab.output,
        } : tab);
        continue;
      }
      const number = nextTabNumberRef.current;
      nextTabNumberRef.current += 1;
      newestTabId = tabId;
      next = [...next, {
        id: tabId,
        number,
        kind: "agent-process",
        backgroundProcess: true,
        cwd: process.cwd,
        status: "running",
        command: process.command,
        output: process.output,
      }];
    }
    if (next !== tabsRef.current) commitTabs(next);
    if (newestTabId) commitActiveTab(newestTabId);
  }), [closeTab, commitActiveTab, commitTabs]);

  const selectAdjacentTab = (currentId: string, direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.id === currentId);
    if (index < 0) return;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    commitActiveTab(next.id);
    requestAnimationFrame(() => document.getElementById(`${next.id}-tab`)?.focus());
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) => {
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 180);
      setHeight(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + startY - moveEvent.clientY)));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      setHeight((current) => {
        try { window.localStorage.setItem(STORAGE_KEY, String(current)); } catch { /* Keep resizing usable without storage. */ }
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <section
      className={styles.panel}
      data-open={open}
      style={{ height: open ? height : 0 }}
      aria-label="终端"
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <div className={styles.resizeHandle} onPointerDown={beginResize} aria-hidden="true" />
      <header className={styles.toolbar}>
        <AppIcon name="terminal" size="compact" />
        <div className={styles.tabs} role="tablist" aria-label="终端页签">
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId;
            const label = tab.kind === "agent-process" ? commandLabel(tab.command ?? "bash") : `终端 ${tab.number}`;
            return (
              <div className={styles.tab} data-active={selected} key={tab.id}>
                <button
                  type="button"
                  id={`${tab.id}-tab`}
                  className={styles.tabSelect}
                  role="tab"
                  aria-label={`${label}，${statusLabel(tab.status)}`}
                  aria-selected={selected}
                  aria-controls={`${tab.id}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => commitActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      selectAdjacentTab(tab.id, event.key === "ArrowLeft" ? -1 : 1);
                    }
                  }}
                >
                  <span className={styles.statusDot} data-state={tab.status} aria-hidden="true" />
                  <span>{label}</span>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  onClick={() => closeTab(tab.id)}
                  aria-label={tab.kind === "agent-process" ? `隐藏 ${label} 输出` : `关闭终端 ${tab.number}`}
                  title={tab.kind === "agent-process" ? "隐藏进程输出" : `关闭终端 ${tab.number}`}
                >
                  <AppIcon name="close" size="inline" />
                </button>
              </div>
            );
          })}
        </div>
        <span className={styles.cwd} title={activeTab?.command ?? activeTab?.cwd ?? undefined}>
          {activeTab?.kind === "agent-process" ? "AI 进程输出" : activeTab?.cwd ?? "默认目录"}
        </span>
        <button type="button" className={styles.action} onClick={addTab} aria-label="新建终端" title="新建终端">
          <AppIcon name="add" size="compact" />
        </button>
        <button type="button" className={styles.action} onClick={onClose} aria-label="隐藏终端" title="隐藏终端">
          <AppIcon name="close" size="compact" />
        </button>
      </header>
      <div className={styles.sessions}>
        {tabs.map((tab) => tab.kind === "agent-process" ? (
          <AgentProcessSession key={tab.id} tab={tab} active={tab.id === activeTabId} panelOpen={open} isDark={isDark} />
        ) : (
          <TerminalSession key={tab.id} tab={tab} active={tab.id === activeTabId} panelOpen={open} isDark={isDark} onStatusChange={updateStatus} />
        ))}
      </div>
    </section>
  );
}
