"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { resolveLocalFileHref } from "@/lib/external-links";
import { getRelativeFilePath } from "@/lib/file-paths";
import styles from "./AiFileLinkMenu.module.css";

export function AiFileLinkMenu({ cwd, children }: { cwd?: string | null; children: ReactNode }) {
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; anchor: HTMLElement } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const revision = useRef(0);

  useEffect(() => { setMenu(null); revision.current += 1; }, [cwd]);
  useEffect(() => {
    if (!menu) return;
    const close = () => { revision.current += 1; setMenu(null); };
    const outside = (event: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        menu.anchor.focus({ preventScroll: true });
        close();
      } else if (event.key === "Tab") close();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [menu, error]);

  function openMenu(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("[data-ai-output] a[href]");
    if (!anchor) return;
    // Remove source line references before resolving a filesystem path.
    const href = (anchor.getAttribute("href") ?? "").replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
    const path = resolveLocalFileHref(href, cwd);
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    revision.current += 1;
    setError("");
    setBusy(false);
    const rect = anchor.getBoundingClientRect();
    setMenu({ path, anchor, x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  }

  async function act(action: "relative" | "absolute" | "reveal") {
    if (!menu || busy) return;
    const currentRevision = revision.current;
    setBusy(true);
    setError("");
    try {
      if (action === "reveal") {
        const response = await fetch("/api/files/reveal", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: menu.path }),
        });
        if (!response.ok) throw new Error(response.status === 404 ? "文件不存在或已移动" : "无法打开所在文件夹");
      } else {
        await navigator.clipboard.writeText(action === "relative" ? getRelativeFilePath(menu.path, cwd ?? undefined) : menu.path);
      }
      if (revision.current === currentRevision) {
        menu.anchor.focus({ preventScroll: true });
        setMenu(null);
      }
    } catch (cause) {
      if (revision.current === currentRevision) setError(action === "reveal" && cause instanceof Error ? cause.message : "复制失败，请重试");
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  return (
    <div style={{ display: "contents" }} onContextMenu={openMenu}>
      {children}
      {menu && createPortal(
        <div ref={menuRef} className={styles.menu} role="menu" aria-label="文件链接操作"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={(event) => {
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
            else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = buttons.length - 1;
            else return;
            event.preventDefault();
            buttons[next]?.focus({ preventScroll: true });
          }}>
          <button role="menuitem" disabled={busy} onClick={() => void act("relative")}>复制相对路径</button>
          <button role="menuitem" disabled={busy} onClick={() => void act("absolute")}>复制绝对路径</button>
          <div className={styles.divider} />
          <button role="menuitem" disabled={busy} onClick={() => void act("reveal")}>
            {/Mac/i.test(navigator.platform) ? "在 Finder 中显示" : "打开所在文件夹"}
          </button>
          {error && <div className={styles.error} role="alert">{error}</div>}
        </div>, document.body,
      )}
    </div>
  );
}
