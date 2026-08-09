"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import type {
  AgentMessage,
  FileReference,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";
import { SubagentRunCard } from "./SubagentRunCard";

/** 终态集合：只有这些状态的 run 才沉淀到触发它的 user 消息下方作为历史记录；
 * 活跃中的 run 由 ChatWindow 钉在聊天流最底部。 */
const TERMINAL_RUN_STATUSES = new Set(["complete", "aborted", "error", "applied"]);

interface WatchdogInfo {
  eventIdleMs: number;
  contentIdleMs: number;
  eventThresholdMs: number;
  contentThresholdMs: number;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  watchdogInfo?: WatchdogInfo | null;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  showTimestamp?: boolean;
  /** 该消息是否是所属 user turn 的最后一条 assistant。 */
  showTurnDuration?: boolean;
  prevTimestamp?: number;
  /** 当前 user turn 的开始/结束时间，用于展示整轮总耗时。 */
  turnStartTimestamp?: number;
  turnEndTimestamp?: number;
  /** 当前页面运行态冻结下来的整轮耗时；优先于时间戳推算。 */
  turnDurationSeconds?: number;
  nextUserTimestamp?: number;
  onResend?: (message: string, entryId?: string, references?: FileReference[], skill?: UserMessage["skill"]) => void;
  onRetryDelivery?: (message: UserMessage) => void;
  onRestoreToInput?: (message: UserMessage) => void;
  systemPrompt?: string | null;
  /** subagent 协作 run 快照（来自父 session 的 custom entry）。 */
  collaborationRuns?: CollaborationRunSnapshot[];
  /** 当前 user turn 覆盖的所有消息 entry id，用于精确关联 subagent。 */
  turnEntryIds?: string[];
  onOpenSession?: (sessionId: string) => void;
  onCollaborationRunUpdate?: (run: CollaborationRunSnapshot) => void;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

function MessageViewImpl({ message, isStreaming, toolResults, modelNames, watchdogInfo, entryId, onFork, forking, showTimestamp, showTurnDuration, prevTimestamp, turnStartTimestamp, turnEndTimestamp, turnDurationSeconds, nextUserTimestamp, onResend, onRetryDelivery, onRestoreToInput, systemPrompt, collaborationRuns, turnEntryIds, onOpenSession, onCollaborationRunUpdate }: Props) {
  // 新 run 用 parentEntryId 精确归属到触发它的 user turn；旧数据没有该字段时，
  // 才保留 createdAt 时间窗作为兼容兜底。
  const rawTs = message.role === "user" ? (message as UserMessage).timestamp : undefined;
  const userTs = typeof rawTs === "number" ? rawTs : (rawTs ? Date.parse(rawTs) : NaN);
  const turnEntryIdSet = useMemo(() => new Set(turnEntryIds ?? []), [turnEntryIds]);
  const linkedRuns = useMemo(() => {
    if (message.role !== "user") return [];
    if (!collaborationRuns || collaborationRuns.length === 0) return [];
    // 只归属已终结的 run。活跃中的 run 统一由 ChatWindow 钉在聊天流最底部跟随
    // 最新消息，避免同一 run 同时出现在历史 user 消息下方和底部造成重复。
    return collaborationRuns
      .filter((r) => {
        if (!TERMINAL_RUN_STATUSES.has(r.status)) return false;
        if (r.parentEntryId) return turnEntryIdSet.has(r.parentEntryId);
        if (!userTs || Number.isNaN(userTs)) return false;
        const created = Date.parse(r.createdAt);
        if (Number.isNaN(created)) return false;
        if (created < userTs || (nextUserTimestamp && created >= nextUserTimestamp)) return false;
        return true;
      })
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [message.role, collaborationRuns, turnEntryIdSet, userTs, nextUserTimestamp]);
  if (message.role === "user") {
    return (
      <>
        <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onResend={onResend} onRetryDelivery={onRetryDelivery} onRestoreToInput={onRestoreToInput} systemPrompt={systemPrompt} />
        {linkedRuns.length > 0 && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {linkedRuns.map((run) => (
              <SubagentRunCard key={run.runId} run={run} onOpenSession={onOpenSession} onRunUpdate={onCollaborationRunUpdate} />
            ))}
          </div>
        )}
      </>
    );
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} watchdogInfo={watchdogInfo} showTimestamp={showTimestamp} showTurnDuration={showTurnDuration} prevTimestamp={prevTimestamp} turnStartTimestamp={turnStartTimestamp} turnEndTimestamp={turnEndTimestamp} turnDurationSeconds={turnDurationSeconds} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  return null;
}

export const MessageView = memo(MessageViewImpl, (prev, next) => (
  prev.message === next.message &&
  prev.isStreaming === next.isStreaming &&
  prev.toolResults === next.toolResults &&
  prev.modelNames === next.modelNames &&
  prev.watchdogInfo === next.watchdogInfo &&
  prev.entryId === next.entryId &&
  prev.onFork === next.onFork &&
  prev.forking === next.forking &&
  prev.showTimestamp === next.showTimestamp &&
  prev.showTurnDuration === next.showTurnDuration &&
  prev.prevTimestamp === next.prevTimestamp &&
  prev.turnStartTimestamp === next.turnStartTimestamp &&
  prev.turnEndTimestamp === next.turnEndTimestamp &&
  prev.turnDurationSeconds === next.turnDurationSeconds &&
  prev.nextUserTimestamp === next.nextUserTimestamp &&
  prev.onResend === next.onResend &&
  prev.onRetryDelivery === next.onRetryDelivery &&
  prev.onRestoreToInput === next.onRestoreToInput &&
  prev.systemPrompt === next.systemPrompt &&
  prev.collaborationRuns === next.collaborationRuns &&
  prev.turnEntryIds === next.turnEntryIds &&
  prev.onOpenSession === next.onOpenSession &&
  prev.onCollaborationRunUpdate === next.onCollaborationRunUpdate
));

/** Parse /skill:name prefix from message text. Returns { skillName, rest } or null. */
function parseSkillPrefix(text: string): { skillName: string; rest: string } | null {
  const match = text.match(/^\/skill:([\w-]+)(?:\s|$)([\s\S]*)/);
  if (!match) return null;
  return { skillName: match[1], rest: match[2] };
}

function fileReferenceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function unescapeInlineCode(text: string): string {
  return text.replace(/\\`/g, "`");
}

/** Parse the reference block prepended by ChatInput, keeping the visible message body clean. */
function parseReferencePrefix(text: string): { references: string[]; rest: string } | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "引用文件/文件夹：") return null;

