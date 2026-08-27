"use client";

import { useEffect, useState } from "react";

// Windows/Linux 主窗口为无边框窗口（src-tauri/src/lib.rs 中 decorations(false)），
// 在左上角自绘仿 macOS 红绿灯窗口控制按钮。macOS 使用原生红绿灯、file-preview 等
// 子窗口保留系统装饰，均不渲染本组件。水平落位与 macOS 端 traffic_light_position 的
// x=14 一致；垂直与「收起侧边栏」按钮（top -1 + 高 28/2 = 中心 13）对齐，
// 左侧边栏 header 的 34px 顶部 padding 覆盖该区域的让位空间。

const MAIN_WINDOW_LABEL = "main";

function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return (userAgentData?.platform ?? navigator.platform ?? "").toUpperCase();
}

// 仅当运行在 Tauri 主窗口且平台非 macOS（已有原生红绿灯）时需要自绘窗口控制按钮。
export function useNeedsWindowControls(): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    const platform = currentPlatform();
    if (platform.includes("MAC") || platform.includes("IPHONE") || platform.includes("IPAD")) return;
    let cancelled = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (!cancelled) setNeeded(getCurrentWindow().label === MAIN_WINDOW_LABEL);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return needed;
}

// macOS 红绿灯规格：12px 圆点、中心距 20px（间距 8px）、组内 hover 才显示符号。
const BUTTON_SIZE = 12;
const BUTTON_GAP = 8;
const TRAFFIC_LIGHT_LEFT = 14;
const TRAFFIC_LIGHT_TOP = 7;

const DOT_COLORS = {
  close: { idle: "#ff5f57", hover: "#e0443d" },
  minimize: { idle: "#febc2e", hover: "#d5a11c" },
  maximize: { idle: "#28c840", hover: "#1cab32" },
} as const;

const UNFOCUSED_COLOR = "#d4d4d4";
const SYMBOL_COLOR = "rgba(0, 0, 0, 0.55)";

function CloseSymbol() {
  return (
    <svg width={BUTTON_SIZE} height={BUTTON_SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8" stroke={SYMBOL_COLOR} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MinimizeSymbol() {
  return (
    <svg width={BUTTON_SIZE} height={BUTTON_SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 6h6" stroke={SYMBOL_COLOR} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeSymbol({ rotate }: { rotate: boolean }) {
  // macOS 全屏图标：两个指向对角的双箭头折线；最大化（还原）时旋转 180°。
  return (
    <svg
      width={BUTTON_SIZE}
      height={BUTTON_SIZE}
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ transform: rotate ? "rotate(180deg)" : "none" }}
    >
      <path d="M6.9 3.1h2v2" fill="none" stroke={SYMBOL_COLOR} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.1 8.9h-2v-2" fill="none" stroke={SYMBOL_COLOR} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type DotKind = keyof typeof DOT_COLORS;

function TrafficLightDot({
  kind,
  title,
  focused,
  symbolVisible,
  symbol,
  onClick,
}: {
  kind: DotKind;
  title: string;
  focused: boolean;
  symbolVisible: boolean;
  symbol: React.ReactNode;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const colors = DOT_COLORS[kind];
  const background = !focused
    ? UNFOCUSED_COLOR
    : hovered
      ? colors.hover
      : colors.idle;

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: "50%",
        border: "0.5px solid rgba(0, 0, 0, 0.15)",
        background,
        color: "inherit",
        cursor: "default",
        flexShrink: 0,
        transition: "background 0.1s",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "flex",
          lineHeight: 0,
          opacity: focused && symbolVisible ? 1 : 0,
          transition: "opacity 0.1s",
        }}
      >
        {symbol}
      </span>
    </button>
  );
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [groupHovered, setGroupHovered] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const current = getCurrentWindow();
        const sync = () => {
          void current.isMaximized().then((value) => {
            if (!cancelled) setIsMaximized(value);
          }).catch(() => {});
        };
        try {
          unlisten = await current.onResized(sync);
        } catch {
          // ignore: keep last known state
        }
        sync();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // macOS 行为：窗口未聚焦时红绿灯整体变灰、不显示符号。
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const callWindow = (action: (current: import("@tauri-apps/api/window").Window) => unknown) => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => action(getCurrentWindow()))
      .catch(() => {});
  };

  return (
    <div
      data-tauri-drag-region="false"
      onMouseEnter={() => setGroupHovered(true)}
      onMouseLeave={() => setGroupHovered(false)}
      style={{
        position: "fixed",
        top: TRAFFIC_LIGHT_TOP,
        left: TRAFFIC_LIGHT_LEFT,
        zIndex: 9000,
        display: "flex",
        gap: BUTTON_GAP,
      }}
    >
      <TrafficLightDot
        kind="close"
        title="关闭"
        focused={focused}
        symbolVisible={groupHovered}
        symbol={<CloseSymbol />}
        onClick={() => callWindow((current) => current.close())}
      />
      <TrafficLightDot
        kind="minimize"
        title="最小化"
        focused={focused}
        symbolVisible={groupHovered}
        symbol={<MinimizeSymbol />}
        onClick={() => callWindow((current) => current.minimize())}
      />
      <TrafficLightDot
        kind="maximize"
        title={isMaximized ? "向下还原" : "最大化"}
        focused={focused}
        symbolVisible={groupHovered}
        symbol={<MaximizeSymbol rotate={isMaximized} />}
        onClick={() => callWindow((current) => current.toggleMaximize())}
      />
    </div>
  );
}
