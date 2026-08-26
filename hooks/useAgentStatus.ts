"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import type { WatchdogInfo } from "./useAgentSession";

/** 服务端 getStatus() 返回的数据 */
export interface ServerStatus {
  sessionId?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  lastEventType?: string;
  eventCount?: number;
  eventRate?: number;
  eventIdleMs?: number | null;
  contentIdleMs?: number | null;
  isRunning?: boolean;
}

export interface AgentStatusInfo {
  /** 服务端状态 */
  server: ServerStatus | null;
  /** 客户端看门狗数据 */
  watchdog: WatchdogInfo | null;
}

/**
 * 轮询服务端 agent 状态（每 POLL_INTERVAL_MS），结合客户端 watchdogInfo，
 * 提供完整的实时状态数据。
 */
export function useAgentStatus(
  sessionId: string | null | undefined,
  agentRunning: boolean,
  watchdogInfo: WatchdogInfo | null,
  paused = false,
): AgentStatusInfo {
  const POLL_INTERVAL_MS = 2000;
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingGenerationRef = useRef(0);

  // 新回合或会话切换时，必须在浏览器绘制前清掉上一轮的空闲计时，
  // 避免旧 eventIdleMs/contentIdleMs 以强调色状态胶囊闪现一帧。
  useLayoutEffect(() => {
    pollingGenerationRef.current += 1;
    setServerStatus(null);
  }, [sessionId, agentRunning, paused]);

  useEffect(() => {
    // Clear any existing timer
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!sessionId || !agentRunning || paused) {
      setServerStatus(null);
      return;
    }

    const abortController = new AbortController();
    const pollingGeneration = pollingGenerationRef.current;

    const poll = () => {
      fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
        signal: abortController.signal,
      })
        .then((r) => r.json())
        .then((d: { running?: boolean; status?: ServerStatus }) => {
          if (d.status && pollingGenerationRef.current === pollingGeneration) {
            setServerStatus(d.status);
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // ignore other errors — will retry next interval
        });
    };

    // Poll immediately, then every interval
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      abortController.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionId, agentRunning, paused]);

  return { server: serverStatus, watchdog: watchdogInfo };
}