  const references: string[] = [];
  let index = 1;
  while (index < lines.length) {
    const match = lines[index].match(/^- `((?:\\`|[^`])*)`$/);
    if (!match) break;
    references.push(unescapeInlineCode(match[1]));
    index += 1;
  }

  if (references.length === 0) return null;
  if (lines[index] === "") index += 1;
  return { references, rest: lines.slice(index).join("\n") };
}

function UserMessageView({ message, entryId, onResend, onRetryDelivery, onRestoreToInput, systemPrompt }: {
  message: UserMessage;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onResend?: (message: string, entryId?: string, references?: FileReference[], skill?: UserMessage["skill"]) => void;
  onRetryDelivery?: (message: UserMessage) => void;
  onRestoreToInput?: (message: UserMessage) => void;
  systemPrompt?: string | null;
}) {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  // Extract sent-time references and /skill:name prefix for tag display.
  const referencePrefix = useMemo(() => parseReferencePrefix(content), [content]);
  const displayReferences: FileReference[] = useMemo(() => {
    if (message.references?.length) return message.references;
    return referencePrefix?.references.map((path) => ({ path, name: fileReferenceName(path) })) ?? [];
  }, [message.references, referencePrefix]);
  const contentWithoutReferences = message.references?.length ? content : referencePrefix ? referencePrefix.rest : content;
  const skillPrefix = useMemo(() => parseSkillPrefix(contentWithoutReferences), [contentWithoutReferences]);
  const displaySkillName = message.skill?.name ?? skillPrefix?.skillName;
  const displayContent = skillPrefix ? skillPrefix.rest : contentWithoutReferences;

  const [expanded, setExpanded] = useState(false);
  const [editValue, setEditValue] = useState(content);
  const [showSystemPromptModal, setShowSystemPromptModal] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canResend = !!onResend && !!entryId;

  useEffect(() => {
    setEditValue(content);
  }, [content]);

  const resizeTextarea = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 24), 200)}px`;
  };

  useEffect(() => {
    if (expanded) requestAnimationFrame(resizeTextarea);
  }, [expanded, editValue]);

  const handleCancel = () => {
    setEditValue(content);
    setExpanded(false);
  };

  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (event: PointerEvent) => {
      const editor = editorRef.current;
      if (!editor) return;
      if (event.target instanceof Node && !editor.contains(event.target)) {
        setEditValue(content);
        setExpanded(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expanded, content]);

  // Escape key to close system prompt modal
  useEffect(() => {
    if (!showSystemPromptModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSystemPromptModal(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSystemPromptModal]);

  const handleSendEdit = () => {
    const trimmed = editValue.trim();
    if (!trimmed) return;
    onResend?.(trimmed, entryId, displayReferences.length ? displayReferences : undefined, message.skill);
    setExpanded(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  const renderImages = () => imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: content ? 10 : 0 }}>
      {imageBlocks.map((img, i) => {
        // URL/file path images: load directly from the API — no data bloat.
        if (img.source?.type === "url" && img.source.url) {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={img.source.url}
              alt=""
              style={{
                maxWidth: 300, maxHeight: 280,
                borderRadius: 8,
                objectFit: "contain",
                display: "block",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
              onClick={() => window.open(img.source!.url, "_blank")}
            />
          );
        }
        if (img._stripped) {
          // Image data was stripped on the server to keep the API response lean.
          // Show a lightweight placeholder so the user knows an image was attached.
          return (
            <div
              key={i}
              style={{
                width: 200, height: 140,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "color-mix(in srgb, var(--bg-panel) 60%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                gap: 6,
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              历史图片（已压缩）
            </div>
          );
        }
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : "";
        if (!src) {
          return (
            <div
              key={i}
              style={{
                width: 200, height: 140,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "color-mix(in srgb, var(--bg-panel) 60%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-dim)",
                fontSize: 12,
              }}
            >
              图片
            </div>
          );
        }
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={src}
            alt=""
            style={{ maxWidth: 260, maxHeight: 220, borderRadius: 8, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
          />
        );
      })}
    </div>
  );

  const renderSystemPromptChip = () => {
    if (systemPrompt === undefined) return null;
    const isClickable = systemPrompt !== null && systemPrompt !== "";
    return (
      <span
        title={systemPrompt === null ? "系统提示词加载中" : systemPrompt || "（空）"}
        onClick={isClickable ? () => setShowSystemPromptModal(true) : undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 24,
          padding: "0 9px",
          borderRadius: 999,
          background: "color-mix(in srgb, var(--bg-panel) 84%, transparent)",
          border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
          color: "var(--text-muted)",
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: "nowrap",
          cursor: isClickable ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        系统提示词
      </span>
    );
  };

  const renderReferenceChips = () => {
    if (displayReferences.length === 0) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.4 }}>引用</span>
        {displayReferences.map((ref, index) => (
          <span
            key={`${ref.path}-${index}`}
            title={ref.path}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              maxWidth: 220,
              height: 24,
              padding: "0 8px",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--accent) 6%, var(--bg))",
              border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
              color: "color-mix(in srgb, var(--accent) 62%, var(--text-muted))",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ref.name}
            </span>
          </span>
        ))}
      </div>
    );
  };

  const hasSideMeta = systemPrompt !== undefined || displayReferences.length > 0;

  return (
    <div style={{ marginBottom: 24, display: "flex", justifyContent: "center", width: "100%" }}>
      <div
        style={{
          width: "min(100%, 72rem)",
        }}
      >
      {hasSideMeta && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 6,
            minWidth: 0,
          }}
        >
          <div style={{ flexShrink: 0 }}>{renderSystemPromptChip()}</div>
          <div style={{ minWidth: 0 }}>{renderReferenceChips()}</div>
        </div>
      )}
      {!expanded ? (
        <button
          type="button"
          onClick={() => canResend && setExpanded(true)}
          title={canResend ? "点击编辑并重新发送" : undefined}
          style={{
            width: "100%",
            display: "block",
            textAlign: "left",
            padding: "10px 14px",
            background: "var(--bg)",
            border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
            borderRadius: 14,
            color: "var(--text)",
            cursor: canResend ? "pointer" : "default",
            font: "inherit",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
            transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
          }}
          onMouseEnter={(e) => {
            if (!canResend) return;
            e.currentTarget.style.borderColor = "rgba(148,163,184,0.55)";
            e.currentTarget.style.boxShadow = "0 0 0 1px rgba(148,163,184,0.12)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.boxShadow = "none";
          }}
        >
          {renderImages()}
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.6,
              fontWeight: 400,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {displaySkillName && (
              <span
                title={`使用了技能: ${displaySkillName}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  marginRight: 5,
                  verticalAlign: "middle",
                  height: 22,
                  padding: "0 7px 0 7px",
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--accent) 6%, var(--bg))",
                  border: "1px solid color-mix(in srgb, var(--accent) 13%, transparent)",
                  color: "color-mix(in srgb, var(--accent) 55%, var(--text-muted))",
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "currentColor",
                    opacity: 0.45,
                    flexShrink: 0,
                  }}
                />
                {displaySkillName}
              </span>
            )}
            {displayContent}
          </div>
        </button>
      ) : (
        <div
          ref={editorRef}
          style={{
            width: "100%",
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "var(--bg)",
            border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
            borderRadius: 14,
            padding: "10px 10px 10px 14px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
            transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {renderImages()}
            <textarea
              ref={textareaRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              autoFocus
              style={{
                width: "100%",
                minHeight: 24,
                maxHeight: 200,
                padding: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                resize: "none",
                overflow: "auto",
                color: "var(--text)",
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: 400,
                lineHeight: 1.6,
              }}
            />
          </div>

            <button
              type="button"
              onClick={handleCancel}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                padding: "7px 10px",
                background: "none",
                border: "none",
                borderRadius: 8,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: "-0.01em",
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSendEdit}
              disabled={!editValue.trim()}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: editValue.trim() ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 8,
                color: editValue.trim() ? "#fff" : "var(--text-dim)",
                cursor: editValue.trim() ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: editValue.trim() ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
              title="发送"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              发送
            </button>
        </div>
      )}
      {message.deliveryState && message.deliveryState !== "accepted" && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginTop: 7,
            padding: "7px 10px",
            borderRadius: 9,
            border: `1px solid ${message.deliveryState === "failed" ? "color-mix(in srgb, #ef4444 35%, var(--border))" : "var(--border)"}`,
            background: message.deliveryState === "failed"
              ? "color-mix(in srgb, #ef4444 7%, var(--bg))"
              : "color-mix(in srgb, var(--bg-panel) 70%, var(--bg))",
            color: message.deliveryState === "failed" ? "#ef4444" : "var(--text-muted)",
            fontSize: 12,
          }}
          title={message.deliveryError}
        >
          <span>
            {message.deliveryState === "submitting" && "正在确认服务端接收…"}
            {message.deliveryState === "unknown" && "暂时无法确认是否已接收，安全重试不会重复执行"}
            {message.deliveryState === "failed" && `发送失败${message.deliveryError ? `：${message.deliveryError}` : ""}`}
          </span>
          {(message.deliveryState === "unknown" || message.deliveryState === "failed") && (
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {onRestoreToInput && (
                <button type="button" onClick={() => onRestoreToInput(message)} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: "2px 4px", fontWeight: 600 }}>
                  恢复到输入框
                </button>
              )}
              {onRetryDelivery && (
                <button type="button" onClick={() => onRetryDelivery(message)} style={{ border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", padding: "3px 7px", fontWeight: 600 }}>
                  安全重试
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {showSystemPromptModal && systemPrompt && (
        <div
          onClick={() => setShowSystemPromptModal(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.35)", padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(800px, calc(100vw - 40px))",
              maxHeight: "min(700px, calc(100vh - 40px))",
              border: "1px solid var(--border)",
              borderRadius: 16,
              background: "var(--bg)",
              boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>系统提示词</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(systemPrompt ?? "");
                  }}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "6px 12px",
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  复制
                </button>
                <button
                  type="button"
                  onClick={() => setShowSystemPromptModal(false)}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                  title="关闭"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
            <div
              style={{
                overflow: "auto",
                padding: "18px",
                fontSize: 13,
                lineHeight: 1.7,
                color: "var(--text)",
                fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                flex: 1,
              }}
            >
              {systemPrompt}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  watchdogInfo,
  showTimestamp,
  showTurnDuration,
  prevTimestamp,
  turnStartTimestamp,
  turnEndTimestamp,
  turnDurationSeconds,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  watchdogInfo?: WatchdogInfo | null;
  showTimestamp?: boolean;
  showTurnDuration?: boolean;
  prevTimestamp?: number;
  turnStartTimestamp?: number;
  turnEndTimestamp?: number;
  turnDurationSeconds?: number;
}) {
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blocks = message.content ?? [];
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // 整轮总耗时统一按 user message 开始 → 本轮最后一条持久化消息结束计算。
  // 只有本轮最后一条 assistant 显示，避免多段 assistant/tool 循环重复计时。
  const totalDurationFromFile = useMemo<number | undefined>(() => {
    if (showTurnDuration && turnDurationSeconds !== undefined) return turnDurationSeconds;
    if (!showTurnDuration || !turnStartTimestamp || !turnEndTimestamp) return undefined;
    return Math.max(0, Math.round((turnEndTimestamp - turnStartTimestamp) / 1000));
  }, [showTurnDuration, turnDurationSeconds, turnStartTimestamp, turnEndTimestamp]);

  // 单条 assistant 的思考耗时仍使用上一条消息 → 当前 assistant，不能拿整轮耗时替代。
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Start elapsed timer immediately, even before the first text delta, so
      // remote sessions (WeChat Bot etc.) show the same “正在生成 / 耗时 x 秒” feel.
      const streamStart = streamStartRef.current ?? now;
      streamStartRef.current = streamStart;
      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      const elapsed = (now - streamStart) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div
      style={{ marginBottom: 16 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title="预估 token 数（流式接收中）">
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const bg = tps >= 50 ? "#53b3cb" : tps >= 30 ? "#9bc53d" : tps >= 15 ? "#f9c22e" : "#e01a4f";
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: bg, color: "#fff", fontSize: 11, fontWeight: 400 }}>
                        {tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                  {watchdogInfo && (() => {
                    const eventLeft = Math.max(0, Math.ceil((watchdogInfo.eventThresholdMs - watchdogInfo.eventIdleMs) / 1000));
                    const contentLeft = Math.max(0, Math.ceil((watchdogInfo.contentThresholdMs - watchdogInfo.contentIdleMs) / 1000));
                    const eventTriggered = watchdogInfo.eventIdleMs >= watchdogInfo.eventThresholdMs;
                    const contentTriggered = watchdogInfo.contentIdleMs >= watchdogInfo.contentThresholdMs;
                    const color = eventTriggered || contentTriggered ? "#e01a4f" : eventLeft <= 10 || contentLeft <= 10 ? "#f9c22e" : "var(--text-dim)";
                    return (
                      <span
                        title={`业务事件静默 ${Math.floor(watchdogInfo.eventIdleMs / 1000)}s / ${Math.floor(watchdogInfo.eventThresholdMs / 1000)}s；内容停滞 ${Math.floor(watchdogInfo.contentIdleMs / 1000)}s / ${Math.floor(watchdogInfo.contentThresholdMs / 1000)}s`}
                        style={{ marginLeft: 6, color, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                      >
                        事件 {eventTriggered ? "检查中" : `${eventLeft}s`} · 内容 {contentTriggered ? "检查中" : `${contentLeft}s`}
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {blocks.map((block, i) => {
          // 失败消息会同时写入 text + errorMessage；UI 只展示红色错误框，避免重复。
          if (
            !isStreaming
            && message.errorMessage
            && block.type === "text"
            && (block as TextContent).text === message.errorMessage
          ) {
            return null;
          }
          return (
            <BlockView
              key={i}
              block={block}
              toolResults={toolResults}
              streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)}
              toolCallDurations={toolCallDurations}
              isStreaming={isStreaming}
            />
          );
        })}
        {!isStreaming && (message.errorMessage || message.stopReason === "error") && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              color: "rgba(200,60,60,0.95)",
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {message.errorMessage
              || "模型以错误状态结束，但没有返回具体错误信息。"}
          </div>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 4,
      }}>
        {message.usage && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {formatUsage(message.usage)}
          </div>
        )}
        {totalDurationFromFile !== undefined && !isStreaming && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            总耗时 {formatCompactDuration(totalDurationFromFile)}
          </div>
        )}
        {textContent && !isStreaming && (
          <button
            onClick={copyContent}
            title="Copy message"
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 8px", height: 22,
              background: "none", border: "none",
              borderRadius: 5,
              color: copied ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11, fontWeight: 400,
              whiteSpace: "nowrap",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? "已复制" : "复制"}
          </button>
        )}
        {time && !isStreaming && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, streamingDuration, toolCallDurations, isStreaming }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; streamingDuration?: number; toolCallDurations?: Map<string, number>; isStreaming?: boolean }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} isStreaming={isStreaming} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} />;
  }
  return null;
}

