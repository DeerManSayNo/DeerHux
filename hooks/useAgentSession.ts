"use client";

import { useState, useCallback, useRef, useEffect, useReducer, useMemo } from "react";
import { useChatAutoScroll } from "@/hooks/agent-session/useChatAutoScroll";
import { getLocalStorageItem } from "@/lib/client-storage";
import { subscribeToAppNotification } from "@/lib/app-notifications";
import type { AgentMessage, AssistantMessage, FileReference, ImageContent, SessionInfo, SkillReference, TextContent, UserMessage } from "@/lib/types";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";
import { normalizeCompletedMessage, normalizeCompletedMessages, normalizeToolCalls } from "@/lib/normalize";
import { agentEventBus } from "@/lib/agent-event-bus";
import { isAmbiguousAgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry } from "@/components/ToolPanel";
import { extractTurnMode, normalizeAgentMode, stripTurnModeContext, type AgentMode } from "@/lib/agent-modes";
import { ControlPlaneHttpError, fetchJsonWithRetry, readCachedJson, writeCachedJson } from "@/lib/client-resilience";
import { ensureAgentEventsConnected, prepareAgentEvents, subscribeAgentEvents, subscribeSessionTransient } from "@/lib/agent-event-client";
import type { SessionTransientSnapshot } from "@/lib/host-event-bus";
import {
  deleteSessionHistorySnapshot,
  getSessionHistorySnapshot,
  saveSessionHistorySnapshot,
} from "@/lib/session-history-snapshots";
import { mergeFullSessionHistory } from "@/lib/session-history-merge";

type ToolPreset = "none" | "default" | "full" | "custom";
const AUTO_CONTINUE_MESSAGE = "请从刚才中断的位置继续，不要重复已经完成的内容。如果上一步有未完成的工具调用或代码修改，请继续完成。";

function createClientMessageId(): string {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function verifyPromptAdmission(sessionId: string, clientMessageId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(sessionId)}?clientMessageId=${encodeURIComponent(clientMessageId)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!res.ok) return false;
      const body = await res.json() as { accepted?: boolean };
      return body.accepted === true;
    } finally {
      window.clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function withDeliveryState(
  message: UserMessage,
  deliveryState: UserMessage["deliveryState"],
  deliveryError?: string,
): UserMessage {
  return {
    ...message,
    deliveryState,
    ...(deliveryError ? { deliveryError } : { deliveryError: undefined }),
  };
}

/**
 * Compress expanded skill content back to /skill:name form for display.
 * The DeerHux SDK's _expandSkillCommand replaces /skill:name args with the full
 * skill file content when saving to .jsonl. This reverses that expansion
 * purely for display purposes — the model still receives the full content.
 *
 * Expanded format:
 *   <skill name="xxx" location="...">\n...\n</skill>\n\nargs
 *
 * Compressed format:
 *   /skill:xxx args
 */
function compressSkillText(text: string): string {
  const match = text.match(/^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>(?:\n\n)?([\s\S]*)$/);
  if (!match) return text;
  const skillName = match[1];
  const args = match[2].trim();
  return args ? `/skill:${skillName} ${args}` : `/skill:${skillName}`;
}

function getSdkInjectedSkillName(text: string): string | null {
  // 中文格式："使用技能：xxx"
  const cnMatch = text.match(/^使用技能[：:]\s*(\S+)\s*$/);
  if (cnMatch) return cnMatch[1].replace(/[。.]$/, "");
  // 英文格式："Use the selected skill: xxx."
  const enMatch = text.match(/^Use the selected skill:\s*(\S+)\.?\s*$/i);
  if (enMatch) return enMatch[1].replace(/[。.]$/, "");
  return null;
}

/** Strip SDK-injected skill prefix from user message content for display. */
function stripSkillInjectedPrefix(text: string): string {
  return getSdkInjectedSkillName(text) ? "" : text;
}

function userTextContent(msg: AgentMessage | Partial<AgentMessage>): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is TextContent => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

function isSkillOnlyUserMessage(msg: AgentMessage | Partial<AgentMessage>, skillName?: string | null): boolean {
  if (msg.role !== "user") return false;
  const userSkillName = (msg as { skill?: SkillReference }).skill?.name;
  if (skillName && userSkillName !== skillName) return false;
  return userTextContent(msg).trim() === "";
}

function normalizeLoadedMessages(rawMessages: AgentMessage[], rawEntryIds?: string[]): { messages: AgentMessage[]; entryIds: string[] } {
  const compressed = rawMessages.map(compressMessageContent);
  const normalized = normalizeCompletedMessages(compressed);
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  normalized.forEach((msg, index) => {
    if (msg.role === "user") {
      const injectedSkillName = getSdkInjectedSkillName(userTextContent(msg));
      if (injectedSkillName) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (lastUser && isSkillOnlyUserMessage(lastUser, injectedSkillName)) {
          return;
        }
      }
    }
    messages.push(msg);
    if (rawEntryIds) entryIds.push(rawEntryIds[index]);
  });
  return { messages, entryIds };
}

function compressMessageContent(msg: AgentMessage): AgentMessage {
  if (msg.role !== "user") return msg;
  const content = msg.content;
  if (typeof content === "string") {
    // Only strip SDK-injected prefixes when the message carries a skill field
    if (msg.skill) {
      const stripped = stripSkillInjectedPrefix(content);
      if (stripped !== content) {
        return { ...msg, content: stripped };
      }
    }
    const compressed = compressSkillText(content);
    return compressed !== content ? { ...msg, content: compressed } : msg;
  }
  if (Array.isArray(content)) {
    let changed = false;
    const newContent = content.map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        const compressed = compressSkillText(block.text);
        if (compressed !== block.text) {
          changed = true;
          return { ...block, text: compressed };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: newContent } : msg;
  }
  return msg;
}

export interface SessionData {
  sessionId: string;
  filePath: string;
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    roleId?: string | null;
    agentMode?: AgentMode;
    /** subagent 协作 run 快照（按 jsonl 出现顺序） */
    collaborationRuns?: CollaborationRunSnapshot[];
  };
}

/** Shape of the `agentState` field returned by GET /api/sessions/[id]?includeState. */
export interface AgentStatePayload {
  running: boolean;
  state?: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    isRunning?: boolean;
    stopRequested?: boolean;
    contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
    systemPrompt?: string;
    thinkingLevel?: string;
    agentMode?: AgentMode;
    lastRun?: LastRunInfo | null;
  };
  /** Wrapper 不在内存时（进程重启/回收）由 /state 端点直接返回。 */
  lastRun?: LastRunInfo | null;
}

/** 持久化 Agent Run 的对外摘要（agent-runtime/run-types.ts 的 JSON 投影）。 */
export interface LastRunInfo {
  runId: string;
  sessionId: string;
  turnId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  errorCode?: string;
  error?: string;
  requestKind?: string;
}

/**
 * 将 agent_end 的 errorCode / lastRun.status 翻译为用户可读文案。
 * 返回 null 表示无需专门提示（沿用通用错误文案）。
 */
export function describeTerminalRunStatus(source: {
  errorCode?: string;
  lastRun?: LastRunInfo | null;
}): { title: string; detail?: string } | null {
  if (source.errorCode === "SESSION_PERSIST_FAILED"
    || source.lastRun?.errorCode === "SESSION_PERSIST_FAILED") {
    return {
      title: "会话写入失败，本次回复可能未完整保存",
      detail: "磁盘写入异常（如空间不足或权限问题），Agent 已安全停止以避免产生无法恢复的历史。请检查磁盘后重试；已保存的早期对话不受影响。",
    };
  }
  if (source.lastRun?.status === "interrupted") {
    return {
      title: "上次任务因服务重启而中断",
      detail: "Agent 运行时在任务执行中重启，该回合已标记为中断。已保存的对话历史完整，可基于当前上下文发送「继续」恢复任务。",
    };
  }
  if (source.lastRun?.status === "failed" && source.lastRun.errorCode) {
    return {
      title: "上次任务执行失败",
      detail: source.lastRun.error ?? undefined,
    };
  }
  return null;
}

type SessionDataWithAgentState = SessionData & { agentState?: AgentStatePayload };

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "resume":
      // 运行态快照只负责校正 streaming 标志，不能清空已渲染的流式消息。
      // 后端流事件期间约每秒广播一次快照；若复用 start，会让 bubble 周期性
      // 卸载、容器高度骤降，再在下一条 message_update 到来时恢复，造成闪跳。
      return state.isStreaming ? state : { ...state, isStreaming: true };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface ModelsResponse {
  models: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: ("text" | "image")[] }[];
  defaultModel?: { provider: string; modelId: string } | null;
  autoRecoveryModels?: ({ provider: string; modelId: string } | null)[];
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
}

const MODELS_CACHE_KEY = "deerhux.control-plane.models.v1";
let modelsPromise: Promise<ModelsResponse> | null = null;

type UsableModelsResponse = ModelsResponse & { modelList: NonNullable<ModelsResponse["modelList"]> };

function isUsableModelsResponse(value: ModelsResponse | null | undefined): value is UsableModelsResponse {
  return Boolean(value && value.models && typeof value.models === "object" && Array.isArray(value.modelList));
}

function fetchModels(): Promise<ModelsResponse> {
  if (modelsPromise) return modelsPromise;

  modelsPromise = fetchJsonWithRetry<ModelsResponse>("/api/models", { cache: "no-store" }, {
    attempts: 3,
    timeoutMs: 10_000,
  }).then((response) => {
    if (!isUsableModelsResponse(response)) throw new Error("Invalid models response");
    writeCachedJson(MODELS_CACHE_KEY, response);
    return response;
  }).finally(() => {
    modelsPromise = null;
  });
  return modelsPromise;
}

function describeModelsLoadError(error: unknown): string {
  if (error instanceof ControlPlaneHttpError) {
    return `模型列表请求失败（HTTP ${error.status}），请检查本地后台服务或重启应用`;
  }
  if (error instanceof Error && error.message) {
    return `模型列表加载失败：${error.message}`;
  }
  return "模型列表加载失败，请检查本地后台服务或重启应用";
}

export type AgentPhase =
  | { kind: "waiting_model"; reason: "initial" | "after_message" | "after_tool" | "restored" | "recovery" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | { kind: "stopping" }
  | null;

export type StreamRenderPriority = "focused" | "visible" | "hidden";

const STREAM_RENDER_DELAY: Record<StreamRenderPriority, number | null> = {
  focused: 32,
  visible: 64,
  hidden: null,
};

export interface UseAgentSessionOptions {
  activeTabId?: string | null;
  /** 控制累计正文提交频率；可见非焦点窗格仍会持续渲染。 */
  streamRenderPriority?: StreamRenderPriority;
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: (sessionId: string, changedFiles?: string[]) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionStarted?: (session: SessionInfo | null) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onSystemPromptChange?: (prompt: string | null) => void;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ChatInputHandle {
  insertText: (text: string) => void;
  addImages: (files: File[]) => void;
  addReference: (path: string) => void;
  clearInput?: () => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
  filePath?: string;  // absolute filesystem path for backend to read
  fileUrl?: string;   // frontend access URL via /api/files/...
}

function buildUserContent(message: string, images?: AttachedImage[]): UserMessage["content"] {
  const imageBlocks: ImageContent[] = images?.map((img) => {
    if (img.fileUrl) {
      return {
        type: "image",
        source: { type: "url", url: img.fileUrl },
      } as ImageContent;
    }
    return {
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.data },
    } as ImageContent;
  }) ?? [];
  if (!imageBlocks.length) return message;

  const textBlocks: TextContent[] = message.trim() ? [{ type: "text", text: message }] : [];
  return [...textBlocks, ...imageBlocks];
}

function fileReferenceName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function unescapeReferenceText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function stripAvailableReferencesText(text: string): { text: string; references: FileReference[] } | null {
  const skillPrefix = text.match(/^(\/skill:[\w-]+)(?:\s|$)([\s\S]*)/);
  const prefix = skillPrefix ? skillPrefix[1] : "";
  const body = skillPrefix ? skillPrefix[2] : text;
  const match = body.match(/^<available_references>\n[\s\S]*?\n((?:- .+\n?)*)<\/available_references>\n*(?:\n)?([\s\S]*)$/);
  if (!match) return null;

  const references = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const path = unescapeReferenceText(line.slice(2).trim());
      return { path, name: fileReferenceName(path) };
    })
    .filter((ref) => ref.path.length > 0);

  if (references.length === 0) return null;
  const rest = match[2].trim();
  return {
    text: prefix ? `${prefix}${rest ? ` ${rest}` : ""}` : rest,
    references,
  };
}

function normalizeVisibleUserText(text: string): { text: string; references?: FileReference[]; agentMode?: AgentMode; changed: boolean } {
  const agentMode = extractTurnMode(text) ?? undefined;
  const withoutTurnMode = stripTurnModeContext(text);
  const stripped = stripAvailableReferencesText(withoutTurnMode);
  if (stripped) {
    return {
      text: stripped.text,
      references: stripped.references,
      agentMode,
      changed: true,
    };
  }
  return {
    text: withoutTurnMode,
    agentMode,
    changed: withoutTurnMode !== text,
  };
}

function normalizeVisibleUserMessage(msg: AgentMessage): AgentMessage {
  if (msg.role !== "user") return msg;
  if (typeof msg.content === "string") {
    const normalized = normalizeVisibleUserText(msg.content);
    if (!normalized.changed && !normalized.agentMode) return msg;
    return {
      ...msg,
      content: normalized.text,
      references: msg.references?.length ? msg.references : normalized.references,
      ...(normalized.agentMode ? { agentMode: normalized.agentMode } : {}),
    };
  }
  if (!Array.isArray(msg.content)) return msg;

  let references: FileReference[] | undefined;
  let agentMode: AgentMode | undefined;
  let changed = false;
  const content = msg.content.map((block) => {
    if (block.type !== "text") return block;
    const normalized = normalizeVisibleUserText(block.text);
    if (normalized.agentMode) agentMode = normalized.agentMode;
    if (!normalized.changed) return block;
    changed = true;
    references = normalized.references;
    return { ...block, text: normalized.text };
  });
  if (!changed && !agentMode) return msg;
  return {
    ...msg,
    content,
    references: msg.references?.length ? msg.references : references,
    ...(agentMode ? { agentMode } : {}),
  };
}

/**
 * 提取 user message 的纯文本签名（剥离图片/references/skill），
 * 用于跨数据源（前端乐观 push vs SDK 存盘）匹配同一条消息。
 */
function userMessageTextKey(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    return text;
  }
  return "";
}

