"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { Button } from "./Button";
import styles from "./Modal.module.css";

/**
 * 二级窗口外壳。
 *
 * 统一承担：遮罩与层级、Escape 关闭、点击遮罩关闭、焦点约束与恢复、
 * 弹窗圆角与阴影、滚动容器（.app-scrollbar）。
 * 业务模块只负责内容，不再自行定义 overlay / modal 样式与关闭按钮。
 *
 * 两种布局：
 * - split：左列表栏（sidebar）+ 右主区（children），用于设置类面板。
 * - content：单一内容区窗口，适合总览与单对象配置。
 * - confirm：居中窄弹窗（children），标题与操作同栏。
 */

type ModalShellProps = {
  open?: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 左栏内容（split 布局）。 */
  sidebar?: ReactNode;
  /** 左栏底部操作，如「新建」。 */
  sidebarFooter?: ReactNode;
  /** 主区标题行右侧操作。 */
  actions?: ReactNode;
  /** 底部操作行；split 布局中位于右侧主区底部。 */
  footer?: ReactNode;
  children: ReactNode;
  layout?: "split" | "content" | "confirm";
  /** 用于已打开窗口之上的嵌套弹窗。 */
  raised?: boolean;
  ariaLabel?: string;
  className?: string;
  bodyClassName?: string;
};

export function ModalShell({
  open = true,
  onClose,
  title,
  subtitle,
  sidebar,
  sidebarFooter,
  actions,
  footer,
  children,
  layout = "split",
  raised = false,
  ariaLabel,
  className,
  bodyClassName,
}: ModalShellProps) {
  useEscapeClose(onClose, open);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = panel.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? panel).focus();

    // Tab 循环限制在弹窗内，关闭后焦点回到触发元素。
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", trap);
    return () => {
      panel.removeEventListener("keydown", trap);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const isSplit = layout === "split";

  return (
    <div
      className={[styles.overlay, raised ? styles.raised : ""].filter(Boolean).join(" ")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        tabIndex={-1}
        className={[styles.panel, styles[layout], className ?? ""].filter(Boolean).join(" ")}
      >
        {isSplit ? (
          <>
            <aside className={styles.sidebar}>
              <div className={styles.sidebarHeader}>
                <div className={styles.headerMain}>
                  <div id={titleId} className={styles.title}>
                    {title}
                  </div>
                  {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
                </div>
              </div>
              <div className={`${styles.sidebarBody} app-scrollbar`}>{sidebar}</div>
              {sidebarFooter ? <div className={styles.sidebarFooter}>{sidebarFooter}</div> : null}
            </aside>
            <main className={styles.main}>
              <div className={styles.header}>
                {actions ?? <div className={styles.headerMain} />}
                <Button
                  variant="iconButton"
                  size="sm"
                  icon="close"
                  aria-label="关闭"
                  onClick={onClose}
                />
              </div>
              <div className={[styles.body, "app-scrollbar", bodyClassName ?? ""].filter(Boolean).join(" ")}>
                {children}
              </div>
              {footer ? <div className={styles.footer}>{footer}</div> : null}
            </main>
          </>
        ) : (
          <>
            <div className={styles.header}>
              <div className={styles.headerMain}>
                <div id={titleId} className={styles.title}>
                  {title}
                </div>
                {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
              </div>
              {actions}
              <Button variant="iconButton" size="sm" icon="close" aria-label="关闭" onClick={onClose} />
            </div>
            <div className={[styles.body, "app-scrollbar", bodyClassName ?? ""].filter(Boolean).join(" ")}>
              {children}
            </div>
            {footer ? <div className={styles.footer}>{footer}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
