"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ProjectBranch({ cwd, refreshKey }: { cwd: string; refreshKey: string }) {
  const [branch, setBranch] = useState<string | null>(null);
  const [position, setPosition] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const switchPendingRef = useRef(false);

  useEffect(() => {
    if (!position) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/projects/branch?cwd=${encodeURIComponent(cwd)}&list=1`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取分支失败");
        if (!controller.signal.aborted) {
          setBranches(data.branches ?? []);
          setBranch(data.branch ?? null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取分支失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    menuRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node) && !switchPendingRef.current) setPosition(null);
    };
    const close = () => { if (!switchPendingRef.current) setPosition(null); };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    return () => {
      controller.abort();
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", close);
    };
  }, [cwd, position]);

  const switchBranch = async (nextBranch: string) => {
    if (switchPendingRef.current || nextBranch === branch) return;
    switchPendingRef.current = true;
    setSwitching(true);
    setError(null);
    try {
      const response = await fetch("/api/projects/branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch: nextBranch }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "切换分支失败");
      setBranch(data.branch ?? null);
      setPosition(null);
      triggerRef.current?.focus();
    } catch (error) {
      setError(error instanceof Error ? error.message : "切换分支失败，请刷新确认当前分支");
    } finally {
      switchPendingRef.current = false;
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (switching) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || controller) return;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/projects/branch?cwd=${encodeURIComponent(cwd)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Unable to read project branch");
        const data = await response.json();
        if (!disposed) setBranch(typeof data.branch === "string" ? data.branch : null);
      } catch {
        if (!disposed) setBranch(null);
      } finally {
        controller = null;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [cwd, refreshKey, switching]);

  return (
    <>
    <button
      ref={triggerRef}
      type="button"
      aria-label={`切换项目分支，当前${branch ?? "无分支"}`}
      aria-haspopup="dialog"
      aria-expanded={!!position}
      onClick={(event) => {
        event.stopPropagation();
        if (switching) return;
        if (position) { setPosition(null); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        setError(null);
        setBranches([]);
        setLoading(true);
        setPosition({
          right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 188)),
          ...(window.innerHeight - rect.bottom >= 224
            ? { top: rect.bottom + 3 }
            : { bottom: window.innerHeight - rect.top + 3 }),
        });
      }}
      onKeyDown={(event) => event.stopPropagation()}
      title={branch ? `当前分支：${branch}` : "无分支（非 Git 仓库、分离 HEAD 或路径不可用）"}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, maxWidth: "40%", minWidth: 0, flexShrink: 0, color: branch ? "var(--text-muted)" : "var(--text-dim)", opacity: branch ? 1 : 0.6, fontSize: 10, background: "transparent", border: "none", padding: "4px 0", cursor: "pointer" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
        <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" />
        <path d="M6 7v10M18 7a12 12 0 0 1-12 12" />
      </svg>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branch ?? "无分支"}</span>
      <span aria-hidden="true">⌄</span>
    </button>
    {position && createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="切换项目分支"
        aria-busy={loading || switching}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !switching) {
            setPosition(null);
            triggerRef.current?.focus();
          }
        }}
        style={{ position: "fixed", ...position, zIndex: 10000, width: 180, boxSizing: "border-box", maxWidth: "calc(100vw - 16px)", maxHeight: "min(220px, calc(100vh - 16px))", overflowY: "auto", padding: 3, borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 4px 14px #0002", color: "var(--text)" }}
      >
        {switching && <div role="status" style={{ padding: "4px 6px", fontSize: 11, color: "var(--text-muted)" }}>切换中…</div>}
        {loading && <div role="status" style={{ padding: "4px 6px", fontSize: 11 }}>正在读取分支…</div>}
        {!loading && !error && branches.length === 0 && <div style={{ padding: "4px 6px", fontSize: 11 }}>暂无可切换的本地分支</div>}
        {branches.map((name) => (
          <button key={name} type="button" disabled={switching || name === branch} onClick={() => void switchBranch(name)} title={name}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "4px 6px", lineHeight: "18px", border: "none", borderRadius: 3, background: name === branch ? "var(--bg-selected)" : "transparent", color: name === branch ? "var(--accent)" : "var(--text)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: switching || name === branch ? "default" : "pointer", opacity: switching ? 0.6 : 1 }}>
            {name === branch ? "✓ " : ""}{name}
          </button>
        ))}
        {error && <div role="alert" style={{ padding: "4px 6px", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-muted)" }}>切换未完成：{error}</div>}
      </div>, document.body,
    )}
    </>
  );
}
