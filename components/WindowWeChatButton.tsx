"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { AppIcon } from "./AppIcon";
const WeChatConfig = dynamic(() => import("./WeChatConfig").then((module) => module.WeChatConfig));
import styles from "./window-wechat.module.css";

type Connection = { userId: string; sessionId: string; session: { name?: string; firstMessage?: string } | null };
type Snapshot = { connections: Connection[]; status: { wechat: { connected: boolean; polling: boolean; lastError?: string } } };

export function WindowWeChatButton({ sessionId, project, role, ensureSession, headerTargetId }: {
  headerTargetId?: string;
  sessionId?: string;
  project: string;
  role: string;
  ensureSession: () => Promise<string>;
}) {
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderTarget(headerTargetId ? document.getElementById(headerTargetId) : null);
  }, [headerTargetId]);
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/remote-connections", { cache: "no-store" });
    if (!response.ok) throw new Error("加载微信端失败，请重试");
    const data = await response.json() as Snapshot;
    setSnapshot(data);
    return data;
  }, []);

  useEffect(() => {
    const refresh = () => { void load().catch(() => {}); };
    refresh();
    window.addEventListener("deerhux.wechat-binding-updated", refresh);
    const timer = window.setInterval(refresh, 10_000);
    return () => { clearInterval(timer); window.removeEventListener("deerhux.wechat-binding-updated", refresh); };
  }, [load]);

  const update = async (connection: Connection, action: "bind" | "unbind") => {
    const id = action === "bind" ? await ensureSession() : sessionId;
    if (!id) throw new Error("当前窗口还没有会话");
    const response = await fetch("/api/remote-connections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, userId: connection.userId, sessionId: id, expectedSessionId: connection.sessionId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "更新微信绑定失败");
    window.dispatchEvent(new Event("deerhux.wechat-binding-updated"));
    const latest = await load();
    setNotice(action === "unbind" ? "已解除绑定。微信后续消息将使用独立会话。"
      : latest.status.wechat.connected && latest.status.wechat.polling && !latest.status.wechat.lastError
        ? "已绑定并启动监听。在微信发送下一条消息，即可继续当前窗口的对话。"
        : "窗口已绑定，但微信尚未就绪，请查看下方连接状态。");
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "操作失败"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const bound = snapshot?.connections.find((item) => Boolean(sessionId) && item.sessionId === sessionId);
  const label = busy ? "接入中…" : bound ? !snapshot?.status.wechat.connected ? "微信需登录" : !snapshot.status.wechat.polling ? "微信未监听" : snapshot.status.wechat.lastError ? "微信连接异常" : "微信已接入" : "接入微信";
  const trigger = <button type="button" className={styles.trigger} disabled={busy} aria-haspopup="dialog" title={label} aria-label={label}
        onClick={() => {
          dialog.current?.showModal();
          void run(async () => {
            const data = await load();
            if (data.status.wechat.connected && data.connections.length === 1 && (data.connections[0].sessionId !== sessionId || !data.status.wechat.polling)) {
              await update(data.connections[0], "bind");
            }
          });
        }}>
        <AppIcon name="wechat" size="compact" />
        {bound && <span aria-hidden="true" className={`${styles.status} ${label === "微信已接入" ? styles.connected : styles.warning}`} />}
      </button>;
  return <>
    {headerTargetId ? headerTarget && createPortal(trigger, headerTarget) : <div className={styles.toolbar}>{trigger}</div>}
    <dialog ref={dialog} aria-label="当前窗口微信连接" className={styles.dialog} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog.current?.close(); } }} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className={styles.heading}><strong>当前窗口 · 微信连接</strong><button type="button" className={styles.closeButton} onClick={() => dialog.current?.close()} aria-label="关闭微信连接"><AppIcon name="close" size="toolbar" /></button></div>
      <p className={styles.context}>{project} · {role}</p>
      <p>电脑与微信共用项目、角色和已有上下文。在电脑发送的消息和 AI 最终回复也会同步到微信。一个微信端同时接入一个窗口，切换后后续消息进入新窗口。</p>
      <p>主人设备和 DeerHux 需保持在线。当前窗口执行中时，微信消息会等待本轮结束。</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status" className={styles.notice}>{notice}</p>}
      {!snapshot ? <p>{busy ? "正在加载微信端…" : "请重试加载微信端。"}</p> : <>
        {!snapshot.status.wechat.connected ? <p>先扫码登录微信 Bot，再在微信给 Bot 发一条消息。</p>
          : !snapshot.connections.length ? <p>尚未发现微信端。请先在微信给 Bot 发一条消息，再点刷新。</p>
          : <div className={styles.connections}>{snapshot.connections.map((connection) => {
            const current = Boolean(sessionId) && connection.sessionId === sessionId;
            return <div key={connection.userId} className={styles.connection}>
              <div><strong title={connection.userId}>微信 · {connection.userId}</strong><small>{current ? "已接入当前窗口" : connection.sessionId ? `当前：${connection.session?.name || connection.session?.firstMessage || "其他会话"}` : "尚未绑定窗口"}</small></div>
              <button type="button" disabled={busy} onClick={() => void run(() => update(connection, current ? "unbind" : "bind"))}>{current ? "解除绑定" : connection.sessionId ? "切换到此窗口" : "接入此窗口"}</button>
            </div>;
          })}</div>}
        {snapshot.status.wechat.lastError && <p role="alert" className={styles.error}>{snapshot.status.wechat.lastError}</p>}
        {snapshot.status.wechat.connected && !snapshot.status.wechat.polling && <p className={styles.error}>微信监听已停止。重新点击窗口的接入按钮即可恢复，也可在微信设置中启动。</p>}
      </>}
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run(load)}>刷新</button><button type="button" onClick={() => { dialog.current?.close(); setConfigOpen(true); }}>微信设置</button></div>
    </dialog>
    {configOpen && <WeChatConfig onClose={() => { setConfigOpen(false); dialog.current?.showModal(); void run(load); }} />}
  </>;
}
