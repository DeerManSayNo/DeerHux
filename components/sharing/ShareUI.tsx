"use client";

import { useRef, useState, type ReactNode } from "react";
import styles from "./sharing.module.css";

const paths = {
  share: "M18 8a3 3 0 1 0-3-3 3 3 0 0 0 3 3ZM6 15a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm12 7a3 3 0 1 0-3-3 3 3 0 0 0 3 3ZM8.6 10.5l6.8-4M8.6 13.5l6.8 4",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
  folder: "M3 7V4h6l2 3h10v13H3z",
  model: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  role: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 5v14M5 12h14",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  copy: "M8 8h13v13H8zM16 8V3H3v13h5",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  window: "M3 4h18v16H3zM3 9h18M7 6.5h.01M10 6.5h.01",
  moon: "M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  alert: "M12 3 2 21h20L12 3Zm0 6v5m0 3v1",
  edit: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z",
} as const;
export function ShareIcon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function ShareBrand() {
  return <div className={styles.brand}><span className={styles.brandMark}><ShareIcon name="share" size={20} /></span><span>DeerHux <span className={styles.brandSub}>分享空间</span></span></div>;
}
export function ShareNotice({ children }: { children: ReactNode }) {
  return <div role="alert" className={styles.notice}><ShareIcon name="alert" /><span>{children}</span></div>;
}
export function CopyField({ value, label, code = false }: { value: string; label: string; code?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setFeedback("已复制"); }
    catch { input.current?.focus(); input.current?.select(); setFeedback("已选中，请手动复制"); }
  }
  return <div className={styles.copyField}>
    <label className={styles.fieldLabel}>{label}<span className={styles.copyRow}>
      <input ref={input} className={code ? styles.codeValue : styles.copyValue} aria-label={label} readOnly value={value} onFocus={event => event.target.select()} />
      <button type="button" className={styles.iconButton} aria-label={`复制${label}`} title={`复制${label}`} onClick={() => void copy()}><ShareIcon name={feedback === "已复制" ? "check" : "copy"} /></button>
    </span></label>
    {feedback && <small className={styles.copyFeedback} role="status">{feedback}</small>}
  </div>;
}
export function expiryLabel(expiresAt: number | null) {
  if (expiresAt === null) return "永久有效";
  return new Date(expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " 到期";
}
