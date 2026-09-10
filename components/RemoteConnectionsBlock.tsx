"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";

type RemoteConnection = {
  id: string;
  type: "wechat";
  provider: string;
  userId: string;
  sessionId: string;
  session: SessionInfo | null;
  connected: boolean;
  polling: boolean;
};

type RemoteConnectionsResponse = {
  connections?: RemoteConnection[];
  status?: { wechat?: { connected: boolean; polling: boolean; accountId?: string; activeUserCount?: number } };
};

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
}

function shortId(id: string): string {
  if (!id) return "unknown";
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function statusText(connection: RemoteConnection): string {
  if (connection.polling) return "在线";
  if (connection.connected) return "已连接";
  return "离线";
}

function statusColor(connection: Pick<RemoteConnection, "connected" | "polling">): string {
  if (connection.polling) return "#22c55e";
  if (connection.connected) return "#eab308";
  return "#6b7280";
}

export function RemoteConnectionsBlock({ selectedSessionId, onSelectSession }: Props) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const [wechatStatus, setWechatStatus] = useState<{ connected: boolean; polling: boolean; accountId?: string; activeUserCount?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/remote-connections", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as RemoteConnectionsResponse;
      setConnections(data.connections ?? []);
      setWechatStatus(data.status?.wechat ?? null);
    } catch {
      setError("加载远程连接失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const refresh = () => { void fetchData(); };
    refresh();
    window.addEventListener("deerhux.wechat-binding-updated", refresh);
    return () => window.removeEventListener("deerhux.wechat-binding-updated", refresh);
  }, [fetchData]);

  useEffect(() => {
    if (!open) return;
    void fetchData();
    const timer = window.setInterval(() => void fetchData(), 10_000);
    return () => window.clearInterval(timer);
  }, [open, fetchData]);

  const headerCount = useMemo(() => {
    if (connections.length > 0) return `${connections.length} 个 Session`;
    if (wechatStatus?.polling) return "在线";
    if (wechatStatus?.connected) return "已连接";
    return "无连接";
  }, [connections.length, wechatStatus]);

  const fallbackStatus = { connected: Boolean(wechatStatus?.connected), polling: Boolean(wechatStatus?.polling) };

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        borderBottom: open ? "1px solid var(--border)" : "none",
        background: "var(--bg-subtle)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", paddingTop: 2 }}>
        <button
          onClick={() => setOpen((v) => !v)}
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
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
          远程连接
          <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, letterSpacing: 0, textTransform: "none" }}>
            {headerCount}
          </span>
        </button>
        {open && (
          <button
            onClick={() => void fetchData()}
            title="刷新远程连接"
            disabled={loading}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              marginRight: 6,
              background: "none",
              border: "none",
              color: loading ? "var(--text-dim)" : "var(--text-muted)",
              cursor: loading ? "default" : "pointer",
              borderRadius: 5,
              flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M16 8h5V3" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div style={{ padding: "0 8px 8px" }}>
          {error && <div style={{ padding: "7px 8px", color: "#ef4444", fontSize: 11 }}>{error}</div>}
          {!error && loading && connections.length === 0 && <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>加载中...</div>}
          {!error && !loading && connections.length === 0 && (
            <div style={{ padding: "7px 8px", color: "var(--text-dim)", fontSize: 11 }}>
              暂无远程长连接 Session
              <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor(fallbackStatus), flexShrink: 0 }} />
                微信 Bot：{wechatStatus?.polling ? "在线，等待首条消息" : wechatStatus?.connected ? "已连接，未监听" : "未连接"}
              </div>
            </div>
          )}
          {connections.map((connection) => {
            const active = connection.sessionId === selectedSessionId;
            const selectable = Boolean(connection.session);
            return (
              <button
                key={connection.id}
                disabled={!selectable}
                onClick={() => { if (connection.session) onSelectSession(connection.session); }}
                title={connection.userId}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  border: "none",
                  borderRadius: 8,
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: selectable ? "pointer" : "default",
                  textAlign: "left",
                  opacity: selectable ? 1 : 0.55,
                  marginBottom: 2,
                }}
                onMouseEnter={(e) => { if (!active && selectable) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(connection), boxShadow: connection.polling ? "0 0 6px #22c55e" : "none", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: active ? 700 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    微信 · {shortId(connection.userId)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {statusText(connection)} · {connection.session ? (connection.session.name || connection.session.firstMessage || connection.sessionId.slice(0, 8)) : connection.sessionId ? "Session 未落盘" : "尚未绑定窗口"}
                  </div>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
