"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppIcon } from "@/components/AppIcon";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import styles from "./WeChatConfig.module.css";

interface WeChatStatus {
  connected: boolean;
  polling: boolean;
  accountId?: string;
  qrcodeUrl?: string;
  activeUserCount?: number;
}

export function WeChatConfig({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<WeChatStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/wechat", { cache: "no-store" });
      if (response.ok) setStatus(await response.json());
    } catch { /* the next poll retries */ }
  }, []);

  useEffect(() => {
    void fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  const callApi = useCallback(async (action: string) => {
    setLoading(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/wechat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json();
      if (payload.error) setError(payload.error);
      else { setMessage(payload.message ?? "操作成功"); await fetchStatus(); }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally { setLoading(false); }
  }, [fetchStatus]);

  const connected = status?.connected ?? false;
  const polling = status?.polling ?? false;
  const showQrcode = !connected && status?.qrcodeUrl;
  const qrImageUrl = showQrcode ? `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(status.qrcodeUrl!)}` : null;
  const statusText = polling ? "在线接收消息" : connected ? "已连接，接收已停止" : "未连接";

  return (
    <ModalShell
      onClose={onClose}
      layout="content"
      title="微信 Bot"
      subtitle="iLink Bot 接入"
      className={styles.panel}
      bodyClassName={styles.body}
      footer={(
        <>
          {connected ? <Button variant="danger" className={styles.logout} disabled={loading} onClick={() => void callApi("logout")}>退出登录</Button> : null}
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {!connected ? <Button variant="primary" disabled={loading} onClick={() => void callApi("login")}>{loading ? "获取中..." : "扫码登录"}</Button> : null}
          {connected && !polling ? <Button variant="primary" disabled={loading} onClick={() => void callApi("start")}>{loading ? "启动中..." : "开始接收消息"}</Button> : null}
          {polling ? <Button variant="secondary" disabled={loading} onClick={() => void callApi("stop")}>停止接收</Button> : null}
        </>
      )}
    >
      <div className={styles.statusRow}>
        <span className={styles.statusDot} data-state={polling ? "online" : connected ? "connected" : "offline"} />
        <div><strong>{statusText}</strong>{status?.accountId ? <code>{status.accountId}</code> : null}</div>
        {status?.activeUserCount ? <span className={styles.userCount}>{status.activeUserCount} 位活跃用户</span> : null}
      </div>

      {error ? <div role="alert" className={styles.error}>{error}</div> : null}
      {message ? <div role="status" className={styles.notice}>{message}</div> : null}

      <div className={styles.content}>
        {showQrcode && qrImageUrl ? <div className={styles.qrState}>
          <div className={styles.qrCode}>
            {/* eslint-disable-next-line @next/next/no-img-element -- remote QR service returns a generated bitmap */}
            <img src={qrImageUrl} alt="微信登录二维码" width={220} height={220} />
          </div>
          <div><strong>使用微信扫描二维码</strong><span>扫码后在微信中确认登录</span></div>
        </div> : connected ? <div className={styles.centerState}>
          <AppIcon name="check" size="section" />
          <strong>{polling ? "Bot 正在接收消息" : "微信账号已连接"}</strong>
          <span>{polling ? "微信消息会转交给 Agent 并自动回复。" : "开始接收后，微信消息才会进入 DeerHux。"}</span>
        </div> : <div className={styles.centerState}>
          <AppIcon name="wechat" size="section" />
          <strong>连接微信账号</strong>
          <span>生成二维码后使用微信扫码登录。</span>
        </div>}
      </div>
    </ModalShell>
  );
}