function reconcilePendingUserMessages(
  loaded: AgentMessage[],
  loadedEntryIds: string[],
  pending: Map<string, AgentMessage>,
): { messages: AgentMessage[]; entryIds: string[] } {
  if (!pending.size) return { messages: loaded, entryIds: loadedEntryIds };

  // 优先通过持久化的 clientMessageId 精确确认。
  for (const msg of loaded) {
    if (msg.role === "user" && msg.clientMessageId) {
      pending.delete(msg.clientMessageId);
    }
  }

  // clientMessageId 保存在 display_user_message 自定义条目中；旧会话或其他
  // 写入来源可能没有该字段。此时若继续把 pending 直接拼到末尾，就会将本应
  // 位于 assistant 之前的用户气泡错误移到最后。对仍待确认的本地消息，以内容
  // 和提交时间作受限兼容回退匹配，保留服务端快照的顺序。
  const usedFallbackIndexes = new Set<number>();
  for (const [clientMessageId, pendingMessage] of pending) {
    if (pendingMessage.role !== "user" || pendingMessage.deliveryState === "failed") continue;
    const pendingText = userMessageTextKey(pendingMessage.content);
    if (!pendingText) continue;

    let matchedIndex = -1;
    let smallestTimestampDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < loaded.length; index++) {
      const loadedMessage = loaded[index];
      if (
        usedFallbackIndexes.has(index)
        || loadedMessage.role !== "user"
        || loadedMessage.clientMessageId
        || userMessageTextKey(loadedMessage.content) !== pendingText
      ) continue;

      const pendingTimestamp = pendingMessage.timestamp;
      const loadedTimestamp = loadedMessage.timestamp;
      // 本地消息先创建，服务端持久化条目只能随后出现。拒绝任何早于本地
      // 发送时间的同文历史，避免连续发送“继续”等相同内容时误配旧回合。
      const timestampDelta = typeof pendingTimestamp === "number" && typeof loadedTimestamp === "number"
        && loadedTimestamp >= pendingTimestamp
        ? loadedTimestamp - pendingTimestamp
        : Number.POSITIVE_INFINITY;
      // 两个时间戳都存在且候选在本地发送之后，才允许回退确认；缺失时间戳则
      // 保守地保留 pending 气泡，等待带 clientMessageId 的下次快照确认。
      if (timestampDelta > 5 * 60_000 || timestampDelta >= smallestTimestampDelta) continue;
      matchedIndex = index;
      smallestTimestampDelta = timestampDelta;
    }

    if (matchedIndex < 0) continue;
    usedFallbackIndexes.add(matchedIndex);
    // 将本地 id 补到当前内存快照，后续 SSE user echo 仍可精确去重；不会写回 session 文件。
    loaded[matchedIndex] = { ...loaded[matchedIndex], clientMessageId } as AgentMessage;
    pending.delete(clientMessageId);
  }

  if (!pending.size) return { messages: loaded, entryIds: loadedEntryIds };
  const unresolved = [...pending.values()];
  return {
    messages: [...loaded, ...unresolved],
    // SessionContext 要求 entryIds 与 messages 平行；pending 尚未落盘，没有 entry id。
    entryIds: [...loadedEntryIds, ...unresolved.map(() => "")],
  };
}

function getStreamingContentLength(msg: Partial<AgentMessage> | null | undefined): number {
  const content = msg?.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content.length : 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) continue;
    if (block.type === "text" && "text" in block && typeof block.text === "string") {
      chars += block.text.length;
    } else if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
      chars += block.thinking.length;
    } else if (block.type === "toolCall") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = block as any;
      if (b.input) chars += JSON.stringify(b.input).length;
      else if (b.arguments) chars += JSON.stringify(b.arguments).length;
    }
  }
  return chars;
}

export type WatchdogInfo = {
  eventIdleMs: number;
  contentIdleMs: number;
  eventThresholdMs: number;
  contentThresholdMs: number;
};

export type AutoRecoveryMode = "off" | "conservative" | "aggressive";
export type StallLevel = null | "warning" | "recovering";
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  errorMessage?: string;
  errorCode?: string;
  userMessage?: string;
  suggestedAction?: string;
};

type AgentStatus = {
  isStreaming?: boolean;
  isCompacting?: boolean;
  isRunning?: boolean;
  stopRequested?: boolean;
  lastEventType?: string;
  eventIdleMs?: number | null;
  contentIdleMs?: number | null;
};

