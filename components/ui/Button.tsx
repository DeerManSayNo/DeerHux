"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AppIcon, type AppIconName } from "../AppIcon";
import styles from "./Button.module.css";

/**
 * 通用按钮。规范见 docs/design-system.md「按钮系统」。
 *
 * - variant 表达操作层级，不与尺寸混用。
 * - 图标按钮（icon-only）用 `icon` 属性 + 必填 aria-label；正文与图标同用时用 `leadingIcon`。
 * - 工具按钮（顶部工具栏、面板工具行）使用 variant="iconButton"，禁止背景块反馈。
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "iconButton";
export type ButtonSize = "md" | "sm";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 作为纯图标按钮渲染：正方形点击区、无文字。必须同时提供 aria-label。 */
  icon?: AppIconName;
  /** 图标尺寸档，默认随 size 自动取 toolbar / compact。 */
  iconSize?: "inline" | "compact" | "toolbar" | "section";
  /** 文字前置图标；纯图标按钮请改用 icon 属性。 */
  leadingIcon?: AppIconName;
  children?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconSize,
  leadingIcon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const resolvedIconSize = iconSize ?? (size === "sm" ? "compact" : "toolbar");
  const isIconOnly = Boolean(icon) && children == null;
  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    isIconOnly ? styles.icon : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classNames} {...rest}>
      {icon ? <AppIcon name={icon} size={resolvedIconSize} /> : leadingIcon ? <AppIcon name={leadingIcon} size={resolvedIconSize} /> : null}
      {children}
    </button>
  );
}
