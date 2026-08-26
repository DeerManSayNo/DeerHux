"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationRunSnapshot, CollaborationWorkerState, CollaborationRunStatus, CollaborationWorkerStatus, SubagentWorkflow, WorkerToolActivity } from "@/lib/parallel-agent/collaboration-types";

interface Props {
  run: CollaborationRunSnapshot;
  onOpenSession?: (sessionId: string) => void;
  onRunUpdate?: (run: CollaborationRunSnapshot) => void;
}

type AnyRunStatus = CollaborationRunStatus | CollaborationWorkerStatus;

function statusColor(status?: AnyRunStatus): string {
  switch (status) {
    case "complete":
    case "applied":
      return "#16a34a";
    case "error":
    case "aborted":
      return "#f87171";
    case "running":
    case "setting_up":
    case "applying":
      return "#3b82f6";
    default:
      return "var(--text-dim)";
  }
}

function statusLabel(status?: AnyRunStatus): string {
  switch (status) {
    case "complete": return "完成";
    case "applied": return "已应用";
    case "error": return "失败";
    case "aborted": return "已中止";
    case "running": return "运行中";
    case "setting_up": return "准备中";
    case "applying": return "应用中";
    case "pending": return "等待中";
    default: return status ?? "未知";
  }
}

/**
 * 在触发 subagent 的消息下方展示 subagent 小卡片。
 *
 * 每个 subagent 一张卡片：实时展示状态 + 当前工具调用 + 输出摘要，
 * 可点击跳转打开对应 worker session（在新 tab 查看完整对话）。
 * worker session 仍不在左侧 session 列表展示。
 */