// Circuit breaker: maximum auto-recoveries per logical user turn. Shared by all
// recovery triggers — the watchdog setInterval, the visibilitychange handler,
// and the backend `agent_stale_warning` handler — so they draw from the same
// budget and can't collectively exceed this limit.
const MAX_AUTO_RECOVERIES_PER_TURN = 3;
const AWAITING_AGENT_START_TIMEOUT_MS = 60_000;
const AWAITING_AGENT_START_MAX_CHECKS = 2;

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    activeTabId,
    streamRenderPriority = "focused",
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionStarted, onSessionForked,
    modelsRefreshKey, onSystemPromptChange,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  // This is a client-only render cache. It restores a session immediately if a
  // layout change temporarily unmounted its ChatWindow; the JSONL snapshot is
  // still fetched afterwards as the source of truth.
  // Read once per component lifetime. Store.get promotes LRU order, so it must
  // not run as an unconditional render-time side effect.
  const [initialHistorySnapshot] = useState(() => (
    session?.id ? getSessionHistorySnapshot(session.id) : null
  ));

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(() => !isNew && !initialHistorySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>(() => initialHistorySnapshot?.messages ?? []);
  const [entryIds, setEntryIds] = useState<string[]>(() => initialHistorySnapshot?.entryIds ?? []);
  // 服务端快照、乐观用户消息和流式 assistant 是三个不同一致性层级。
  // pending 只在持久化快照带回相同 clientMessageId 后确认，不能被 user SSE echo 提前清除。
  const pendingUserMessagesRef = useRef<Map<string, AgentMessage>>(new Map());
  // 快照请求期间只要消息发生本地变化，该请求的 message 部分就已过期，不能覆盖 UI。
  const messageMutationEpochRef = useRef(0);
  // 多个 loadSession/loadRecentMessages 并发时，只允许最后启动的快照应用消息。
  const messageSnapshotRequestSeqRef = useRef(0);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string; input?: ("text" | "image")[] }[]>([]);
  const [modelsLoadError, setModelsLoadError] = useState<string | null>(null);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [autoRecoveryModels, setAutoRecoveryModels] = useState<({ provider: string; modelId: string } | null)[]>([]);
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [agentMode, setAgentMode] = useState<AgentMode>("agent");
  const agentModeRef = useRef<AgentMode>("agent");
  const [planReady, setPlanReady] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const retryInfoRef = useRef<RetryInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const lastSystemPromptRef = useRef<string | null>(null);
  // Keep a persistent copy so systemPrompt is still available after the agent dies
  useEffect(() => {
    if (systemPrompt) lastSystemPromptRef.current = systemPrompt;
  }, [systemPrompt]);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const isCompactingRef = useRef(false);
  useEffect(() => {
    isCompactingRef.current = isCompacting;
  }, [isCompacting]);
  const [compactionProgress, setCompactionProgress] = useState<import("@/lib/compaction-ui").CompactionProgress | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  // TODO 3 — first-paint pagination. When the recent-messages endpoint
  // reported older messages were truncated, this lets the UI offer a
  // "load full history" affordance.
  const [hasOlderMessages, setHasOlderMessages] = useState(() => initialHistorySnapshot?.hasOlderMessages ?? false);
  const hasOlderMessagesRef = useRef(initialHistorySnapshot?.hasOlderMessages ?? false);
  const fullHistoryLoadedRef = useRef(initialHistorySnapshot?.fullHistoryLoaded ?? false);
  const [loadingFullHistory, setLoadingFullHistory] = useState(false);
  const loadingFullHistoryRef = useRef(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [watchdogInfo, setWatchdogInfo] = useState<WatchdogInfo | null>(null);
  const [lastModelError, setLastModelError] = useState<string | null>(null);
  const lastModelErrorRef = useRef<string | null>(null);
  // 终态说明（SESSION_PERSIST_FAILED / interrupted）：与通用模型错误分开，
  // 用专门横幅展示并可手动关闭。
  const [terminalNotice, setTerminalNotice] = useState<{ title: string; detail?: string } | null>(null);
  const terminalNoticeRef = useRef<{ title: string; detail?: string } | null>(null);
  const setTerminalNoticeState = useCallback((notice: { title: string; detail?: string } | null) => {
    terminalNoticeRef.current = notice;
    setTerminalNotice(notice);
  }, []);
  const clearTerminalNotice = useCallback(() => {
    terminalNoticeRef.current = null;
    setTerminalNotice(null);
  }, []);
  const [modelsConfigVersion, bumpModelsConfigVersion] = useReducer((v: number) => v + 1, 0);

  // Auto-recovery mode persisted in localStorage
  const [autoRecoveryMode, setAutoRecoveryModeState] = useState<AutoRecoveryMode>(() => {
    if (typeof window === "undefined") return "aggressive";
    const stored = getLocalStorageItem("deerhux.auto-recovery-mode");
    return (stored === "off" || stored === "conservative" || stored === "aggressive") ? stored : "aggressive";
  });
  const autoRecoveryModeRef = useRef(autoRecoveryMode);
  useEffect(() => {
    autoRecoveryModeRef.current = autoRecoveryMode;
  }, [autoRecoveryMode]);
  const [stallLevel, setStallLevel] = useState<StallLevel>(null);
  const stallDismissedRef = useRef(false);

  // Subagent tool capability toggle persisted in localStorage. When enabled,
  // the `subagent` tool is added to the active agent tool set.
  const [subagentEnabled, setSubagentEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return getLocalStorageItem("deerhux.subagent-enabled") === "true";
  });
  const subagentEnabledRef = useRef(subagentEnabled);
  const getTurnCapabilities = useCallback(() => ({
    subagent: subagentEnabledRef.current,
  }), []);
  const stallRecoveriesRef = useRef(0);

  const eventSubscriptionRef = useRef<(() => void) | null>(null);
  const transientSubscriptionRef = useRef<(() => void) | null>(null);
  const eventSubscriptionSessionIdRef = useRef<string | null>(null);
  // 累计完整 message_update 可能按 token 到达。这里只保留当前 Session 的最新快照，
  // 再按窗格可见性限频提交，避免 React/Markdown 渲染频率被上游事件直接放大。
  const pendingMessageUpdateRef = useRef<{ event: AgentEvent; sessionId: string } | null>(null);
  const messageUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRenderPriorityRef = useRef<StreamRenderPriority>(streamRenderPriority);
  const sessionIdRef = useRef<string | null>(null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const {
    messagesEndRef, scrollContainerRef, lastUserMsgRef,
    pendingScrollToUserRef, initialScrollDoneRef,
    resetAutoScroll, syncAfterMessageChange,
  } = useChatAutoScroll();
  const changedFilesRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<AgentMessage[]>([]);
  const entryIdsRef = useRef<string[]>([]);
  const historySnapshotInvalidRef = useRef(false);
  const lastAgentEventAtRef = useRef(Date.now());
  const lastContentChangedAtRef = useRef(Date.now());
  const lastContentLengthRef = useRef(0);
  const autoRecoveryModelsRef = useRef<({ provider: string; modelId: string } | null)[]>([]);
  const watchdogCheckingRef = useRef(false);
  const watchdogStaleRecoveriesRef = useRef(0);
  // Tracks how many times the watchdog has auto-recovered this logical turn.
  // Reset only on user-initiated sends (handleSend / handleFollowUp), NOT in
  // resetTurnTracking(), so it survives across watchdog recovery cycles and
  // acts as a circuit breaker (max 3 auto-recoveries per user message).
  /** 同一用户回合的原路重试耗尽只允许触发一次 recover。 */
  const retryExhaustedRecoveryUsedRef = useRef(false);
  const autoRecoveryAttemptsRef = useRef(0);
  const agentPhaseRef = useRef<AgentPhase>(null);
  const autoContinueSentRef = useRef(false);
  const autoContinueInProgressRef = useRef(false);
  const abortCompletedRef = useRef(false);
  const receivedAssistantMessageRef = useRef(false);
  /** 本回合已完成 tool-call assistant，正在等待工具后的最终模型回复。 */
  const awaitingFinalReplyAfterToolsRef = useRef(false);
  const awaitingAgentStartRef = useRef(false);
  const awaitingAgentStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingAgentStartChecksRef = useRef(0);
  const optimisticSessionIdRef = useRef<string | null>(null);
  // New-session first prompt has a short window where the UI is already
  // running but the real session id has not returned from /api/agent/new yet.
  // If the user hits stop in that window, remember it and send abort as soon
  // as the real id is known.
  const pendingAbortOnSessionReadyRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const adoptingCreatedSessionRef = useRef<string | null>(null);
  const turnIdRef = useRef(0);
  // 最终 agent_end 后，拒绝同一会话中较早发出的状态请求将界面重新置为运行中。
  const terminalTurnEndedSessionIdRef = useRef<string | null>(null);
  const activeSubagentToolIdsRef = useRef<Set<string>>(new Set());
  const subagentLiveRefreshTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAwaitingAgentStartGuard = useCallback((resetChecks = true) => {
    if (resetChecks) awaitingAgentStartChecksRef.current = 0;
    if (awaitingAgentStartTimerRef.current) {
      clearTimeout(awaitingAgentStartTimerRef.current);
      awaitingAgentStartTimerRef.current = null;
    }
  }, []);

  // Shared reset: clears all per-turn tracking state. Called at the start of
  // every new turn (user send, follow_up, agent_start) to prevent stale
  // watchdog/error state leaking across turns.
  //
  // NOTE: autoContinueSentRef / autoContinueInProgressRef are NOT reset here.
  // They are managed exclusively by executeRecovery() and the agent_end handler.
  // Resetting them inside resetTurnTracking() creates a race window: if the
  // SDK's auto-retry fires an agent_start between executeRecovery's abort and
  // follow_up, the agent_start → resetTurnTracking() would clear the recovery
  // gate, causing two concurrent streams (SDK retry + our follow_up).
  // handleSend / handleFollowUp explicitly reset these refs for user-initiated turns.
  const resetTurnTracking = () => {
    watchdogStaleRecoveriesRef.current = 0;
    stallDismissedRef.current = false;
    stallRecoveriesRef.current = 0;
    setStallLevel(null);
    lastModelErrorRef.current = null;
    setLastModelError(null);
    if (terminalNoticeRef.current) clearTerminalNotice();
    receivedAssistantMessageRef.current = false;
    awaitingFinalReplyAfterToolsRef.current = false;
    awaitingAgentStartRef.current = false;
    clearAwaitingAgentStartGuard();
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;
  };

  const setNewSessionModel = opts.setNewSessionModel ?? setNewSessionModelState;
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  const sessionStats = useMemo(() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  }, [messages]);

  // Session-level abort controller. Aborted when the active session changes
  // so orphaned background loadSession / polling requests from the previous
  // session are cancelled instead of piling up on the backend (which is the
  // root cause of "background refresh failed: AbortError").
  const sessionAbortRef = useRef<AbortController | null>(new AbortController());
  // Inflight loadSession deduplication. Multiple concurrent background callers
  // (agent_end, compaction_end, recovery, watchdog) share a single network
  // request to avoid thundering-herd on a slow backend.
  const loadSessionInflightRef = useRef<{
    sid: string;
    messageEpoch: number;
    promise: Promise<{ agentState: AgentStatePayload | null; messagesApplied: boolean } | null>;
  } | null>(null);

  const applySessionSnapshot = useCallback((
    d: SessionDataWithAgentState,
    applyMessages = true,
  ) => {
    setData(d);
    const { messages: loadedMessages, entryIds: loadedEntryIds } = normalizeLoadedMessages(d.context.messages, d.context.entryIds);
    const prevKey = entryIdsRef.current.join("\0");
    const nextKey = loadedEntryIds.join("\0");
    const changed = applyMessages && Boolean(nextKey && nextKey !== prevKey);

    if (applyMessages) {
      const reconciled = reconcilePendingUserMessages(
        loadedMessages,
        loadedEntryIds,
        pendingUserMessagesRef.current,
      );
      setMessages(reconciled.messages);
      setEntryIds(reconciled.entryIds);
    }
    setCurrentModelOverride(null);
    setAgentMode(normalizeAgentMode(d.context.agentMode));
    setError(null);

    if (changed) {
      lastAgentEventAtRef.current = Date.now();
      lastContentChangedAtRef.current = Date.now();
      watchdogStaleRecoveriesRef.current = 0;
      const lastAssistant = [...loadedMessages].reverse().find((msg) => msg.role === "assistant");
      lastContentLengthRef.current = Math.max(lastContentLengthRef.current, getStreamingContentLength(lastAssistant));
    }

    const hasAssistant = applyMessages && loadedMessages.some((msg) => msg.role === "assistant");
    if (awaitingAgentStartRef.current && (changed || hasAssistant)) {
      clearAwaitingAgentStartGuard();
      awaitingAgentStartRef.current = false;
      setAgentPhase({ kind: "waiting_model", reason: "restored" });
    }

    return { changed, loadedMessages, loadedEntryIds };
  }, [clearAwaitingAgentStartGuard]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    // Background refreshes piggyback on an existing inflight request for the
    // same sid. showLoading callers always start a fresh request so loading
    // spinner transitions stay tied to user-visible actions.
    const messageEpochAtStart = messageMutationEpochRef.current;
    const inflight = loadSessionInflightRef.current;
    if (
      !showLoading
      && inflight
      && inflight.sid === sid
      && inflight.messageEpoch === messageEpochAtStart
    ) {
      return inflight.promise;
    }

    const snapshotRequestSeq = ++messageSnapshotRequestSeqRef.current;
    const controller = new AbortController();
    // Link to the session-level abort so a tab switch cancels this request
    // cleanly instead of letting it race the new session's requests.
    const sessionSignal = sessionAbortRef.current?.signal;
    let sessionAborted = false;
    const onSessionAbort = () => {
      sessionAborted = true;
      controller.abort();
    };
    if (sessionSignal) {
      if (sessionSignal.aborted) sessionAborted = true;
      else sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
    }
    // Background refreshes use a shorter timeout: if the backend is slow we'd
    // rather drop the refresh silently than pile up requests and eventually
    // log scary AbortError warnings. Foreground (showLoading) keeps 30s so
    // the user has a chance to see the result.
    const timeout = setTimeout(() => controller.abort(), showLoading ? 30_000 : 12_000);

    const promise = (async () => {
      try {
        if (showLoading) setLoading(true);
        const url = includeState
          ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
          : `/api/sessions/${encodeURIComponent(sid)}`;
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (res.status === 404) {
          if (showLoading) {
            setData(null);
            setMessages([]);
            setError(null);
          }
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as SessionDataWithAgentState;
        if (sid !== sessionIdRef.current) return null;
        const requestIsLatest = snapshotRequestSeq === messageSnapshotRequestSeqRef.current;
        if (!requestIsLatest) return { agentState: d.agentState ?? null, messagesApplied: false };
        const messagesAreCurrent = (
          messageEpochAtStart === messageMutationEpochRef.current
          && !agentRunningRef.current
        );
        // 最新快照若跨过了消息变化，只更新模型/模式等元数据，绝不能覆盖消息。
        applySessionSnapshot(d, messagesAreCurrent);
        // If no live agent state, fall back to thinking level from session file
        if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
          setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
        }
        return { agentState: d.agentState ?? null, messagesApplied: messagesAreCurrent };
      } catch (e) {
        // Swallow aborts caused by a session switch — they're expected cleanup,
        // not real failures worth warning about.
        if (sid === sessionIdRef.current && !sessionAborted) {
          const isAbort = e instanceof DOMException && e.name === "AbortError";
          if (showLoading) {
            setError(isAbort ? "加载会话超时" : String(e));
          } else if (!isAbort) {
            console.warn("[loadSession] background refresh failed:", e);
          }
        }
        return null;
      } finally {
        clearTimeout(timeout);
        if (sessionSignal) sessionSignal.removeEventListener("abort", onSessionAbort);
        if (showLoading && sid === sessionIdRef.current) setLoading(false);
      }
    })();

    // Register the inflight promise so concurrent background callers share
    // this request. Cleared on settle so the next call can fire.
    if (!showLoading) {
      loadSessionInflightRef.current = { sid, messageEpoch: messageEpochAtStart, promise };
      promise.finally(() => {
        if (loadSessionInflightRef.current?.promise === promise) {
          loadSessionInflightRef.current = null;
        }
      });
    }
    return promise;
  }, [applySessionSnapshot]);

  /**
   * Load only the most recent N messages via the dedicated messages endpoint
   * (remediation plan §5.4 / TODO 3). Used as the first-paint data source so
   * large sessions don't ship their entire history on open. When the endpoint
   * reports older messages were truncated, {@link hasOlderMessages} is set so
   * the UI can offer "load full history" via {@link loadFullHistory}.
   */
  const loadRecentMessages = useCallback(async (sid: string, showLoading = false) => {
    if (!showLoading && loadingFullHistoryRef.current) return;
    const snapshotRequestSeq = ++messageSnapshotRequestSeqRef.current;
    const messageEpochAtStart = messageMutationEpochRef.current;
    const controller = new AbortController();
    const sessionSignal = sessionAbortRef.current?.signal;
    let timedOut = false;
    let sessionAborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, showLoading ? 30_000 : 12_000);
    const onSessionAbort = () => {
      sessionAborted = true;
      controller.abort();
    };
    if (sessionSignal) {
      if (sessionSignal.aborted) onSessionAbort();
      else sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
    }
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sid)}/messages?limit=100`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (res.status === 404) {
        if (showLoading) {
          historySnapshotInvalidRef.current = true;
          deleteSessionHistorySnapshot(sid);
          setData(null);
          setMessages([]);
          setError(null);
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        sessionId: string;
        messages: AgentMessage[];
        entryIds: string[];
        totalCount: number;
        thinkingLevel: string;
        model: { provider: string; modelId: string } | null;
        roleId?: string | null;
        agentMode?: AgentMode;
        page: { limit: number; returned: number; hasMoreBefore: boolean; preservedFirst?: boolean; preservedPrefixCount?: number };
      };
      if (sid !== sessionIdRef.current) return;
      const requestIsLatest = snapshotRequestSeq === messageSnapshotRequestSeqRef.current;
      if (!requestIsLatest) return;
      const messagesAreCurrent = (
        messageEpochAtStart === messageMutationEpochRef.current
        // 首次前台打开一个正在运行的 session 时，SSE transient 基线会先把
        // running 置为 true。前台打开时仍须应用初始 JSONL 快照，否则订阅前
        // 已落盘的 user prompt（尤其是 subagent 任务设定）会永久缺失；这也能
        // 修复此前缓存过的不完整 worker 窗口。请求期间若收到
        // message_end，messageMutationEpoch 会变化，仍能阻止旧快照覆盖实时消息。
        && (!agentRunningRef.current || showLoading)
      );
      // 已加载完整历史时，以 recent 连续窗口的首个 entryId 为锚点替换尾部，
      // 保留旧消息又同步最终 Assistant/ToolResult；锚点缺失时仅更新元数据。
      // 分页页可能是「额外保留的回合边界 + 最新连续窗口」。已加载完整历史时
      // 不能把这些前缀当连续窗口锚点，否则会误删中间历史。
      const recentWindowStart = Math.max(0, d.page?.preservedPrefixCount ?? (d.page?.preservedFirst ? 1 : 0));
      const mergeAnchor = d.entryIds[recentWindowStart];
      const mergeAnchorIndex = fullHistoryLoadedRef.current && mergeAnchor
        ? entryIdsRef.current.indexOf(mergeAnchor)
        : -1;
      const preservedPrefixMessages = d.messages.slice(0, recentWindowStart);
      const preservedPrefixEntryIds = d.entryIds.slice(0, recentWindowStart);
      const mergedMessages = fullHistoryLoadedRef.current && mergeAnchorIndex >= 0
        ? [...messagesRef.current.slice(0, mergeAnchorIndex), ...d.messages.slice(recentWindowStart)]
        : [...preservedPrefixMessages, ...d.messages.slice(recentWindowStart)];
      const mergedEntryIds = fullHistoryLoadedRef.current && mergeAnchorIndex >= 0
        ? [...entryIdsRef.current.slice(0, mergeAnchorIndex), ...d.entryIds.slice(recentWindowStart)]
        : [...preservedPrefixEntryIds, ...d.entryIds.slice(recentWindowStart)];
      const historyWasRebased = fullHistoryLoadedRef.current && mergeAnchorIndex < 0;
      const applyRecentMessages = messagesAreCurrent;
      if (applyRecentMessages && historyWasRebased) fullHistoryLoadedRef.current = false;
      // Shape into SessionData so applySessionSnapshot handles normalization
      // and pending-message reconciliation identically.
      applySessionSnapshot({
        sessionId: d.sessionId,
        // leafId is not used by applySessionSnapshot's message path; reuse null.
        filePath: "",
        leafId: null,
        context: {
          messages: mergedMessages,
          entryIds: mergedEntryIds,
          thinkingLevel: d.thinkingLevel,
          model: d.model,
          roleId: d.roleId ?? null,
          agentMode: d.agentMode,
        },
      }, applyRecentMessages);
      if (applyRecentMessages && (!fullHistoryLoadedRef.current || historyWasRebased)) {
        setHasOlderMessages(Boolean(d.page?.hasMoreBefore));
      }
      setError(null);
    } catch (e) {
      const requestIsLatest = snapshotRequestSeq === messageSnapshotRequestSeqRef.current;
      if (sid === sessionIdRef.current && requestIsLatest) {
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        if (showLoading && (!isAbort || timedOut)) setError(timedOut ? "加载会话超时" : String(e));
        else if (!isAbort) console.warn("[loadRecentMessages] failed:", e);
      }
    } finally {
      clearTimeout(timeout);
      if (sessionSignal) sessionSignal.removeEventListener("abort", onSessionAbort);
      const requestIsLatest = snapshotRequestSeq === messageSnapshotRequestSeqRef.current;
      if (showLoading && sid === sessionIdRef.current && requestIsLatest && (!sessionAborted || timedOut)) {
        setLoading(false);
      }
    }
  }, [applySessionSnapshot]);

  /**
   * Load the FULL session history (fallback for when the recent-messages
   * first paint truncated older messages). Triggered by the user via the
   * "load full history" affordance. Clears {@link hasOlderMessages} on
   * success.
   */
  const loadFullHistory = useCallback(async (sid: string): Promise<boolean> => {
    if (loadingFullHistoryRef.current) return false;
    loadingFullHistoryRef.current = true;
    setLoadingFullHistory(true);
    const snapshotRequestSeq = ++messageSnapshotRequestSeqRef.current;
    const controller = new AbortController();
    const sessionSignal = sessionAbortRef.current?.signal;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const onSessionAbort = () => controller.abort();
    if (sessionSignal) {
      if (sessionSignal.aborted) controller.abort();
      else sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
    }

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionDataWithAgentState;
      if (sid !== sessionIdRef.current || snapshotRequestSeq !== messageSnapshotRequestSeqRef.current) {
        return false;
      }

      // Full history may be requested while a worker is still producing durable
      // messages. Keep anything that arrived after the server snapshot at the tail.
      const loaded = normalizeLoadedMessages(d.context.messages, d.context.entryIds);
      // 先让持久化快照认领对应的乐观 user 消息，再保留请求期间新增的实时尾部。
      // 若反过来先 merge，本地副本会被追加到末尾；随后它又会凭自己的
      // clientMessageId 清掉 pending，最终留下一个位置错误的重复气泡。
      const reconciledLoaded = reconcilePendingUserMessages(
        loaded.messages,
        loaded.entryIds,
        pendingUserMessagesRef.current,
      );
      const merged = mergeFullSessionHistory(
        reconciledLoaded.messages,
        reconciledLoaded.entryIds,
        messagesRef.current,
        entryIdsRef.current,
      );
      applySessionSnapshot({
        ...d,
        context: {
          ...d.context,
          messages: merged.messages,
          entryIds: merged.entryIds,
        },
      }, true);
      fullHistoryLoadedRef.current = true;
      setHasOlderMessages(false);
      return true;
    } catch (e) {
      if (sid === sessionIdRef.current) {
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        setError(isAbort ? "加载完整历史超时" : String(e));
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (sessionSignal) sessionSignal.removeEventListener("abort", onSessionAbort);
      loadingFullHistoryRef.current = false;
      if (sid === sessionIdRef.current) setLoadingFullHistory(false);
    }
  }, [applySessionSnapshot]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/components/ToolPanel");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  /**
   * Apply a runtime AgentStatePayload (from /api/sessions/:id/state) to the
   * local UI state. Extracted so both the "open session" flow and the
   * "agent_end → refresh state" flow share one implementation.
   *
   * Pure application — does NOT load messages. Failures are tolerated by the
   * caller (this never throws for missing fields).
   */
  const applyAgentStatePayload = useCallback((agentState: AgentStatePayload | null, sid: string) => {
    if (sid !== sessionIdRef.current || !agentState?.state) return;
    // GET remains the metadata/history channel only. running, streaming,
    // compacting and thinkingLevel are authoritative mux transient fields.
    if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
    if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
    if (agentState.state.agentMode !== undefined) setAgentMode(normalizeAgentMode(agentState.state.agentMode));
    const lastRun = agentState.lastRun ?? agentState.state.lastRun ?? null;
    const notice = lastRun ? describeTerminalRunStatus({ lastRun }) : null;
    if (notice) setTerminalNoticeState(notice);
  }, [setTerminalNoticeState]);

  /**
   * Fetch ONLY the live runtime state for a session via the dedicated state
   * endpoint (remediation plan §5.3). This is decoupled from message loading:
   * it runs AFTER the history is shown so a busy/locked runtime can never
   * block the first paint. Failures are swallowed — a missing runtime state
   * must never mark the session as failed.
   */
  const loadSessionState = useCallback(async (sid: string): Promise<AgentStatePayload | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) return null;
        const payload = (await res.json()) as AgentStatePayload;
        applyAgentStatePayload(payload, sid);
        return payload;
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      // Swallow: state loading is best-effort. Avoid scary AbortError logs
      // unless we're actually still on this session.
      if (sid === sessionIdRef.current) {
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        if (!isAbort) console.warn("[loadSessionState] failed:", e);
      }
      return null;
    }
  }, [applyAgentStatePayload]);

  const stopSubagentLiveRefresh = useCallback(() => {
    for (const timer of subagentLiveRefreshTimersRef.current) clearTimeout(timer);
    subagentLiveRefreshTimersRef.current = [];
  }, []);

  const startSubagentLiveRefresh = useCallback((sid: string) => {
    // 只做短促刷新，把父 session jsonl 里的 agent_collaboration_run 快照拉进当前页面，
    // 让 tag 尽快挂载。tag 挂载后会走 /api/agent-runs/:runId/events 自己实时更新，
    // 不能在 subagent 整个运行期间每秒全量 loadSession，否则会拖垮 session 读取和左侧列表。
    stopSubagentLiveRefresh();
    const delays = [0, 600, 1500, 3000, 6000];
    subagentLiveRefreshTimersRef.current = delays.map((delay) => setTimeout(() => {
      if (sessionIdRef.current !== sid || activeSubagentToolIdsRef.current.size === 0) return;
      void loadSession(sid, false, false);
    }, delay));
  }, [loadSession, stopSubagentLiveRefresh]);

  const finishSubagentLiveRefresh = useCallback((sid: string) => {
    stopSubagentLiveRefresh();
    void loadSession(sid, false, false);
  }, [loadSession, stopSubagentLiveRefresh]);

  const cancelPendingMessageUpdate = useCallback(() => {
    pendingMessageUpdateRef.current = null;
    if (messageUpdateTimerRef.current !== null) {
      clearTimeout(messageUpdateTimerRef.current);
      messageUpdateTimerRef.current = null;
    }
  }, []);

  const flushPendingMessageUpdate = useCallback((expectedSessionId?: string) => {
    if (messageUpdateTimerRef.current !== null) {
      clearTimeout(messageUpdateTimerRef.current);
      messageUpdateTimerRef.current = null;
    }
    const pending = pendingMessageUpdateRef.current;
    pendingMessageUpdateRef.current = null;
    if (
      pending
      && pending.sessionId === sessionIdRef.current
      && (!expectedSessionId || pending.sessionId === expectedSessionId)
    ) {
      handleAgentEventRef.current?.(pending.event);
    }
  }, []);

  const enqueueMessageUpdate = useCallback((event: AgentEvent, sid: string) => {
    pendingMessageUpdateRef.current = { event, sessionId: sid };
    const delay = STREAM_RENDER_DELAY[streamRenderPriorityRef.current];
    if (delay === null || messageUpdateTimerRef.current !== null) return;

    messageUpdateTimerRef.current = setTimeout(() => {
      messageUpdateTimerRef.current = null;
      flushPendingMessageUpdate(sid);
    }, delay);
  }, [flushPendingMessageUpdate]);

  useEffect(() => {
    const previous = streamRenderPriorityRef.current;
    streamRenderPriorityRef.current = streamRenderPriority;

    if (streamRenderPriority === "hidden" && messageUpdateTimerRef.current !== null) {
      clearTimeout(messageUpdateTimerRef.current);
      messageUpdateTimerRef.current = null;
    }

    const becameMoreVisible = (
      (previous === "visible" && streamRenderPriority === "focused")
      || (previous === "hidden" && streamRenderPriority !== "hidden")
    );
    if (becameMoreVisible) flushPendingMessageUpdate(sessionIdRef.current ?? undefined);
  }, [streamRenderPriority, flushPendingMessageUpdate]);

  const applyTransientSnapshot = useCallback((snapshot: SessionTransientSnapshot | null, sid: string) => {
    if (sessionIdRef.current !== sid) return;
    if (!snapshot) {
      agentRunningRef.current = false;
      setAgentRunning(false);
      setIsCompacting(false);
      dispatch({ type: "end" });
      return;
    }
    agentRunningRef.current = snapshot.running;
    setAgentRunning(snapshot.running);
    setIsCompacting(snapshot.isCompacting);
    if (snapshot.thinkingLevel) setThinkingLevel(snapshot.thinkingLevel as ThinkingLevelOption);
    if (snapshot.isStreaming) dispatch({ type: "resume" });
    else if (!snapshot.running) dispatch({ type: "end" });
    if (snapshot.running) {
      setAgentPhase((phase) => phase ?? { kind: "waiting_model", reason: "restored" });
    } else {
      stopRequestedRef.current = false;
      setAgentPhase(null);
    }
  }, []);

  const connectEvents = useCallback((sid: string, _isReconnect = false) => {
    if (eventSubscriptionSessionIdRef.current === sid && eventSubscriptionRef.current) {
      ensureAgentEventsConnected();
      return;
    }
    eventSubscriptionRef.current?.();
    transientSubscriptionRef.current?.();
    eventSubscriptionRef.current = null;
    transientSubscriptionRef.current = null;
    eventSubscriptionSessionIdRef.current = sid;

    // Sync controls to a possibly cold-started session. These remain best-effort
    // HTTP commands during the multiplexed-SSE migration phase.
    void sendAgentCommand(sid, { type: "set_subagent_enabled", enabled: subagentEnabledRef.current }).catch(() => {});
    void sendAgentCommand(sid, { type: "set_auto_recovery_mode", mode: autoRecoveryModeRef.current }).catch(() => {});

    transientSubscriptionRef.current = subscribeSessionTransient(sid, (snapshot) => {
      applyTransientSnapshot(snapshot, sid);
    });

    eventSubscriptionRef.current = subscribeAgentEvents(
      sid,
      (event) => {
        agentEventBus.emit({ sessionId: sid, event });
        if (event.type === "message_update") {
          enqueueMessageUpdate(event, sid);
        } else {
          // message_end / agent_end 等终态前必须同步提交最后一份完整快照，
          // 即使窗格在后台也不能让终态越过尚未渲染的内容。
          flushPendingMessageUpdate(sid);
          handleAgentEventRef.current?.(event);
        }
      },
      async () => {
        // Journal epoch/cursor loss is explicit. Cursor advancement waits until
        // both snapshot and runtime state have been applied successfully.
        if (sessionIdRef.current !== sid) throw new Error("Session changed during snapshot recovery");
        const controller = new AbortController();
        const messageEpochAtStart = messageMutationEpochRef.current;
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}?includeState`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Snapshot recovery HTTP ${response.status}`);
          const snapshot = await response.json() as SessionDataWithAgentState;
          if (sessionIdRef.current !== sid) throw new Error("Session changed during snapshot recovery");
          const messagesAreCurrent = (
            messageEpochAtStart === messageMutationEpochRef.current
            && !agentRunningRef.current
          );
          applySessionSnapshot(snapshot, messagesAreCurrent);
          // Runtime transient state is rebuilt by the mux baseline. The HTTP
          // snapshot is history/metadata only and must never overwrite it.
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  }, [applySessionSnapshot, applyTransientSnapshot, enqueueMessageUpdate, flushPendingMessageUpdate]);

  const ensureEventsConnected = useCallback((sid: string) => {
    connectEvents(sid);
  }, [connectEvents]);

  const stopStuckAwaitingAgentStart = useCallback(async (sid: string, message: string) => {
    try {
      await sendAgentCommand(sid, { type: "abort" }, { timeoutMs: 8_000 });
    } catch {
      // The backend may already be gone; local unlock is still the right recovery.
    }
    await loadSession(sid);
    if (sessionIdRef.current !== sid) return;
    clearAwaitingAgentStartGuard();
    // 兜底解锁：recovery 后 SSE 断连导致 agent_start/agent_end 丢失时，
    // 这两个 ref 会永久阻塞恢复链路，这里强制重置。
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    abortCompletedRef.current = false;
    awaitingAgentStartRef.current = false;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setStallLevel(null);
    retryInfoRef.current = null;
    setRetryInfo(null);
    dispatch({ type: "end" });
    setLastModelError(message);
    const changedFiles = [...changedFilesRef.current];
    changedFilesRef.current.clear();
    onAgentEnd?.(sid, changedFiles);
  }, [clearAwaitingAgentStartGuard, loadSession, onAgentEnd]);

  const scheduleAwaitingAgentStartGuard = useCallback((sid: string, turnId: number) => {
    clearAwaitingAgentStartGuard(false);
    awaitingAgentStartTimerRef.current = setTimeout(async () => {
      awaitingAgentStartTimerRef.current = null;
      if (
        sessionIdRef.current !== sid
        || turnIdRef.current !== turnId
        || !agentRunningRef.current
        || !awaitingAgentStartRef.current
      ) {
        return;
      }

      awaitingAgentStartChecksRef.current += 1;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({})) as { running?: boolean; status?: AgentStatus };
        await loadSession(sid, false, true);
        if (!awaitingAgentStartRef.current) return;
        if (!d.running || d.status?.isRunning === false) {
          await stopStuckAwaitingAgentStart(sid, "请求已结束但前端没有收到开始事件，已自动恢复界面状态。");
          return;
        }

        connectEvents(sid);
        if (awaitingAgentStartChecksRef.current >= AWAITING_AGENT_START_MAX_CHECKS) {
          await stopStuckAwaitingAgentStart(sid, "请求已提交但长时间没有收到开始事件，已自动中断并解锁界面。");
          return;
        }

        scheduleAwaitingAgentStartGuard(sid, turnId);
      } catch {
        if (awaitingAgentStartChecksRef.current >= AWAITING_AGENT_START_MAX_CHECKS) {
          await stopStuckAwaitingAgentStart(sid, "无法确认后端运行状态，已自动解锁界面。");
          return;
        }
        scheduleAwaitingAgentStartGuard(sid, turnId);
      }
    }, AWAITING_AGENT_START_TIMEOUT_MS);
  }, [clearAwaitingAgentStartGuard, connectEvents, loadSession, stopStuckAwaitingAgentStart]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => {
    agentModeRef.current = agentMode;
  }, [agentMode]);

  useEffect(() => {
    agentPhaseRef.current = agentPhase;
  }, [agentPhase]);

  useEffect(() => {
    autoRecoveryModelsRef.current = autoRecoveryModels;
  }, [autoRecoveryModels]);

  // executeRecovery is declared further down (after handleAgentEvent), but
  // handleAgentEvent needs to trigger it for backend `agent_stale_warning`
  // events. Bridge with a ref to avoid a forward-declaration error.
  const executeRecoveryRef = useRef<(sid: string, attempt?: number, source?: "watchdog" | "stale_warning" | "retry_exhausted" | "manual" | "ttft") => Promise<void>>(async () => {});

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    lastAgentEventAtRef.current = Date.now();
    switch (event.type) {
      case "agent_file_changed": {
        const filePath = event.filePath;
        if (typeof filePath === "string" && filePath.trim()) {
          changedFilesRef.current.add(filePath);
        }
        break;
      }
      case "agent_stale_warning": {
        // Backend is about to destroy this session due to idle timeout.
        // Trigger an immediate recovery so the model can resume instead of
        // being killed. SSE delivers this event even when the tab is
        // backgrounded (EventSource is not throttled like setInterval),
        // closing the gap where the frontend watchdog missed its window.
        const staleEvent = event as { idleMs?: number; destroyInMs?: number };
        console.log('[Watchdog] Received agent_stale_warning from backend', {
          idleMs: staleEvent.idleMs,
          destroyInMs: staleEvent.destroyInMs,
        });
        const staleSid = sessionIdRef.current;
        if (!staleSid || !agentRunningRef.current) break;
        if (autoRecoveryMode === "off") break;
        if (autoContinueSentRef.current) break;
        if (autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES_PER_TURN) {
          console.log('[Watchdog] Max auto-recoveries reached, ignoring stale_warning');
          break;
        }
        // Conservative mode normally only warns, but a backend stale_warning
        // means the session is about to die — escalate to a real recovery.
        //
        // Note: unlike the watchdog setInterval, we do NOT skip this when tools
        // are running. The backend emits stale_warning only after
        // TOOL_EXEC_IDLE_TIMEOUT_MS - LEAD_MS (~28 min) of total silence, which
        // means the tool is almost certainly hung (a healthy npm install / bash
        // produces output that resets the timer). Aborting a truly hung tool is
        // the correct action and strictly better than letting the 30-min hard
        // destroy kill it with no follow_up.
        autoRecoveryAttemptsRef.current += 1;
        console.log('[Watchdog] stale_warning recovery (attempt %d/%d)', autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES_PER_TURN);
        void executeRecoveryRef.current(staleSid, autoRecoveryAttemptsRef.current, "stale_warning");
        break;
      }
      case "agent_start":
        terminalTurnEndedSessionIdRef.current = null;
        turnIdRef.current += 1;
        // A fresh turn has started — reset all per-turn tracking.
        resetTurnTracking();
        // Recovery's fresh turn started — close the abort-swallowing gate so
        // this turn's agent_end is processed normally.
        autoContinueInProgressRef.current = false;
        awaitingAgentStartRef.current = false;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model", reason: "initial" });
        dispatch({ type: "start" });
        break;
      case "agent_end": {
        clearAwaitingAgentStartGuard();
        awaitingAgentStartRef.current = false;
        stopRequestedRef.current = false;
        // If the stale-event protection gate is still open (set by a
        // watchdog recovery cycle that sent abort), and abortCompletedRef
        // has NOT been set yet, this agent_end is from the aborted old
        // turn.  Consume it silently.
        //
        // Once abortCompletedRef is set (either by the abort's agent_end
        // or by the recovery timeout), the gate lets subsequent agent_ends
        // through — otherwise the follow_up's agent_end would be swallowed
        // and the UI would stay stuck in streaming mode indefinitely.
        if (autoContinueInProgressRef.current && !abortCompletedRef.current) {
          abortCompletedRef.current = true;
          break;
        }
        // Reset autoContinueSentRef when a normal agent_end is received.
        // This allows future watchdog recoveries if needed.
        if (autoContinueSentRef.current) {
          console.log('[Watchdog] agent_end received after auto-continue, resetting autoContinueSentRef');
          autoContinueSentRef.current = false;
        }
        stallDismissedRef.current = false;
        stallRecoveriesRef.current = 0;
        setStallLevel(null);
        watchdogStaleRecoveriesRef.current = 0;
        const eventData = event as { willRetry?: boolean; error?: string; errorCode?: string };
        const willRetry = eventData.willRetry ?? false;
        // 持久化失败：用专门文案替代通用「模型调用失败」——这不是模型问题，
        // 重试前需要用户检查磁盘/权限。
        const persistNotice = describeTerminalRunStatus({ errorCode: eventData.errorCode });
        if (persistNotice) {
          setTerminalNoticeState(persistNotice);
        }
        // agent_end carries the backend's most complete terminal diagnosis.
        // Always prefer it over an earlier generic message_end error shell.
        if (eventData.error) {
          lastModelErrorRef.current = eventData.error;
          setLastModelError(eventData.error);
        }
        // Show error if: retries were exhausted (lastModelError is set) OR the turn ended
        // without producing any assistant message (direct failure, auto-retry disabled).
        // Also: tool-call assistant 已到、工具也跑完，但最终文本回复缺失时，
        // 旧逻辑会因 receivedAssistantMessageRef=true 而静默成功——这里强制报错。
        if (
          !willRetry
          && awaitingFinalReplyAfterToolsRef.current
          && !lastModelErrorRef.current
        ) {
          lastModelErrorRef.current = "模型在工具执行后未返回最终回复";
          setLastModelError(lastModelErrorRef.current);
        }
        const endedWithError = (
          (lastModelErrorRef.current !== null) ||
          (!willRetry && !receivedAssistantMessageRef.current) ||
          (!willRetry && awaitingFinalReplyAfterToolsRef.current)
        );
        if (!willRetry && !receivedAssistantMessageRef.current && !lastModelErrorRef.current) {
          lastModelErrorRef.current = "模型响应失败";
          setLastModelError("模型响应失败");
        }
        awaitingFinalReplyAfterToolsRef.current = false;
        // When the agent will retry automatically, keep agentRunning=true so the
        // UI stays in "streaming" mode and prevents accidental user "continue"
        // inputs that would collide with the SDK's auto-retry.
        if (willRetry) {
          // Keep running — auto_retry_end or the next agent_start will update state.
          // Don't clear retryInfo either; auto_retry_start will set it shortly.
          // 只刷新最近消息，避免长会话在每次重试时传输完整历史。
          if (sessionIdRef.current) {
            void loadRecentMessages(sessionIdRef.current, false);
          }
          break;
        }
        terminalTurnEndedSessionIdRef.current = sessionIdRef.current;
        // Any user prompt that reached agent_end was accepted, even if its HTTP
        // acknowledgement was lost and the local bubble was marked unknown.
        setMessages((prev) => prev.map((message) =>
          message.role === "user" && message.deliveryState === "unknown"
            ? withDeliveryState(message, "accepted")
            : message
        ));
        // 同步更新 ref，避免 SSE 重连/看门狗在 React 渲染前仍将旧回合当作运行中。
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        activeSubagentToolIdsRef.current.clear();
        stopSubagentLiveRefresh();
        if (!endedWithError) retryInfoRef.current = null;
    setRetryInfo(null);
        dispatch({ type: "end" });
        setPlanReady(!endedWithError && agentModeRef.current === "plan");
        if (sessionIdRef.current && !endedWithError) {
          // Refresh messages (history) and live agent state independently.
          // History via the lightweight path; runtime state via the dedicated
          // /state endpoint so neither blocks the other (TODO 2).
          void loadRecentMessages(sessionIdRef.current, false);
          void loadSessionState(sessionIdRef.current);
        }
        // 错误回合也只刷新最近窗口；完整历史由用户显式加载。
        if (sessionIdRef.current && endedWithError) {
          void loadRecentMessages(sessionIdRef.current, false);
        }
        const eventChangedFiles = Array.isArray(event.changedFiles) ? event.changedFiles : [];
        for (const filePath of eventChangedFiles) {
          if (typeof filePath === "string" && filePath.trim()) changedFilesRef.current.add(filePath);
        }
        const changedFiles = [...changedFilesRef.current];
        changedFilesRef.current.clear();
        if (sessionIdRef.current) onAgentEnd?.(sessionIdRef.current, changedFiles);

        // === TTFT Recovery: 中转站排队导致首包超时 → 主动切备用模型 ===
        // 服务端 TTFT 超时重试 1 次仍失败后，agent_end 会带 errorCode。
        // errorCode === "UPSTREAM_TTFT_TIMEOUT" 本身排除了用户主动停止
        //（用户 abort 走 aborted 分支，不产生该 errorCode）。
        const ttftErrorCode = (event as { errorCode?: string }).errorCode;
        if (
          ttftErrorCode === "UPSTREAM_TTFT_TIMEOUT" &&
          sessionIdRef.current &&
          autoRecoveryMode !== "off" &&
          autoRecoveryModelsRef.current.length > 0 &&
          !autoContinueSentRef.current &&
          autoRecoveryAttemptsRef.current < MAX_AUTO_RECOVERIES_PER_TURN
        ) {
          autoRecoveryAttemptsRef.current += 1;
          console.log(
            '[TTFT-Recovery] UPSTREAM_TTFT_TIMEOUT — switching to fallback model (attempt %d/%d)',
            autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES_PER_TURN,
          );
          void executeRecoveryRef.current(sessionIdRef.current, autoRecoveryAttemptsRef.current, "ttft");
        }
        break;
      }
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "assistant") {
          const normalizedMsg = normalizeToolCalls(msg as AgentMessage);
          const nextLen = getStreamingContentLength(normalizedMsg);
          if (nextLen !== lastContentLengthRef.current) {
            watchdogStaleRecoveriesRef.current = 0;
            lastContentLengthRef.current = nextLen;
            lastContentChangedAtRef.current = Date.now();
          }
          dispatch({ type: "update", message: normalizedMsg });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        const completedRole = completed?.role;
        if (completed) {
          if (completedRole === "assistant") {
            receivedAssistantMessageRef.current = true;
            const assistant = completed as AssistantMessage;
            const stopReason = assistant.stopReason;
            const hasToolCalls = Array.isArray(assistant.content)
              && assistant.content.some((block) => block?.type === "toolCall");
            // toolUse 回合还要等工具结果后的最终回复；最终文本/错误到来时清除等待标记。
            awaitingFinalReplyAfterToolsRef.current =
              (stopReason === "toolUse" || hasToolCalls)
              && stopReason !== "error"
              && stopReason !== "aborted";
            if (stopReason === "error") {
              const message = assistant.errorMessage
                ?? `模型以错误状态结束，但没有返回错误详情（provider=${assistant.provider || "unknown"}，model=${assistant.model || "unknown"}）。`;
              lastModelErrorRef.current = message;
              setLastModelError(message);
            } else if (stopReason === "length") {
              const message = `模型回复达到单次输出长度上限而提前停止（provider=${assistant.provider || "unknown"}，model=${assistant.model || "unknown"}，stopReason=length）。回复可能不完整，可发送“继续”要求续写。`;
              lastModelErrorRef.current = message;
              setLastModelError(message);
            } else if (stopReason && stopReason !== "stop" && stopReason !== "toolUse" && stopReason !== "aborted") {
              const message = `模型以非正常原因提前停止（provider=${assistant.provider || "unknown"}，model=${assistant.model || "unknown"}，stopReason=${stopReason}）。回复可能不完整。`;
              lastModelErrorRef.current = message;
              setLastModelError(message);
            }
          }
          const normalized = normalizeVisibleUserMessage(normalizeCompletedMessage(completed));
          // 任何完成消息到达都使正在途中的历史快照失去覆盖资格；即使 user echo
          // 最终被 clientMessageId 去重，它也代表快照请求之后发生了新的回合事件。
          messageMutationEpochRef.current += 1;
          setMessages((prev) => {
            // We optimistically append the user's prompt in handleSend/handleFollowUp/handleBuildPlan,
            // each carrying a clientMessageId. DeerHux later emits a message_end for
            // that same user message — dedupe by clientMessageId.
            //
            // If the incoming user message has NO clientMessageId, it was triggered
            // remotely (e.g., WeChat Bot) and the frontend never optimistically
            // appended it — always display it.
            if (normalized.role === "user") {
              const incomingClientMessageId = normalized.clientMessageId;
              if (incomingClientMessageId) {
                const existingIndex = prev.findIndex((m): m is UserMessage => m.role === "user" && m.clientMessageId === incomingClientMessageId);
                if (existingIndex >= 0) {
                  const existing = prev[existingIndex] as UserMessage;
                  if (!existing.deliveryState || existing.deliveryState === "accepted") return prev;
                  const next = [...prev];
                  next[existingIndex] = withDeliveryState(existing, "accepted");
                  return next;
                }

                // loadSession can briefly replace the optimistic user message with
                // the SDK-persisted version before the SSE echo arrives. Older
                // session snapshots may not carry clientMessageId, so the exact-id
                // check above misses. If the echo has an id and the last id-less
                // user message has the same visible text, patch that existing
                // message with the id instead of appending a duplicate.
                const incomingKey = userMessageTextKey(normalized.content);
                if (incomingKey) {
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const candidate = prev[i];
                    if (candidate.role !== "user") continue;
                    if (candidate.clientMessageId) continue;
                    if (userMessageTextKey(candidate.content) !== incomingKey) continue;
                    const next = [...prev];
                    next[i] = { ...normalized, ...candidate, clientMessageId: incomingClientMessageId } as AgentMessage;
                    return next;
                  }
                }
              } else {
                // Some SDK-level user message_end events do not carry DeerHux's
                // clientMessageId. During a local running turn, if we already
                // have an optimistic user message with the same visible text and
                // a clientMessageId, treat this as the SDK echo and suppress it.
                // Remote-triggered messages (WeChat Bot, etc.) have no local
                // optimistic counterpart with an id, so they still append below.
                const incomingKey = userMessageTextKey(normalized.content);
                if (agentRunningRef.current && incomingKey) {
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const candidate = prev[i];
                    if (candidate.role !== "user") continue;
                    if (!candidate.clientMessageId) continue;
                    if (userMessageTextKey(candidate.content) !== incomingKey) continue;
                    return prev;
                  }
                }
              }
              // No clientMessageId (remote-triggered) or id unmatched — append for display
              return [...prev, normalized];
            }
            return [...prev, normalized];
          });
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model", reason: completedRole === "assistant" ? "after_message" : "initial" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        if (name === "subagent") {
          activeSubagentToolIdsRef.current.add(id);
          const sid = sessionIdRef.current;
          if (sid) startSubagentLiveRefresh(sid);
        }
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        if (activeSubagentToolIdsRef.current.delete(id)) {
          const sid = sessionIdRef.current;
          if (sid) finishSubagentLiveRefresh(sid);
        }
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) {
            // 工具刚结束、正在等下一轮模型：重置内容空闲计时，避免把正常 TTFT 当成停滞。
            lastContentChangedAtRef.current = Date.now();
            lastAgentEventAtRef.current = Date.now();
            return { kind: "waiting_model", reason: "after_tool" };
          }
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        // Reset watchdog timers so the retry backoff period doesn't trigger a
        // false-positive stale-detection and a conflicting auto-continue.
        watchdogStaleRecoveriesRef.current = 0;
        lastContentChangedAtRef.current = Date.now();
        const nextRetryInfo: RetryInfo = {
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
          delayMs: event.delayMs as number | undefined,
          errorMessage: event.errorMessage as string | undefined,
          errorCode: event.errorCode as string | undefined,
          userMessage: event.userMessage as string | undefined,
          suggestedAction: event.suggestedAction as string | undefined,
        };
        retryInfoRef.current = nextRetryInfo;
        setRetryInfo(nextRetryInfo);
        break;
      case "auto_retry_end": {
        const retryEndEvent = event as { success?: boolean; finalError?: string };
        if (retryEndEvent.success === false) {
          const retryWasAborted = retryEndEvent.finalError === "aborted" || stopRequestedRef.current;
          const currentRetryInfo = retryInfoRef.current;
          const retrySummary = currentRetryInfo
            ? `${currentRetryInfo.attempt}/${currentRetryInfo.maxAttempts}`
            : "已耗尽";
          const finalError = retryEndEvent.finalError
            ?? currentRetryInfo?.errorMessage
            ?? "模型调用失败";
          const terminalMessage = `自动重试失败（${retrySummary}）：${finalError}`;
          lastModelErrorRef.current = terminalMessage;
          setLastModelError(terminalMessage);
          if (agentRunningRef.current) {
            agentRunningRef.current = false;
            setAgentRunning(false);
            setAgentPhase(null);
            dispatch({ type: "end" });
          }

          // 原路重试耗尽后，自动执行一次与用户“继续”等价的恢复。
          // 使用与看门狗共享的每回合预算，避免上游持续故障时无限循环。
          const sid = sessionIdRef.current;
          if (
            sid
            && !retryWasAborted
            && autoRecoveryMode !== "off"
            && !retryExhaustedRecoveryUsedRef.current
            && !autoContinueSentRef.current
            && !autoContinueInProgressRef.current
            && !isCompactingRef.current
            && agentPhaseRef.current?.kind !== "running_tools"
            && autoRecoveryAttemptsRef.current < MAX_AUTO_RECOVERIES_PER_TURN
          ) {
            retryExhaustedRecoveryUsedRef.current = true;
            autoRecoveryAttemptsRef.current += 1;
            console.log("[Retry-Recovery] retries exhausted; continuing automatically (attempt %d/%d)", autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES_PER_TURN);
            void executeRecoveryRef.current(sid, autoRecoveryAttemptsRef.current, "retry_exhausted");
          }
        }
        retryInfoRef.current = null;
        setRetryInfo(null);
        break;
      }
      case "auto_compaction_start":
      case "compaction_start":
        isCompactingRef.current = true;
        setIsCompacting(true);
        setCompactError(null);
        setCompactionProgress({
          phase: "preparing",
          message: "压缩已开始…",
          updatedAt: Date.now(),
        });
        break;
      case "compaction_progress": {
        const progressEvent = event as {
          phase?: import("@/lib/compaction-ui").CompactionProgressPhase;
          message?: string;
          batchIndex?: number;
          batchTotal?: number;
          tokensBefore?: number;
          tokensAfter?: number;
          model?: { provider?: string; modelId?: string };
        };
        if (progressEvent.phase && progressEvent.message) {
          isCompactingRef.current = true;
          setIsCompacting(true);
          setCompactionProgress({
            phase: progressEvent.phase,
            message: progressEvent.message,
            batchIndex: progressEvent.batchIndex,
            batchTotal: progressEvent.batchTotal,
            tokensBefore: progressEvent.tokensBefore,
            tokensAfter: progressEvent.tokensAfter,
            model: progressEvent.model?.provider && progressEvent.model?.modelId
              ? { provider: progressEvent.model.provider, modelId: progressEvent.model.modelId }
              : undefined,
            updatedAt: Date.now(),
          });
        }
        break;
      }
      case "auto_compaction_end":
      case "compaction_end":
        // Follow-up gates can run before React commits this state update.
        isCompactingRef.current = false;
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactionProgress(null);
        } else if (event.aborted) {
          setCompactionProgress({
            phase: "done",
            message: "压缩已中止",
            updatedAt: Date.now(),
          });
          // 短暂保留「已中止」提示后清掉。
          window.setTimeout(() => {
            setCompactionProgress((prev) => (prev?.message === "压缩已中止" ? null : prev));
          }, 1500);
        } else {
          if (sessionIdRef.current) {
            void loadRecentMessages(sessionIdRef.current, false);
            void loadSessionState(sessionIdRef.current);
          }
          // done 文案通常已由 compaction_progress 推送；若没有则补一条。
          setCompactionProgress((prev) => prev?.phase === "done"
            ? prev
            : {
                phase: "done",
                message: "压缩完成",
                updatedAt: Date.now(),
              });
          window.setTimeout(() => {
            setCompactionProgress((prev) => (prev?.phase === "done" ? null : prev));
          }, 2500);
        }
        break;
    }
  }, [loadSession, loadRecentMessages, onAgentEnd, autoRecoveryMode, startSubagentLiveRefresh, finishSubagentLiveRefresh, stopSubagentLiveRefresh, loadSessionState, setTerminalNoticeState]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[], roleId?: string, references?: FileReference[], skill?: SkillReference) => {
    const sentReferences = references?.length ? references : undefined;
    if (!message.trim() && !images?.length && !sentReferences?.length && !skill) return;
    if (agentRunningRef.current) return;
    // Set the ref immediately to prevent duplicate sends before React re-renders
    agentRunningRef.current = true;
    terminalTurnEndedSessionIdRef.current = null;
    pendingAbortOnSessionReadyRef.current = false;
    turnIdRef.current += 1;
    // Explicitly clear recovery state — a user-initiated send always starts a fresh turn
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    retryExhaustedRecoveryUsedRef.current = false;
    changedFilesRef.current.clear();
    resetTurnTracking();
    autoRecoveryAttemptsRef.current = 0;
    awaitingAgentStartRef.current = true;
    const currentTurnId = turnIdRef.current;
    setPlanReady(false);

    const clientMessageId = createClientMessageId();
    const userMsg: AgentMessage = {
      role: "user",
      content: buildUserContent(message, images),
      ...(sentReferences ? { references: sentReferences } : {}),
      ...(skill ? { skill } : {}),
      clientMessageId,
      deliveryState: "submitting",
      deliveryRetryable: true,
      timestamp: Date.now(),
    };
    pendingUserMessagesRef.current.set(clientMessageId, userMsg);
    messageMutationEpochRef.current += 1;
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model", reason: "initial" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    let optimisticNewSession: SessionInfo | null = null;
    if (!isNew && session) onSessionStarted?.(session);
    if (isNew && newSessionCwd) {
      const optimisticId = `pending-${Date.now().toString(36)}`;
      optimisticSessionIdRef.current = optimisticId;
      optimisticNewSession = {
        id: optimisticId,
        path: "",
        cwd: newSessionCwd,
        name: undefined,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 1,
        firstMessage: message,
      };
      onSessionStarted?.(optimisticNewSession);
    }

    const piImages = images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      filePath: img.filePath,
      mimeType: img.mimeType,
    }));
    let createdRealSession = false;
    let releasePreparedEvents: (() => void) | null = null;

    try {
      if (isNew && newSessionCwd) {
        // Establish the application journal cursor before the real session id
        // exists. Events emitted during /api/agent/new remain replayable after
        // the listener for realId is registered.
        releasePreparedEvents = await prepareAgentEvents();
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        // Single round-trip: create + send prompt in one POST. The backend
        // writes all events to the event-store, and SSE replays them on
        // first connect (getSince returns full history when no Last-Event-ID),
        // so we no longer need a separate `type=create` round-trip.
        const result = await fetchJsonWithRetry<{ sessionId: string }>("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message,
            clientMessageId,
            creationRequestId: clientMessageId,
            capabilities: getTurnCapabilities(),
            agentMode,
            ...(sentReferences ? { references: sentReferences } : {}),
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            ...(roleId ? { roleId } : {}),
            ...(skill ? { skillName: skill.name } : {}),
          }),
        }, {
          // POST retry is safe here because creationRequestId and
          // clientMessageId make both session creation and prompt admission
          // idempotent on the server.
          attempts: 2,
          timeoutMs: 45_000,
        });
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        adoptingCreatedSessionRef.current = realId;
        optimisticSessionIdRef.current = null;
        connectEvents(realId);
        releasePreparedEvents?.();
        releasePreparedEvents = null;
        if (pendingAbortOnSessionReadyRef.current) {
          pendingAbortOnSessionReadyRef.current = false;
          void sendAgentCommand(realId, { type: "abort" }, { timeoutMs: 3_000 }).catch((err) => {
            console.error("Failed to abort pending new session:", err);
          });
        }
        scheduleAwaitingAgentStartGuard(realId, currentTurnId);
        createdRealSession = true;
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
        });
      } else if (session) {
        ensureEventsConnected(session.id);
        scheduleAwaitingAgentStartGuard(session.id, currentTurnId);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          clientMessageId,
          capabilities: getTurnCapabilities(),
          ...(sentReferences ? { references: sentReferences } : {}),
          ...(piImages?.length ? { images: piImages } : {}),
          ...(roleId ? { roleId } : {}),
          ...(skill ? { skillName: skill.name } : {}),
        }, { timeoutMs: 45_000 });
      }
      const acceptedMessage = withDeliveryState(userMsg as UserMessage, "accepted");
      pendingUserMessagesRef.current.set(clientMessageId, acceptedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) => item === userMsg ? acceptedMessage : item));
    } catch (e) {
      if (optimisticNewSession && !createdRealSession) onSessionStarted?.(null);
      awaitingAgentStartRef.current = false;
      clearAwaitingAgentStartGuard();
      optimisticSessionIdRef.current = null;
      adoptingCreatedSessionRef.current = null;
      if (e instanceof ControlPlaneHttpError && e.status >= 400 && e.status < 500) {
        console.warn("Message request rejected:", e.message);
      } else {
        console.error("Failed to send message:", e);
      }
      const errorMessage = e instanceof DOMException && e.name === "AbortError"
        ? "历史会话启动超时，请重试；本次请求已取消，不会在后台继续发送。"
        : e instanceof Error ? e.message : String(e);
      // 400 with images → likely model doesn't support image input
      if (piImages?.length && /400/.test(errorMessage)) {
        lastModelErrorRef.current = errorMessage + " — 该模型可能不支持图片输入，请检查模型配置";
        setLastModelError(lastModelErrorRef.current);
      } else {
        lastModelErrorRef.current = errorMessage;
        setLastModelError(errorMessage);
      }
      // Never delete the user's content. A network/timeout failure is ambiguous:
      // the server may have durably admitted the prompt before the response was
      // lost. Verify the durable receipt once; unresolved cases remain unknown.
      const ambiguous = isAmbiguousAgentCommandError(e);
      const verifySessionId = sessionIdRef.current;
      const wasAccepted = ambiguous && verifySessionId
        ? await verifyPromptAdmission(verifySessionId, clientMessageId)
        : false;
      const deliveryState = wasAccepted ? "accepted" : ambiguous ? "unknown" : "failed";
      const failedMessage = withDeliveryState(userMsg as UserMessage, deliveryState, wasAccepted ? undefined : errorMessage);
      pendingUserMessagesRef.current.set(clientMessageId, failedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) => item === userMsg ? failedMessage : item));
      if (wasAccepted && verifySessionId) {
        // The HTTP response was lost but the durable receipt exists. Keep the
        // live turn and SSE connection intact; normal events will finish it.
        ensureEventsConnected(verifySessionId);
      } else {
        // Reset the ref synchronously so the watchdog and SSE reconnect logic
        // see the correct state immediately — not after the next React render.
        agentRunningRef.current = false;
        pendingAbortOnSessionReadyRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
        eventSubscriptionRef.current?.();
        transientSubscriptionRef.current?.();
        eventSubscriptionRef.current = null;
        transientSubscriptionRef.current = null;
        eventSubscriptionSessionIdRef.current = null;
        cancelPendingMessageUpdate();
      }
    } finally {
      releasePreparedEvents?.();
    }
  }, [isNew, newSessionCwd, newSessionModel, agentMode, thinkingLevel, session, cancelPendingMessageUpdate, connectEvents, ensureEventsConnected, getTurnCapabilities, scheduleAwaitingAgentStartGuard, clearAwaitingAgentStartGuard, onSessionCreated, onSessionStarted, pendingScrollToUserRef]);

  const handleRetryDelivery = useCallback(async (userMessage: UserMessage) => {
    let sid = sessionIdRef.current;
    const clientMessageId = userMessage.clientMessageId;
    const canRetryNewSession = !sid && isNew && Boolean(newSessionCwd);
    if ((!sid && !canRetryNewSession) || !clientMessageId || agentRunningRef.current) return;

    const submittingMessage = withDeliveryState(userMessage, "submitting");
    pendingUserMessagesRef.current.set(clientMessageId, submittingMessage);
    messageMutationEpochRef.current += 1;
    setMessages((prev) => prev.map((item) =>
      item.role === "user" && item.clientMessageId === clientMessageId ? submittingMessage : item
    ));

    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model", reason: "initial" });
    dispatch({ type: "start" });
    if (sid) ensureEventsConnected(sid);

    const imageBlocks = Array.isArray(userMessage.content)
      ? userMessage.content.filter((block): block is ImageContent => block.type === "image")
      : [];
    const images = imageBlocks.flatMap((block) =>
      block.source.type === "base64" && block.source.data
        ? [{ type: "image", data: block.source.data, mimeType: block.source.media_type ?? "image/png" }]
        : []
    );

    try {
      let receipt: { duplicate?: boolean };
      if (sid) {
        receipt = await sendAgentCommand<{ duplicate?: boolean }>(sid, {
          type: "prompt",
          message: userTextContent(userMessage),
          clientMessageId,
          capabilities: getTurnCapabilities(),
          ...(userMessage.references?.length ? { references: userMessage.references } : {}),
          ...(images.length ? { images } : {}),
          ...(userMessage.skill?.name ? { skillName: userMessage.skill.name } : {}),
        }, { timeoutMs: 45_000 });
      } else {
        const selectedModel = newSessionModel;
        const result = await fetchJsonWithRetry<{ sessionId: string; data?: { duplicate?: boolean } }>("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message: userTextContent(userMessage),
            clientMessageId,
            creationRequestId: clientMessageId,
            capabilities: getTurnCapabilities(),
            agentMode,
            ...(userMessage.references?.length ? { references: userMessage.references } : {}),
            ...(images.length ? { images } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            ...(userMessage.skill?.name ? { skillName: userMessage.skill.name } : {}),
          }),
        }, { attempts: 2, timeoutMs: 45_000 });
        sid = result.sessionId;
        sessionIdRef.current = sid;
        adoptingCreatedSessionRef.current = sid;
        connectEvents(sid);
        onSessionCreated?.({
          id: sid,
          path: "",
          cwd: newSessionCwd!,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: userTextContent(userMessage),
        });
        receipt = result.data ?? {};
      }
      const acceptedMessage = withDeliveryState(userMessage, "accepted");
      pendingUserMessagesRef.current.set(clientMessageId, acceptedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) =>
        item.role === "user" && item.clientMessageId === clientMessageId ? acceptedMessage : item
      ));
      if (receipt.duplicate && sid) {
        // The mux transient baseline decides whether the accepted turn is still
        // running; HTTP only refreshes durable message history.
        await loadSession(sid);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const ambiguous = isAmbiguousAgentCommandError(error);
      const wasAccepted = ambiguous && sid ? await verifyPromptAdmission(sid, clientMessageId) : false;
      const state = wasAccepted ? "accepted" : ambiguous ? "unknown" : "failed";
      const failedMessage = withDeliveryState(userMessage, state, wasAccepted ? undefined : errorMessage);
      pendingUserMessagesRef.current.set(clientMessageId, failedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) =>
        item.role === "user" && item.clientMessageId === clientMessageId ? failedMessage : item
      ));
      if (wasAccepted && sid) {
        ensureEventsConnected(sid);
      } else {
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
      }
    }
  }, [agentMode, connectEvents, ensureEventsConnected, getTurnCapabilities, isNew, loadSession, newSessionCwd, newSessionModel, onSessionCreated, thinkingLevel]);

  const forceStopLocally = useCallback((opts?: { keepPendingAbort?: boolean }) => {
    clearAwaitingAgentStartGuard();
    awaitingAgentStartRef.current = false;
    if (!opts?.keepPendingAbort) pendingAbortOnSessionReadyRef.current = false;
    stopRequestedRef.current = false;
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    abortCompletedRef.current = false;
    stallDismissedRef.current = true;
    activeSubagentToolIdsRef.current.clear();
    stopSubagentLiveRefresh();
    agentRunningRef.current = false;
    setAgentRunning(false);
    setIsCompacting(false);
    setCompactionProgress(null);
    setAgentPhase(null);
    setStallLevel(null);
    retryInfoRef.current = null;
    setRetryInfo(null);
    dispatch({ type: "end" });
  }, [clearAwaitingAgentStartGuard, stopSubagentLiveRefresh]);

  const handleAbort = useCallback(async () => {
    if (stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    const sid = sessionIdRef.current;
    if (!sid) {
      if (agentRunningRef.current) pendingAbortOnSessionReadyRef.current = true;
      setAgentPhase({ kind: "stopping" });
      return;
    }

    clearAwaitingAgentStartGuard();
    awaitingAgentStartRef.current = false;
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    setAgentPhase({ kind: "stopping" });
    setStallLevel(null);
    retryInfoRef.current = null;
    setRetryInfo(null);
    // 压缩窗口与普通回合共用停止按钮：后端 abort 已覆盖 abortCompaction，
    // 这里再发一次是兜底，并立刻清掉本地「正在压缩…」文案。
    if (isCompactingRef.current) {
      setIsCompacting(false);
      setCompactionProgress(null);
      void sendAgentCommand(sid, { type: "abort_compaction" }).catch(() => {});
    }
    try {
      const result = await sendAgentCommand<{ stopped?: boolean }>(
        sid,
        { type: "abort", source: "user", reason: "stop_button" },
        { timeoutMs: 3_000 },
      );
      if (result?.stopped) {
        forceStopLocally();
        void loadSession(sid, false, false);
        return;
      }

      // abort 接口只确认“停止信号已送达”。继续观察后端，只有运行态确实归零
      // 才解锁发送，避免 UI 假停后创建并发 turn。
      const deadline = Date.now() + 15_000;
      while (
        stopRequestedRef.current
        && sessionIdRef.current === sid
        && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(2_000),
          });
          if (!res.ok) continue;
          const state = await res.json() as { running?: boolean; status?: AgentStatus };
          if (!state.running || state.status?.isRunning === false) {
            forceStopLocally();
            void loadSession(sid, false, false);
            return;
          }
        } catch {
          // 状态查询失败是 unknown，不等于已停止；继续保持锁定并等待 SSE/下一次查询。
        }
      }

      if (stopRequestedRef.current && sessionIdRef.current === sid) {
        setLastModelError("停止请求已送达，但当前工具仍在安全收尾；完成前不会启动新的回合。");
      }
    } catch (e) {
      console.error("Failed to abort:", e);
      stopRequestedRef.current = false;
      setAgentPhase(null);
      setLastModelError("停止请求发送失败，后端可能仍在运行，请重试。");
    }
  }, [clearAwaitingAgentStartGuard, forceStopLocally, loadSession]);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async (opts?: { provider?: string; modelId?: string }) => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    try {
      await sendAgentCommand(sid, {
        type: "compact",
        ...(opts?.provider && opts?.modelId
          ? { provider: opts.provider, modelId: opts.modelId }
          : {}),
      });
      // compaction_end 的 SSE handler 会刷新消息；这里仅做同键后台兜底。
      // showLoading=false 可与 SSE 刷新共享 inflight，避免压缩后并发读取大型 session。
      void loadSession(sid, false, false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCompactError(message);
      throw e instanceof Error ? e : new Error(message);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const sentReferences = references?.length ? references : undefined;
    messageMutationEpochRef.current += 1;
    setMessages((prev) => [...prev, {
      role: "user",
      content: buildUserContent(`[steer] ${message}`, images),
      ...(sentReferences ? { references: sentReferences } : {}),
      ...(skill ? { skill } : {}),
      timestamp: Date.now(),
    } as AgentMessage]);
    const piImages = images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      filePath: img.filePath,
      mimeType: img.mimeType,
    }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        capabilities: getTurnCapabilities(),
        ...(sentReferences ? { references: sentReferences } : {}),
        ...(piImages?.length ? { images: piImages } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, [getTurnCapabilities]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const sentReferences = references?.length ? references : undefined;
    const clientMessageId = createClientMessageId();
    const userMsg = {
      role: "user",
      content: buildUserContent(message, images),
      ...(sentReferences ? { references: sentReferences } : {}),
      ...(skill ? { skill } : {}),
      clientMessageId,
      deliveryState: "submitting",
      deliveryRetryable: false,
      timestamp: Date.now(),
    } as AgentMessage;
    pendingUserMessagesRef.current.set(clientMessageId, userMsg);
    messageMutationEpochRef.current += 1;
    setMessages((prev) => [...prev, userMsg]);
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    retryExhaustedRecoveryUsedRef.current = false;
    resetTurnTracking();
    autoRecoveryAttemptsRef.current = 0;
    const piImages = images?.map((img) => ({
      type: "image" as const,
      data: img.data,
      filePath: img.filePath,
      mimeType: img.mimeType,
    }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        clientMessageId,
        capabilities: getTurnCapabilities(),
        ...(sentReferences ? { references: sentReferences } : {}),
        ...(piImages?.length ? { images: piImages } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      });
      const acceptedMessage = withDeliveryState(userMsg as UserMessage, "accepted");
      pendingUserMessagesRef.current.set(clientMessageId, acceptedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) => item === userMsg ? acceptedMessage : item));
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      // Follow-up queue commands are not prompt-idempotent yet, so keep the
      // content visible but mark them failed instead of offering unsafe retry.
      const failedMessage = withDeliveryState(userMsg as UserMessage, "failed", errorMessage);
      pendingUserMessagesRef.current.set(clientMessageId, failedMessage);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.map((item) => item === userMsg ? failedMessage : item));
      console.error("Failed to follow up:", e);
    }
  }, [getTurnCapabilities]);

  // Watchdog thresholds - can be configured via environment variables
  const WATCHDOG_STALE_EVENT_MS = parseInt(process.env.NEXT_PUBLIC_WATCHDOG_STALE_EVENT_MS || '', 10) || 60_000;  // 60 seconds (was 30s)
  const WATCHDOG_STALE_CONTENT_MS = parseInt(process.env.NEXT_PUBLIC_WATCHDOG_STALE_CONTENT_MS || '', 10) || 90_000;  // 90 seconds (was 45s)

  // Shared recovery flow: sends a single atomic `recover` command.
  // Used by both the automatic watchdog (tiered) and the manual "中断并继续" button.
  //
  // Backend handles: abort + settle + optional set_model + fresh prompt turn.
  // This replaces the old manual abort + while-wait + sleep(150) + follow_up.
  const executeRecovery = useCallback(async (
    sid: string,
    attempt = 1,
    source: "watchdog" | "stale_warning" | "retry_exhausted" | "manual" | "ttft" = "watchdog",
  ) => {
    if (autoContinueSentRef.current) return;
    autoContinueSentRef.current = true;
    setStallLevel("recovering");
    const fallbackModel = autoRecoveryModelsRef.current[attempt - 1] ?? null;

    autoContinueInProgressRef.current = true;
    abortCompletedRef.current = false;

    // Ensure SSE is connected so recovery events arrive promptly.
    connectEvents(sid);

    try {
      // Backend atomically: abort + settle + optional set_model + fresh prompt
      // turn. The continue message is echoed back via message_end/user SSE.
      await sendAgentCommand(sid, {
        type: "recover",
        source,
        reason: source === "retry_exhausted" ? "auto_retry_exhausted" : source,
        message: AUTO_CONTINUE_MESSAGE,
        capabilities: getTurnCapabilities(),
        ...(fallbackModel ? { provider: fallbackModel.provider, modelId: fallbackModel.modelId } : {}),
      });
      if (fallbackModel) setCurrentModelOverride(fallbackModel);
      // Capture any partial output from the aborted turn.
      await loadSession(sid);
      setStallLevel(null);
      // Gate is closed by agent_start handler when the recovery's fresh turn
      // begins, not here — the abort's agent_end may still be in-flight.
      // Arm the awaiting-start guard so that if SSE drops the recovery's
      // agent_start/agent_end, stopStuckAwaitingAgentStart will forcibly
      // reset the recovery refs instead of leaving them stuck forever.
      awaitingAgentStartRef.current = true;
      scheduleAwaitingAgentStartGuard(sid, turnIdRef.current);
    } catch (e) {
      console.error("Recovery failed:", e);
      autoContinueInProgressRef.current = false;
      autoContinueSentRef.current = false;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setStallLevel(null);
      dispatch({ type: "end" });
    }
  }, [connectEvents, getTurnCapabilities, loadSession, scheduleAwaitingAgentStartGuard]);

  // Keep executeRecoveryRef in sync so handleAgentEvent (declared above) can
  // invoke the latest version without listing it as a dependency.
  useEffect(() => {
    executeRecoveryRef.current = executeRecovery;
  }, [executeRecovery]);

  // Keep a lightweight UI-facing counter so users can see when the watchdog is
  // getting close to intervening.
  useEffect(() => {
    if (!agentRunning || streamRenderPriority !== "focused") {
      setWatchdogInfo(null);
      return;
    }

    const update = () => {
      const now = Date.now();
      setWatchdogInfo({
        eventIdleMs: now - lastAgentEventAtRef.current,
        contentIdleMs: now - lastContentChangedAtRef.current,
        eventThresholdMs: WATCHDOG_STALE_EVENT_MS,
        contentThresholdMs: WATCHDOG_STALE_CONTENT_MS,
      });
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [agentRunning, streamRenderPriority, WATCHDOG_STALE_CONTENT_MS, WATCHDOG_STALE_EVENT_MS]);

  // Tiered business watchdog: detects stalled model turns and provides
  // configurable auto-recovery (off / conservative / aggressive).
  //
  // Phase 1 (warning):  show UI banner with manual "续跑" button
  // Phase 2 (reconnect): auto reconnect SSE
  // Phase 3 (auto-recover): abort + follow_up with continue message
  //
  // Skips when: tools are running, compacting, retrying, or mode is "off".
  // Uses longer thresholds for high/xhigh thinking levels.
  useEffect(() => {
    if (!agentRunning || autoRecoveryMode === "off") return;

    // Base thresholds per mode
    const isAggressive = autoRecoveryMode === "aggressive";
    const baseWarningMs = isAggressive ? 30_000 : 60_000;
    const baseReconnectMs = isAggressive ? 60_000 : 120_000;
    // 激进按钮固定 120s 自动续跑；不再被思考级别 xhigh/high 放大。
    const baseRecoverMs = isAggressive ? 120_000 : 0; // 0 = never auto-recover in conservative

    // warning / reconnect 仍可按思考级别略放宽；recoverMs 与按钮绑定保持 120s。
    const thinkingMultiplier =
      thinkingLevel === "xhigh" ? 2.0 :
      thinkingLevel === "high" ? 1.5 : 1.0;
    const warningMs = Math.round(baseWarningMs * thinkingMultiplier);
    const reconnectMs = Math.round(baseReconnectMs * thinkingMultiplier);
    const recoverMs = baseRecoverMs;

    const CHECK_INTERVAL_MS = 5_000;

    // Recover: abort current stuck stream, reload session, and send
    // follow_up with a clear continue instruction so the model resumes
    // without duplicating completed content.
    const recoverWithContinue = async (sid: string) => {
      await executeRecovery(sid, autoRecoveryAttemptsRef.current, "watchdog");
    };

    // Session already finished — just reload and stop gracefully
    const recoverStop = async (sid: string, diagnostic: string) => {
      await loadSession(sid);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setStallLevel(null);
      dispatch({ type: "end" });
      autoContinueSentRef.current = false;
      lastModelErrorRef.current = diagnostic;
      setLastModelError(diagnostic);
    };

    const id = setInterval(async () => {
      const sid = sessionIdRef.current;
      if (!sid || !agentRunningRef.current || watchdogCheckingRef.current) return;

      // Never trigger recovery while tools are running or compacting or retrying
      if (agentPhaseRef.current?.kind === "running_tools") {
        lastAgentEventAtRef.current = Date.now();
        lastContentChangedAtRef.current = Date.now();
        return;
      }
      if (retryInfo) {
        lastAgentEventAtRef.current = Date.now();
        return;
      }

      const now = Date.now();
      const contentIdleMs = now - lastContentChangedAtRef.current;
      // Primary signal: streaming content hasn't changed
      const noContentGrowth = lastContentLengthRef.current > 0 && contentIdleMs > warningMs;
      // Secondary signal: no events at all, with empty content
      const noEventNoContent = lastContentLengthRef.current === 0 && now - lastAgentEventAtRef.current > warningMs;
      if (!noContentGrowth && !noEventNoContent) return;

      // User dismissed the warning for this turn — don't escalate
      if (stallDismissedRef.current) return;

      console.log('[Watchdog] Stale detected:', {
        contentIdleMs,
        eventIdleMs: now - lastAgentEventAtRef.current,
        contentLength: lastContentLengthRef.current,
        stallRecoveries: stallRecoveriesRef.current,
        mode: autoRecoveryMode,
        warningMs,
        reconnectMs,
        recoverMs,
      });

      watchdogCheckingRef.current = true;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({})) as { running?: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean }; status?: AgentStatus };
        const status = d.status;
        await loadSession(sid, false, true);
        if (Date.now() - lastContentChangedAtRef.current < warningMs) {
          setStallLevel(null);
          return;
        }

        // Backend compacting — reconnect and wait
        if (d.running && (d.state?.isCompacting || status?.isCompacting)) {
          connectEvents(sid);
          lastAgentEventAtRef.current = Date.now();
          lastContentChangedAtRef.current = Date.now();
          return;
        }

        // Backend already stopped — reload and stop.
        // Use isRunning (tracks active turn: agent_start → agent_end)
        // instead of isStreaming, which is false during normal gaps like
        // waiting-for-model or between tool-execution batches.
        if (!d.running || d.status?.isRunning === false) {
          console.log('[Watchdog] Backend stopped, calling recoverStop');
          await recoverStop(
            sid,
            `检测到回复停滞后，后端回合已停止，但前端没有收到终止事件（session=${sid}，lastEventType=${status?.lastEventType ?? "unknown"}，eventIdleMs=${status?.eventIdleMs ?? "unknown"}，contentIdleMs=${status?.contentIdleMs ?? "unknown"}）。若回复不完整可发送“继续”。`,
          );
          return;
        }

        // If the last backend event is a completed assistant message, the model
        // is done and the UI is only missing the final agent_end bookkeeping.
        // Do not auto-send "continue" here: the assistant may be waiting for the
        // user to confirm the proposed next step.
        if (
          receivedAssistantMessageRef.current
          && status?.lastEventType === "message_end"
          && d.state?.isStreaming !== true
          && status?.isStreaming !== true
        ) {
          console.log('[Watchdog] Assistant message completed without agent_end, stopping locally');
          await recoverStop(
            sid,
            `模型消息已经结束，但服务端没有发送回合终止事件（session=${sid}，lastEventType=message_end，contentIdleMs=${status?.contentIdleMs ?? "unknown"}）。已在前端解除运行状态；若回复不完整可发送“继续”。`,
          );
          return;
        }

        // Backend still streaming — check tiered actions
        stallRecoveriesRef.current += 1;

        // Phase 1: Show warning banner (first detection)
        if (contentIdleMs >= warningMs && stallLevel !== "warning" && stallLevel !== "recovering") {
          console.log('[Watchdog] Phase 1: showing warning');
          setStallLevel("warning");
        }

        // Phase 2: Auto reconnect SSE (conservative: +60s, aggressive: +60s after warning)
        if (contentIdleMs >= reconnectMs) {
          console.log('[Watchdog] Phase 2: reconnecting SSE');
          connectEvents(sid);
          lastAgentEventAtRef.current = Date.now();
        }

        // Phase 3: Auto recover (aggressive mode only, after recoverMs)
        // Circuit breaker: max 3 auto-recoveries per logical user turn.
        // Without this, aggressive mode could loop indefinitely when the
        // model consistently fails (bad API key, persistent provider error).
        if (recoverMs > 0 && contentIdleMs >= recoverMs && !autoContinueSentRef.current) {
          if (autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES_PER_TURN) {
            console.log('[Watchdog] Max auto-recoveries (%d) reached, stopping', MAX_AUTO_RECOVERIES_PER_TURN);
            await recoverStop(
              sid,
              `模型响应持续停滞，自动恢复已达到上限（${MAX_AUTO_RECOVERIES_PER_TURN} 次，session=${sid}，eventIdleMs=${status?.eventIdleMs ?? "unknown"}，contentIdleMs=${status?.contentIdleMs ?? contentIdleMs}）。已停止自动续写，请检查模型服务或手动发送“继续”。`,
            );
            return;
          }
          autoRecoveryAttemptsRef.current += 1;
          console.log('[Watchdog] Phase 3: auto-recovering (attempt %d/%d)', autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES_PER_TURN);
          await recoverWithContinue(sid);
          return;
        }

      } catch (e) {
        console.error("Agent watchdog failed:", e);
      } finally {
        watchdogCheckingRef.current = false;
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(id);
  }, [agentRunning, autoRecoveryMode, thinkingLevel, connectEvents, loadSession, retryInfo, stallLevel, executeRecovery]);

  // Visibility recovery: when the tab becomes visible again after being
  // backgrounded, the watchdog setInterval above may have been throttled
  // (Chrome throttles background timers to ~1/min) and missed the aggressive
  // recovery window. Run an immediate check and recover if the turn is stale.
  // This complements the backend `agent_stale_warning` event (which fires much
  // later, right before idle destroy) by catching stalls earlier in
  // aggressive mode once the user returns to the tab.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!agentRunningRef.current) return;
      if (autoRecoveryMode === "off") return;
      if (autoContinueSentRef.current) return;
      // Skip while tools are running — tool execution has its own longer
      // backend idle budget (TOOL_EXEC_IDLE_TIMEOUT_MS).
      if (agentPhaseRef.current?.kind === "running_tools") return;
      if (retryInfo) return;

      const isAggressive = autoRecoveryMode === "aggressive";
      // 与主 watchdog 一致：激进 = 固定 120s，不随思考级别放大。
      const recoverMs = isAggressive ? 120_000 : 0;
      if (recoverMs <= 0) return;

      const contentIdleMs = Date.now() - lastContentChangedAtRef.current;
      if (contentIdleMs < recoverMs) return;
      // Require at least some content to have been received — recovering an
      // empty turn that never produced output is likely to loop.
      if (lastContentLengthRef.current === 0) return;

      if (autoRecoveryAttemptsRef.current >= MAX_AUTO_RECOVERIES_PER_TURN) return;
      const visSid = sessionIdRef.current;
      if (!visSid) return;

      autoRecoveryAttemptsRef.current += 1;
      console.log('[Watchdog] visibilitychange recovery (attempt %d/%d), contentIdleMs=%d', autoRecoveryAttemptsRef.current, MAX_AUTO_RECOVERIES_PER_TURN, contentIdleMs);
      void executeRecovery(visSid, autoRecoveryAttemptsRef.current, "watchdog");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [autoRecoveryMode, retryInfo, executeRecovery]);

  // Manual recovery trigger — user clicks "中断并继续" when stall warning shown
  const handleAutoRecover = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !agentRunningRef.current) return;
    stallDismissedRef.current = true;
    // Reset auto-recovery counter — a manual user action indicates the user
    // is actively engaged and the watchdog should get a fresh allowance.
    autoRecoveryAttemptsRef.current = 0;
    await executeRecovery(sid, 1, "manual");
  }, [executeRecovery]);

  // User dismissed the stall warning — suppress further escalation this turn
  const handleDismissStall = useCallback(() => {
    stallDismissedRef.current = true;
    setStallLevel(null);
  }, []);

  // Persist auto-recovery mode to localStorage，并同步到后端（影响 TTFT 120s）。
  const handleAutoRecoveryModeChange = useCallback((mode: AutoRecoveryMode) => {
    autoRecoveryModeRef.current = mode;
    setAutoRecoveryModeState(mode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("deerhux.auto-recovery-mode", mode);
    }
    const sid = sessionIdRef.current;
    if (sid) {
      void sendAgentCommand(sid, { type: "set_auto_recovery_mode", mode }).catch((e) => {
        console.error("Failed to sync auto recovery mode:", e);
      });
    }
  }, []);

  // Flip the subagent capability toggle: persists to localStorage and pushes
  // the new state to the current session (if any).
  const handleSubagentToggle = useCallback(() => {
    const next = !subagentEnabledRef.current;
    subagentEnabledRef.current = next;
    setSubagentEnabledState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("deerhux.subagent-enabled", String(next));
    }
    const sid = sessionIdRef.current;
    if (sid) {
      sendAgentCommand(sid, { type: "set_subagent_enabled", enabled: next }).catch((e) => {
        console.error("Failed to toggle subagent capability:", e);
      });
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
      setCompactionProgress({
        phase: "done",
        message: "正在停止压缩…",
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
      setCompactError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    const previousLevel = thinkingLevel;
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves DeerHux's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      // Roll back to the previous level on failure so the UI doesn't
      // show a stale selection that doesn't match backend reality.
      setThinkingLevel(previousLevel);
    }
  }, [thinkingLevel]);

  const handleToolPresetChange = useCallback(async (preset: Exclude<ToolPreset, "custom">) => {
    const { PRESET_NONE, PRESET_DEFAULT, PRESET_FULL } = await import("@/components/ToolPanel");
    const toolNames = preset === "none" ? PRESET_NONE : preset === "default" ? PRESET_DEFAULT : PRESET_FULL;
    const previousPreset = toolPreset;
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
      // Roll back to the previous preset on failure.
      setToolPresetState(previousPreset);
    }
  }, [setToolPresetState, toolPreset]);

  const handleAgentModeChange = useCallback(async (mode: AgentMode) => {
    const nextMode = normalizeAgentMode(mode);
    const previousMode = agentModeRef.current;
    setAgentMode(nextMode);
    agentModeRef.current = nextMode;
    setPlanReady(false);
    setToolPresetState(nextMode === "agent" ? "default" : "custom");
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ mode?: AgentMode; systemPrompt?: string }>(sid, { type: "set_mode", mode: nextMode });
      if (result?.mode) {
        const normalized = normalizeAgentMode(result.mode);
        setAgentMode(normalized);
        agentModeRef.current = normalized;
      }
      if (result?.systemPrompt !== undefined) setSystemPrompt(result.systemPrompt ?? null);
    } catch (e) {
      console.error("Failed to set agent mode:", e);
      setAgentMode(previousMode);
      agentModeRef.current = previousMode;
    }
  }, [setToolPresetState]);

  const handleBuildPlan = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || agentRunningRef.current) return;
    await handleAgentModeChange("agent");
    setPlanReady(false);
    agentRunningRef.current = true;
    turnIdRef.current += 1;
    const currentTurnId = turnIdRef.current;
    autoContinueSentRef.current = false;
    autoContinueInProgressRef.current = false;
    resetTurnTracking();
    autoRecoveryAttemptsRef.current = 0;
    awaitingAgentStartRef.current = true;
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model", reason: "initial" });
    dispatch({ type: "start" });
    const clientMessageId = createClientMessageId();
    const userMsg = {
      role: "user",
      content: "请按刚才用户批准的计划开始实施。",
      clientMessageId,
      timestamp: Date.now(),
    } as AgentMessage;
    pendingUserMessagesRef.current.set(clientMessageId, userMsg);
    messageMutationEpochRef.current += 1;
    setMessages((prev) => [...prev, userMsg]);
    try {
      connectEvents(sid);
      scheduleAwaitingAgentStartGuard(sid, currentTurnId);
      await sendAgentCommand(sid, {
        type: "follow_up",
        message: "请按刚才用户批准的计划开始实施。",
        clientMessageId,
        capabilities: getTurnCapabilities(),
      });
    } catch (e) {
      awaitingAgentStartRef.current = false;
      clearAwaitingAgentStartGuard();
      pendingUserMessagesRef.current.delete(clientMessageId);
      messageMutationEpochRef.current += 1;
      setMessages((prev) => prev.filter((msg) => msg !== userMsg));
      console.error("Failed to build plan:", e);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      setLastModelError(e instanceof Error ? e.message : String(e));
    }
  }, [clearAwaitingAgentStartGuard, connectEvents, getTurnCapabilities, handleAgentModeChange, scheduleAwaitingAgentStartGuard]);

  const activeSessionId = session?.id;

  // Load or reset session when the active tab changes. Previously AppShell
  // forced a full ChatWindow remount via key={sessionKey}; responding to prop
  // changes here keeps the component tree alive and makes tab switches cheaper.
  useEffect(() => {
    const sessionId = activeSessionId;
    // If this Session is already fully subscribed, there is nothing to rebuild.
    // Checking the live subscription as well as sessionIdRef is required for
    // React Strict Mode: its simulated cleanup removes listeners while retaining refs.
    if (
      sessionId
      && sessionId === sessionIdRef.current
      && eventSubscriptionSessionIdRef.current === sessionId
      && eventSubscriptionRef.current
      && transientSubscriptionRef.current
    ) return;
    // If a brand-new session just received its real id, handleSend has already
    // connected SSE and populated optimistic messages. Do not tear it down just
    // because AppShell replaced the placeholder tab with the real session tab.
    if (
      sessionId
      && (sessionId === optimisticSessionIdRef.current || sessionId === adoptingCreatedSessionRef.current)
      && eventSubscriptionSessionIdRef.current === sessionId
      && eventSubscriptionRef.current
      && transientSubscriptionRef.current
    ) {
      adoptingCreatedSessionRef.current = null;
      return;
    }

    let cancelled = false;

    // This view is leaving its current Session. Do not dispatch a delayed update
    // into an about-to-reset tree; terminal events already flush synchronously.
    cancelPendingMessageUpdate();
    eventSubscriptionRef.current?.();
    transientSubscriptionRef.current?.();
    eventSubscriptionRef.current = null;
    transientSubscriptionRef.current = null;
    eventSubscriptionSessionIdRef.current = null;
    // Abort any inflight background loadSession / polling requests from the
    // previous session so they don't keep hitting the backend (and racing
    // this new session's requests). A fresh controller is installed for the
    // new session.
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = new AbortController();
    loadSessionInflightRef.current = null;
    pendingUserMessagesRef.current.clear();
    messageMutationEpochRef.current += 1;
    messageSnapshotRequestSeqRef.current += 1;
    activeSubagentToolIdsRef.current.clear();
    stopSubagentLiveRefresh();
    agentRunningRef.current = false;
    awaitingAgentStartRef.current = false;
    optimisticSessionIdRef.current = null;
    pendingAbortOnSessionReadyRef.current = false;
    stopRequestedRef.current = false;
    adoptingCreatedSessionRef.current = null;
    autoContinueSentRef.current = false;
    watchdogStaleRecoveriesRef.current = 0;
    autoRecoveryAttemptsRef.current = 0;
    stallDismissedRef.current = false;
    stallRecoveriesRef.current = 0;
    setStallLevel(null);
    resetAutoScroll();
    changedFilesRef.current.clear();
    lastAgentEventAtRef.current = Date.now();
    lastContentChangedAtRef.current = Date.now();
    lastContentLengthRef.current = 0;
    lastModelErrorRef.current = null;
    setLastModelError(null);
    receivedAssistantMessageRef.current = false;
    retryInfoRef.current = null;
    setRetryInfo(null);
    setContextUsage(null);
    const cachedHistory = sessionId ? getSessionHistorySnapshot(sessionId) : null;
    fullHistoryLoadedRef.current = cachedHistory?.fullHistoryLoaded ?? false;
    setHasOlderMessages(cachedHistory?.hasOlderMessages ?? false);
    setSystemPrompt(null);
    setForkingEntryId(null);
    setIsCompacting(false);
    setCompactError(null);
    setAgentPhase(null);
    setWatchdogInfo(null);
    dispatch({ type: "reset" });

    if (!sessionId) {
      sessionIdRef.current = null;
      setData(null);
      setMessages([]);
      setEntryIds([]);
      setCurrentModelOverride(null);
      setPendingModel(null);
      setAgentMode("agent");
      agentModeRef.current = "agent";
      setPlanReady(false);
      setAgentRunning(false);
      setError(null);
      setLoading(false);
      return () => { cancelled = true; };
    }

    sessionIdRef.current = sessionId;
    historySnapshotInvalidRef.current = false;
    setData(null);
    // A session can be remounted when workspace slots are reordered. Restore
    // its cached render snapshot before the recent-page request so complete
    // history never flashes empty or silently regresses to the tail page.
    setMessages(cachedHistory?.messages ?? []);
    setEntryIds(cachedHistory?.entryIds ?? []);
    fullHistoryLoadedRef.current = cachedHistory?.fullHistoryLoaded ?? false;
    setHasOlderMessages(cachedHistory?.hasOlderMessages ?? false);
    setLoading(!cachedHistory);
    setCurrentModelOverride(null);
    setPendingModel(null);
    setPlanReady(false);
    setAgentRunning(false);
    setError(null);

    // Subscribe before reading the snapshot. Any event emitted while the
    // snapshot request is in flight is delivered through the journal channel
    // and protected by messageMutationEpochRef from stale snapshot overwrite.
    connectEvents(sessionId);
    // Open session: load RECENT messages first (TODO 3 pagination) — this is a
    // cheaper first paint than the full GET /api/sessions/:id. Runtime state
    // is then fetched asynchronously (TODO 2) so neither a busy runtime nor a
    // huge history can block the first paint.
    loadRecentMessages(sessionId, true).then(() => {
      if (cancelled || sessionIdRef.current !== sessionId) return;

      // Fetch non-transient runtime metadata asynchronously. Running,
      // streaming, compacting and thinking level come from the mux baseline.
      void loadSessionState(sessionId);
    });

    const activeSubagentToolIds = activeSubagentToolIdsRef.current;
    return () => {
      cancelled = true;
      cancelPendingMessageUpdate();
      // Only tear down the subscription installed for this Effect run. This
      // prevents a stale cleanup from removing a newer Session subscription.
      if (eventSubscriptionSessionIdRef.current === sessionId) {
        eventSubscriptionRef.current?.();
        transientSubscriptionRef.current?.();
        eventSubscriptionRef.current = null;
        transientSubscriptionRef.current = null;
        eventSubscriptionSessionIdRef.current = null;
      }
      activeSubagentToolIds.clear();
      stopSubagentLiveRefresh();
    };
  }, [cancelPendingMessageUpdate, connectEvents, loadRecentMessages, loadSession, loadSessionState, loadTools, activeTabId, newSessionCwd, activeSessionId, resetAutoScroll, stopSubagentLiveRefresh]);

  useEffect(() => {
    messagesRef.current = messages;
    entryIdsRef.current = entryIds;
  }, [messages, entryIds]);

  useEffect(() => {
    hasOlderMessagesRef.current = hasOlderMessages;
  }, [hasOlderMessages]);

  // Snapshot at the boundary where a session view actually leaves. This avoids
  // a prop-switch render writing the old session's arrays under the new id.
  // The referenced data is render-only; subscriptions/timers are cleaned up by
  // the session effect and are deliberately never retained here.
  useEffect(() => {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    return () => {
      if (historySnapshotInvalidRef.current) return;
      saveSessionHistorySnapshot(sessionId, {
        messages: messagesRef.current,
        entryIds: entryIdsRef.current,
        fullHistoryLoaded: fullHistoryLoadedRef.current,
        hasOlderMessages: hasOlderMessagesRef.current,
      });
    };
  }, [activeSessionId]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    syncAfterMessageChange(messages.length, agentRunningRef.current);
  }, [messages.length, agentRunning, syncAfterMessageChange]);

  // Load cached control-plane data immediately, then revalidate. A saturated
  // backend must never turn one transient models request failure into a missing
  // selector for the rest of the page lifetime.
  useEffect(() => {
    let cancelled = false;
    const applyModels = (d: ModelsResponse) => {
      if (cancelled || !isUsableModelsResponse(d)) return;
      setModelsLoadError(null);
      setModelNames(d.models);
      setAutoRecoveryModels(d.autoRecoveryModels ?? []);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      // Never erase a known-good selector with an unexpected transient empty
      // response. A genuinely empty config has no prior cache to preserve.
      if (d.modelList.length > 0) {
        setModelList(d.modelList);
        if (isNew) {
          const def = d.defaultModel;
          const match = def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    };

    const cached = readCachedJson<ModelsResponse>(MODELS_CACHE_KEY);
    if (isUsableModelsResponse(cached)) applyModels(cached);
    fetchModels().then(applyModels).catch((error: unknown) => {
      // Stale data remains usable; the next mount/config event revalidates.
      if (!cancelled) setModelsLoadError(describeModelsLoadError(error));
    });
    return () => { cancelled = true; };
  }, [isNew, modelsRefreshKey, modelsConfigVersion, setNewSessionModel]);

  useEffect(() => {
    return subscribeToAppNotification("deerhux.models-updated", () => {
      bumpModelsConfigVersion();
    });
  }, []);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  return {
    // State
    data, loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelsLoadError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, agentMode, planReady, thinkingLevel,
    retryInfo, contextUsage, systemPrompt: systemPrompt ?? lastSystemPromptRef.current, forkingEntryId,
    isCompacting, compactionProgress, clearCompactionProgress: () => setCompactionProgress(null), compactError, lastModelError, terminalNotice, clearTerminalNotice, currentModel, displayModel, sessionStats,
    agentPhase, watchdogInfo, stallLevel, autoRecoveryMode,
    subagentEnabled,
    isNew,
    // TODO 3 — first-paint pagination affordance
    hasOlderMessages, loadingFullHistory, loadFullHistory,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleRetryDelivery, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleAgentModeChange, handleBuildPlan, handleThinkingLevelChange, loadTools, setData, setMessages,
    setSystemPrompt, setLastModelError, handleAutoRecover, handleDismissStall, handleAutoRecoveryModeChange, handleSubagentToggle,
    dispatch, setAgentRunning, setForkingEntryId,
  };
}
