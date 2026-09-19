"use client";

import { useState } from "react";
import {
  Clipboard,
  Copy,
  FolderOpen,
  Moon,
  Pin,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import styles from "./page.module.css";

type Theme = "light" | "dark";
type Variant = "mist" | "rim" | "refraction" | "ink";

const variants: Array<{
  id: Variant;
  index: string;
  name: string;
  detail: string;
}> = [
  { id: "mist", index: "A", name: "黑曜薄雾", detail: "均衡黑度 / 柔和通透" },
  { id: "rim", index: "B", name: "液态边缘", detail: "流动高光 / 立体轮廓" },
  { id: "refraction", index: "C", name: "深水折射", detail: "不规则明暗 / 强材质感" },
  { id: "ink", index: "D", name: "系统磨砂", detail: "原生层次 / 系统蓝高亮" },
];

const menuItems: Array<{
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  divider?: boolean;
}> = [
  { label: "复制相对路径", icon: Copy },
  { label: "复制绝对路径", icon: Clipboard, shortcut: "⌥⌘C" },
  { label: "在 Finder 中显示", icon: FolderOpen, divider: true },
  { label: "固定到侧边栏", icon: Pin },
];

function MenuPreview({ variant, theme }: { variant: Variant; theme: Theme }) {
  return (
    <div className={`${styles.stage} ${styles[theme]}`}>
      <div className={styles.workspaceLine} />
      <div className={`${styles.menu} ${styles[variant]}`} role="menu" aria-label={`${variant} 右键菜单预览`}>
        {menuItems.map(({ label, icon: Icon, shortcut, divider }) => (
          <div key={label} className={divider ? styles.groupStart : undefined}>
            <button className={styles.menuItem} type="button" role="menuitem">
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{label}</span>
              {shortcut && <kbd>{shortcut}</kbd>}
            </button>
          </div>
        ))}
        <div className={styles.groupStart}>
          <button className={`${styles.menuItem} ${styles.danger}`} type="button" role="menuitem">
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>移除引用</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ContextMenuLabPage() {
  const [theme, setTheme] = useState<Theme>("dark");

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>DeerHux / UI Lab</p>
          <h1>右键菜单背景</h1>
          <p className={styles.intro}>黑色 Liquid Glass 的四种透明度与折射强度。</p>
        </div>
        <div className={styles.segmented} aria-label="预览主题">
          <button type="button" className={theme === "light" ? styles.active : undefined} onClick={() => setTheme("light")} aria-pressed={theme === "light"}>
            <Sun size={14} aria-hidden="true" />
            浅色
          </button>
          <button type="button" className={theme === "dark" ? styles.active : undefined} onClick={() => setTheme("dark")} aria-pressed={theme === "dark"}>
            <Moon size={14} aria-hidden="true" />
            深色
          </button>
        </div>
      </header>

      <section className={styles.grid} aria-label="背景方案">
        {variants.map((variant) => (
          <article className={styles.option} key={variant.id}>
            <div className={styles.optionHeading}>
              <span className={styles.index}>{variant.index}</span>
              <div>
                <h2>{variant.name}</h2>
                <p>{variant.detail}</p>
              </div>
            </div>
            <MenuPreview variant={variant.id} theme={theme} />
          </article>
        ))}
      </section>
    </main>
  );
}