// 注入工具活动脉动动画（仅一次）
let toolPulseStyleInjected = false;
function injectToolPulseStyle() {
  if (typeof document === "undefined" || toolPulseStyleInjected) return;
  toolPulseStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes tool-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .subagent-cards-scroll {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .subagent-cards-scroll::-webkit-scrollbar {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

export function SubagentRunCard({ run, onOpenSession }: Props) {
  // 注入 CSS 动画
  useEffect(() => { injectToolPulseStyle(); }, []);

  const latest = run;
  const workers = useMemo(() => latest.workers ?? [], [latest.workers]);
  const doneCount = useMemo(
    () => workers.filter((w) => w.status === "complete" || w.status === "error" || w.status === "aborted").length,
    [workers],
  );
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const [cardFade, setCardFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = cardsScrollRef.current;
    if (!el) return;
    const update = () => {
      const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      setCardFade({
        left: el.scrollLeft > 1,
        right: maxScrollLeft > 1 && el.scrollLeft < maxScrollLeft - 1,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [workers.length]);

  const cardsMaskImage = cardFade.left && cardFade.right
    ? "linear-gradient(to right, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%)"
    : cardFade.left
      ? "linear-gradient(to right, transparent 0, #000 28px, #000 100%)"
      : cardFade.right
        ? "linear-gradient(to right, #000 0, #000 calc(100% - 28px), transparent 100%)"
        : "none";

  if (workers.length === 0) return null;

  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <RunSummaryTag title={latest.title ?? "Subagents"} status={latest.status} text={`Subagents ${doneCount}/${workers.length}`} workflow={latest.workflow} />
      {/* 横向单行排列，不换行；宽度不足时横向滚动；只在可滚动方向做边缘渐隐 */}
      <div
        ref={cardsScrollRef}
        className="subagent-cards-scroll"
        style={{
          display: "flex",
          gap: 10,
          overflowX: "auto",
          overflowY: "hidden",
          flexWrap: "nowrap",
          // 横向滚动容器会裁切纵向溢出；为 hover 上浮和阴影预留空间。
          padding: "8px 0",
          WebkitMaskImage: cardsMaskImage,
          maskImage: cardsMaskImage,
        }}
      >
        {workers.map((worker) => (
          <WorkerCard
            key={worker.workerId ?? worker.name}
            worker={worker}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </div>
  );
}

/** 顶部总状态徽标 */
function RunSummaryTag({ title, status, text, workflow }: { title: string; status: CollaborationRunStatus; text: string; workflow?: SubagentWorkflow }) {
  const color = statusColor(status);
  const workflowLabel = workflow ? WORKFLOW_LABELS[workflow] : undefined;
  return (
    <span
      title={`${title} · ${statusLabel(status)}${workflowLabel ? ` · ${workflowLabel}` : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${color}44`,
        background: `${color}12`,
        color,
        borderRadius: 999,
        padding: "3px 10px",
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.2,
        alignSelf: "flex-start",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {text}
      {workflowLabel && (
        <span style={{ color: "var(--text-dim)", fontWeight: 600, marginLeft: 1 }}>
          · {workflowLabel}
        </span>
      )}
    </span>
  );
}

const MODE_LABELS: Partial<Record<string, string>> = {
  ask: "分析",
  code: "编码",
  parallel: "并行",
  review: "审查",
  custom: "自定义",
};

/** run 级编排模式标签（worker 之间怎么调度，与 taskMode 正交）。 */
const WORKFLOW_LABELS: Record<SubagentWorkflow, string> = {
  parallel: "并行",
  sequential: "串行",
  pipeline: "流水线",
  dag: "依赖图",
};

/** 单个 subagent 卡牌：竖向卡牌布局，实时展示状态 + 任务 + 工具调用 + 输出 */
function WorkerCard({ worker, onOpenSession }: {
  worker: CollaborationWorkerState;
  onOpenSession?: (sessionId: string) => void;
}) {
  const color = statusColor(worker.status);
  const label = worker.title ?? worker.name;
  const isRunning = worker.status === "running";
  const isTerminal = worker.status === "complete" || worker.status === "error" || worker.status === "aborted";
  // sessionId 只会在服务端确认 prompt 已 accepted、设定消息已持久化后暴露。
  // 在此之前必须阻断点击，避免打开 (no messages) 的空 worker 会话。
  const canClick = Boolean(onOpenSession && worker.sessionId);
  const modeLabel = worker.agentType ? MODE_LABELS[worker.agentType] : undefined;
  const [hovered, setHovered] = useState(false);

  // 任务描述（instructions 优先，回退 task）
  const taskText = (worker.instructions?.trim() || worker.task?.trim() || "").slice(0, 280);

  // 运行中的工具列表：当前活动工具 + 最近完成（最多 4 条）
  const toolList = isRunning
    ? [worker.activeTool, ...(worker.recentTools ?? []).slice(0, 3)].filter(Boolean) as WorkerToolActivity[]
    : [];

  // 完成态展示的工具简史（最近 3 条）
  const history = isTerminal ? (worker.recentTools ?? []).slice(0, 3) : [];

  return (
    <div
      onClick={canClick ? () => onOpenSession!(worker.sessionId!) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 288,
        minHeight: 208,
        flexShrink: 0,
        borderRadius: 12,
        border: `1px solid ${hovered && canClick ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
        background: "var(--bg-hover)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: canClick ? "pointer" : "default",
        transition: "border-color 0.14s, box-shadow 0.14s, transform 0.14s",
        boxShadow: hovered && canClick ? "0 6px 18px rgba(0,0,0,0.14)" : "0 1px 3px rgba(0,0,0,0.05)",
        transform: hovered && canClick ? "translateY(-2px)" : "none",
      }}
    >
      {/* header：状态点 + 名称 + 模式 + 状态 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            animation: isRunning ? "tool-pulse 1.4s ease-in-out infinite" : "none",
            boxShadow: isRunning ? `0 0 0 3px ${color}22` : "none",
          }}
        />
        <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {label}
        </span>
        {modeLabel && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 5px", flexShrink: 0, lineHeight: 1.6 }}>
            {modeLabel}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color, fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{statusLabel(worker.status)}</span>
      </div>

      {/* 任务描述 */}
      {taskText && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-dim)",
            lineHeight: 1.5,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            fontStyle: "italic",
          }}
        >
          {taskText}
        </span>
      )}

      {/* body 区：撑满剩余高度，让卡牌呈竖向比例 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        {/* 运行中：工具调用列表 */}
        {isRunning && toolList.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {toolList.map((tool, i) => (
              <ToolItem key={`${tool.ts}-${i}`} tool={tool} dim={i > 0} />
            ))}
          </div>
        )}
        {isRunning && toolList.length === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--text-dim)", fontStyle: "italic", padding: "2px 0" }}>思考中…</span>
        )}

        {/* 失败：错误信息 */}
        {worker.status === "error" && worker.error && (
          <span style={{ fontSize: 11.5, color: "#f87171", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}>
            {worker.error}
          </span>
        )}

        {/* 完成：结果摘要 + 工具简史 + 变更统计 */}
        {isTerminal && worker.result && (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word" }}>
            {worker.result}
          </span>
        )}
        {isTerminal && history.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
            {history.map((tool, i) => (
              <ToolItem key={`h-${tool.ts}-${i}`} tool={tool} dim />
            ))}
          </div>
        )}
        {worker.diffStats && (
          <span style={{ fontSize: 10.5, color: "#16a34a", fontWeight: 600, marginTop: 2 }}>📊 {worker.diffStats}</span>
        )}
        {worker.appliedFiles && worker.appliedFiles.length > 0 && (
          <span style={{ fontSize: 10.5, color: "#16a34a", fontWeight: 600 }}>✓ 已应用 {worker.appliedFiles.length} 个文件</span>
        )}
      </div>

      {/* footer：跳转提示 */}
      {Boolean(onOpenSession && (canClick || worker.status === "pending" || isRunning)) && (
        <span style={{ fontSize: 10.5, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 3, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
          {canClick ? "↗ 点击查看完整会话" : "正在整理并发送任务…"}
        </span>
      )}
    </div>
  );
}

/** 工具调用列表项：状态图标 + 工具名 + 文件/命令摘要 */
function ToolItem({ tool, dim }: { tool: WorkerToolActivity; dim?: boolean }) {
  const isRunning = tool.status === "running";
  const icon = tool.status === "running" ? "●" : tool.status === "error" ? "✕" : "✓";
  const iconColor = tool.status === "running" ? "#3b82f6" : tool.status === "error" ? "#f87171" : "#16a34a";
  const summary = tool.summary.trim() || "无文件/命令摘要";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        borderRadius: 6,
        background: isRunning ? "rgba(59, 130, 246, 0.1)" : "transparent",
        border: isRunning ? "1px solid rgba(59, 130, 246, 0.2)" : "1px solid transparent",
        fontSize: 11,
        minWidth: 0,
        opacity: dim ? 0.72 : 1,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: iconColor,
          flexShrink: 0,
          fontWeight: 700,
          animation: isRunning ? "tool-pulse 1.4s ease-in-out infinite" : "none",
        }}
      >
        {icon}
      </span>
      <span style={{ fontWeight: 600, color: isRunning ? "#2563eb" : "var(--text-muted)", flexShrink: 0 }}>{tool.toolName}</span>
      <span
        title={summary}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-muted)",
          minWidth: 0,
        }}
      >
        {summary}
      </span>
    </div>
  );
}