function TextBlock({ block }: { block: TextContent }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          code({ className, children, ...props }) {
            const lang = className?.replace("language-", "") ?? "";
            const raw = String(children);
            const isBlock = className?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
            }
            return (
              <code
                style={{
                  background: "var(--bg-selected)",
                  padding: "1px 4px",
                  borderRadius: 3,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.9em",
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre({ children }) {
            // Unwrap <pre> wrapper — CodeBlock handles its own container
            return <>{children}</>;
          },
        }}
      >
        {block.text}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBlock({ block, duration, isStreaming }: { block: ThinkingContent; duration?: number; isStreaming?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Auto-follow the latest streaming output, like a terminal tail.
  // Only sticks while streaming, and only if the user hasn't scrolled up
  // to read earlier content. Scrolling back near the bottom re-enables it.
  useEffect(() => {
    if (!isStreaming) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [block.thinking, isStreaming]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 32;
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 10px",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        <span>思考过程</span>
        {duration !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          maxHeight: 200,
          overflowY: "auto",
          padding: "8px 10px",
          color: "var(--text-muted)",
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          background: "var(--bg-panel)",
          borderTop: "1px solid var(--border)",
        }}
      >
        {block.thinking}
      </div>
    </div>
  );
}


function ToolCallBlock({ block, result, duration }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(34,197,94,0.25)",
        background: isError ? "rgba(248,113,113,0.05)" : "rgba(34,197,94,0.04)",
      }}
    >
      {/* ── Tool call header ── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          padding: "6px 10px",
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ color: isError ? "#f87171" : "#16a34a", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
          {block.toolName}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {getToolPreview(block)}
        </span>
        {duration !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{duration}s</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {/* ── Expanded: input args ── */}
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg-subtle)",
            borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
          fontSize: 12,
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: 400,
          background: "var(--bg)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          fontStyle: isEmpty ? "italic" : "normal",
          opacity: isEmpty ? 0.6 : 1,
        }}
      >
        {isEmpty ? "(无输出)" : text}
      </pre>
    </div>
  );
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatCompactDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} 输入`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} 输出`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} 缓存读取`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}



function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { isDark } = useTheme();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{
        position: "relative",
        marginTop: 4,
        marginBottom: 4,
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          padding: "3px 10px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{lang}</span>
        <button
          onClick={copy}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang || "text"}
        style={isDark ? vscDarkPlus : vs}
        showLineNumbers
        lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
        customStyle={{
          margin: 0,
          padding: "10px 12px",
          fontSize: 12.5,
          lineHeight: 1.6,
          borderRadius: 0,
          background: "var(--bg)",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
