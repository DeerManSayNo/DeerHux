"use client";

import { useState, useCallback, useRef, useEffect, useReducer, useMemo } from "react";
import { getLocalStorageItem } from "@/lib/client-storage";
import type { AgentMessage, AssistantMessage, FileReference, ImageContent, SessionInfo, SkillReference, TextContent, UserMessage } from "@/lib/types";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";
import { normalizeCompletedMessage, normalizeCompletedMessages, normalizeToolCalls } from "@/lib/normalize";
import { agentEventBus } from "@/lib/agent-event-bus";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry } from "@/components/ToolPanel";
import { extractTurnMode, normalizeAgentMode, stripTurnModeContext, type AgentMode } from "@/lib/agent-modes";

type ToolPreset = "none" | "default" | "full" | "custom";
const AUTO_CONTINUE_MESSAGE = "请从刚才中断的位置继续，不要重复已经完成的内容。如果上一步有未完成的工具调用或代码修改，请继续完成。";

function createClientMessageId(): string {
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  };
}

type SessionDataWithAgentState = SessionData & { agentState?: AgentStatePayload };

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
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

let modelsPromise: Promise<ModelsResponse> | null = null;

function fetchModels(): Promise<ModelsResponse> {
  if (modelsPromise) return modelsPromise;

  modelsPromise = fetch("/api/models", { cache: "no-store" })
    .then((r) => r.json() as Promise<ModelsResponse>)
    .finally(() => {
      modelsPromise = null;
    });
  return modelsPromise;
}

export type AgentPhase =
  | { kind: "waiting_model"; reason: "initial" | "after_message" | "after_tool" | "restored" | "recovery" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | { kind: "stopping" }
  | null;

export interface UseAgentSessionOptions {
  activeTabId?: string | null;
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
  insertIfEmpty: (content: string) => void;
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

/**
 * loadSession 读出的消息来自 SDK 存盘文件，不含 clientMessageId。直接用它
 * 覆盖本地会丢失 handleSend/handleFollowUp 乐观 push 的 id，导致后续
 * message_end/user echo 的 clientMessageId dedupe 失效而出现重复用户消息。
 * 这里按文本签名把本地待确认的 id 迁移到 loaded 对应消息上。
 */
function mergeOptimisticClientMessageIds(prev: AgentMessage[], loaded: AgentMessage[]): AgentMessage[] {
  if (!prev.length) return loaded;
  const pendingIds = new Map<string, string>();
  for (const m of prev) {
    if (m.role === "user" && m.clientMessageId) {
      pendingIds.set(userMessageTextKey(m.content), m.clientMessageId);
    }
  }
  if (!pendingIds.size) return loaded;
  let touched = false;
  const merged = loaded.map((m) => {
    if (m.role === "user" && !m.clientMessageId) {
      const id = pendingIds.get(userMessageTextKey(m.content));
      if (id) {
        touched = true;
        return { ...m, clientMessageId: id } as AgentMessage;
      }
    }
    return m;
  });
  return touched ? merged : loaded;
}

function mergePendingUserMessages(loaded: AgentMessage[], pending: AgentMessage[]): AgentMessage[] {
  if (!pending.length) return loaded;

  const loadedClientIds = new Set<string>();
  const loadedTextCounts = new Map<string, number>();
  for (const msg of loaded) {
    if (msg.role !== "user") continue;
    if (msg.clientMessageId) loadedClientIds.add(msg.clientMessageId);
    const key = userMessageTextKey(msg.content);
    if (key) loadedTextCounts.set(key, (loadedTextCounts.get(key) ?? 0) + 1);
  }

  const unresolved: AgentMessage[] = [];
  for (const msg of pending) {
    if (msg.role !== "user") continue;
    if (msg.clientMessageId && loadedClientIds.has(msg.clientMessageId)) continue;
    const key = userMessageTextKey(msg.content);
    const seenCount = key ? loadedTextCounts.get(key) ?? 0 : 0;
    if (seenCount > 0) {
      loadedTextCounts.set(key, seenCount - 1);
      continue;
    }
    unresolved.push(msg);
  }

  return unresolved.length ? [...loaded, ...unresolved] : loaded;
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
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionStarted, onSessionForked,
    modelsRefreshKey, onSystemPromptChange,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(() => !isNew);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string; input?: ("text" | "image")[] }[]>([]);
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
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingFullHistory, setLoadingFullHistory] = useState(false);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [watchdogInfo, setWatchdogInfo] = useState<WatchdogInfo | null>(null);
  const [lastModelError, setLastModelError] = useState<string | null>(null);
  const lastModelErrorRef = useRef<string | null>(null);
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
  const stallRecoveriesRef = useRef(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  // 累计完整 message_update 可能按 token 到达。这里只保留最新快照并按动画帧
  // 提交，避免 React/Markdown 渲染频率被上游事件频率直接放大。
  const pendingMessageUpdateRef = useRef<AgentEvent | null>(null);
  const messageUpdateFrameRef = useRef<number | null>(null);
  const sseReconnectAttemptRef = useRef(0);
  const lastEventSeqRef = useRef(0);
  const sseReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const changedFilesRef = useRef<Set<string>>(new Set());
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const entryIdsRef = useRef<string[]>([]);
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
    promise: Promise<AgentStatePayload | null>;
  } | null>(null);

  const applySessionSnapshot = useCallback((d: SessionDataWithAgentState) => {
    setData(d);
    const { messages: loadedMessages, entryIds: loadedEntryIds } = normalizeLoadedMessages(d.context.messages, d.context.entryIds);
    const prevKey = entryIdsRef.current.join("\0");
    const nextKey = loadedEntryIds.join("\0");
    const changed = Boolean(nextKey && nextKey !== prevKey);
    setMessages((prev) => mergeOptimisticClientMessageIds(prev, loadedMessages));
    setEntryIds(loadedEntryIds);
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

    const hasAssistant = loadedMessages.some((msg) => msg.role === "assistant");
    if (awaitingAgentStartRef.current && (changed || hasAssistant || d.agentState?.running)) {
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
    const inflight = loadSessionInflightRef.current;
    if (!showLoading && inflight && inflight.sid === sid) {
      return inflight.promise;
    }

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
        applySessionSnapshot(d);
        // If no live agent state, fall back to thinking level from session file
        if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
          setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
        }
        return d.agentState ?? null;
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
      loadSessionInflightRef.current = { sid, promise };
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
    const controller = new AbortController();
    const sessionSignal = sessionAbortRef.current?.signal;
    const timeout = setTimeout(() => controller.abort(), showLoading ? 30_000 : 12_000);
    const onSessionAbort = () => controller.abort();
    if (sessionSignal) {
      if (sessionSignal.aborted) controller.abort();
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
        page: { limit: number; returned: number; hasMoreBefore: boolean };
      };
      if (sid !== sessionIdRef.current) return;
      // Shape into SessionData so applySessionSnapshot handles normalization
      // (clientMessageId merge, optimistics, agent-mode restore) identically.
      applySessionSnapshot({
        sessionId: d.sessionId,
        // leafId is not used by applySessionSnapshot's message path; reuse null.
        filePath: "",
        leafId: null,
        context: {
          messages: d.messages,
          entryIds: d.entryIds,
          thinkingLevel: d.thinkingLevel,
          model: d.model,
          roleId: d.roleId ?? null,
          agentMode: d.agentMode,
        },
      });
      setHasOlderMessages(Boolean(d.page?.hasMoreBefore));
      setError(null);
    } catch (e) {
      if (sid === sessionIdRef.current) {
        const isAbort = e instanceof DOMException && e.name === "AbortError";
        if (showLoading) setError(isAbort ? "加载会话超时" : String(e));
        else if (!isAbort) console.warn("[loadRecentMessages] failed:", e);
      }
    } finally {
      clearTimeout(timeout);
      if (sessionSignal) sessionSignal.removeEventListener("abort", onSessionAbort);
      if (showLoading && sid === sessionIdRef.current) setLoading(false);
    }
  }, [applySessionSnapshot]);

  /**
   * Load the FULL session history (fallback for when the recent-messages
   * first paint truncated older messages). Triggered by the user via the
   * "load full history" affordance. Clears {@link hasOlderMessages} on
   * success.
   */
  const loadFullHistory = useCallback(async (sid: string) => {
    setLoadingFullHistory(true);
    try {
      await loadSession(sid, false, false);
      setHasOlderMessages(false);
    } finally {
      setLoadingFullHistory(false);
    }
  }, [loadSession]);

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
    if (sid !== sessionIdRef.current) return;
    const runtimeRunning = Boolean(agentState?.running && agentState.state?.isRunning !== false);
    // 状态请求与 SSE 并行：若最终 agent_end 已先抵达，此响应即使迟到也不能
    // 覆盖终态。新的 agent_start / 用户发送会清除此标记。
    const terminalEndAlreadySeen = terminalTurnEndedSessionIdRef.current === sid;
    if (runtimeRunning && !terminalEndAlreadySeen) {
      loadTools(sid);
      // isRunning stays true across gaps (waiting-for-model, between tool
      // batches, auto-retry backoff). Falls back to true for older servers.
      agentRunningRef.current = true;
      setAgentRunning(true);
      const stopRequested = agentState?.state?.stopRequested === true;
      stopRequestedRef.current = stopRequested;
      setAgentPhase(stopRequested ? { kind: "stopping" } : { kind: "waiting_model", reason: "restored" });
    } else {
      // 状态同步必须是双向的。只把 false→true 应用到 UI、却忽略 true→false，
      // 会让丢失 agent_end 的历史会话永久锁住发送按钮。
      stopRequestedRef.current = false;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
    if (agentState?.state) {
      if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
      if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
      if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
      if (agentState.state.thinkingLevel !== undefined) {
        setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
      }
      if (agentState.state.agentMode !== undefined) setAgentMode(normalizeAgentMode(agentState.state.agentMode));
    }
  }, [loadTools]);

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
    if (messageUpdateFrameRef.current !== null) {
      cancelAnimationFrame(messageUpdateFrameRef.current);
      messageUpdateFrameRef.current = null;
    }
  }, []);

  const flushPendingMessageUpdate = useCallback(() => {
    if (messageUpdateFrameRef.current !== null) {
      cancelAnimationFrame(messageUpdateFrameRef.current);
      messageUpdateFrameRef.current = null;
    }
    const pending = pendingMessageUpdateRef.current;
    pendingMessageUpdateRef.current = null;
    if (pending) handleAgentEventRef.current?.(pending);
  }, []);

  const enqueueMessageUpdate = useCallback((event: AgentEvent, sid: string) => {
    pendingMessageUpdateRef.current = event;
    if (messageUpdateFrameRef.current !== null) return;
    messageUpdateFrameRef.current = requestAnimationFrame(() => {
      messageUpdateFrameRef.current = null;
      if (sessionIdRef.current !== sid) {
        pendingMessageUpdateRef.current = null;
        return;
      }
      const pending = pendingMessageUpdateRef.current;
      pendingMessageUpdateRef.current = null;
      if (pending) handleAgentEventRef.current?.(pending);
    });
  }, []);

  const connectEvents = useCallback((sid: string, isReconnect = false) => {
    // Clear any pending reconnect timer from a previous attempt
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (!isReconnect) sseReconnectAttemptRef.current = 0;

    // Sync the subagent capability toggle to this (possibly freshly
    // cold-started) session so subagent is in/out of the active tool set.
    void sendAgentCommand(sid, { type: "set_subagent_enabled", enabled: subagentEnabledRef.current }).catch(() => { /* best effort */ });
    // 激进/保守/关闭 → 后端 TTFT 首包超时（激进 = 120s）。
    void sendAgentCommand(sid, { type: "set_auto_recovery_mode", mode: autoRecoveryModeRef.current }).catch(() => { /* best effort */ });

    const afterSeq = lastEventSeqRef.current;
    const eventsUrl = `/api/agent/${encodeURIComponent(sid)}/events${afterSeq > 0 ? `?after=${afterSeq}` : ""}`;
    const es = new EventSource(eventsUrl);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        const seq = typeof event.seq === "number" ? event.seq : Number(e.lastEventId);
        if (Number.isFinite(seq) && seq > lastEventSeqRef.current) {
          lastEventSeqRef.current = seq;
        }
        agentEventBus.emit(event);
        if (event.type === "message_update") {
          enqueueMessageUpdate(event, sid);
        } else {
          // 顺序屏障：message_end/工具/生命周期事件必须看到它之前的最新快照。
          flushPendingMessageUpdate();
          handleAgentEventRef.current?.(event);
        }
      } catch {
        // ignore
      }
    };
    es.onopen = () => {
      sseReconnectAttemptRef.current = 0;
      // On reconnect, verify we didn't miss agent_end during the backoff gap.
      // If the backend session has already finished, sync state locally so the
      // UI doesn't stay stuck in "streaming" mode waiting for events that will
      // never arrive.
      fetch(`/api/agent/${encodeURIComponent(sid)}`)
        .then((r) => r.json())
        .then((d: { running?: boolean; status?: AgentStatus }) => {
          if (awaitingAgentStartRef.current) {
            // On reconnect during awaiting-start: refresh messages + state
            // independently (TODO 2).
            loadSession(sid, false, false).catch(() => {});
            void loadSessionState(sid);
            return;
          }
          if (agentRunningRef.current && (!d.running || d.status?.isRunning === false)) {
            // Session ended while we were disconnected — dispatch a synthetic
            // agent_end so the client state resets cleanly. This is not a
            // trustworthy normal completion because its real terminal event
            // was lost; expose the transport diagnosis instead of stopping silently.
            handleAgentEventRef.current?.({
              type: "agent_end",
              willRetry: false,
              error: `事件流断开期间回合已经结束，未收到服务端终止详情（lastEventType=${d.status?.lastEventType ?? "unknown"}，eventIdleMs=${d.status?.eventIdleMs ?? "unknown"}）。请检查服务端日志；若回复不完整可发送“继续”。`,
            });
          }
        })
        .catch(() => {});
    };
    es.onerror = () => {
      // Always close the broken EventSource so it doesn't keep reconnecting
      // after the session has ended.  Without this, stale EventSources leak.
      if (eventSourceRef.current !== es) {
        es.close();
        return;
      }
      es.close();
      eventSourceRef.current = null;

      if (!agentRunningRef.current) return;

      sseReconnectAttemptRef.current += 1;
      const attempt = sseReconnectAttemptRef.current;
      const MAX_ATTEMPTS = 10;
      if (attempt > MAX_ATTEMPTS) {
        const message = `实时事件连接连续 ${MAX_ATTEMPTS} 次重连失败，无法继续接收模型输出或终止事件（session=${sid}）。后端可能已退出、网络连接已中断或 SSE 路由不可用。`;
        lastModelErrorRef.current = message;
        setLastModelError(message);
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);

      sseReconnectTimerRef.current = setTimeout(() => {
        sseReconnectTimerRef.current = null;
        // Guard: only reconnect if we're still on the same session AND
        // the agent is still running.  Without this check, a tab switch
        // during the backoff delay would reconnect to the wrong session.
        if (agentRunningRef.current && sessionIdRef.current === sid) {
          connectEvents(sid, true);
        }
      }, delay);
    };
    return es;
  }, [enqueueMessageUpdate, flushPendingMessageUpdate, loadSession, loadSessionState]);

  const ensureEventsConnected = useCallback((sid: string) => {
    const existing = eventSourceRef.current;
    if (sessionIdRef.current === sid && existing && existing.readyState !== EventSource.CLOSED) {
      return existing;
    }
    return connectEvents(sid);
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
        const eventData = event as { willRetry?: boolean; error?: string };
        const willRetry = eventData.willRetry ?? false;
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
          // Still reload session to capture partial output so far.
          if (sessionIdRef.current) {
            loadSession(sessionIdRef.current);
          }
          break;
        }
        terminalTurnEndedSessionIdRef.current = sessionIdRef.current;
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
          loadSession(sessionIdRef.current, false, false).catch(() => {});
          void loadSessionState(sessionIdRef.current);
        }
        // Reload session even on error to capture any partial output
        if (sessionIdRef.current && endedWithError) {
          loadSession(sessionIdRef.current);
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
                if (prev.some((m): m is UserMessage => m.role === "user" && m.clientMessageId === incomingClientMessageId)) {
                  return prev; // locally optimistic-appended, dedupe
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
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
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
  }, [loadSession, onAgentEnd, autoRecoveryMode, startSubagentLiveRefresh, finishSubagentLiveRefresh, stopSubagentLiveRefresh, loadSessionState]);
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
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setAgentRunning(true);
    setAgentPhase({ kind: "waiting_model", reason: "initial" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    let optimisticNewSession: SessionInfo | null = null;
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

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        // Single round-trip: create + send prompt in one POST. The backend
        // writes all events to the event-store, and SSE replays them on
        // first connect (getSince returns full history when no Last-Event-ID),
        // so we no longer need a separate `type=create` round-trip.
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message,
            clientMessageId,
            agentMode,
            ...(sentReferences ? { references: sentReferences } : {}),
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
            ...(roleId ? { roleId } : {}),
            ...(skill ? { skillName: skill.name } : {}),
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        }
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        adoptingCreatedSessionRef.current = realId;
        optimisticSessionIdRef.current = null;
        connectEvents(realId);
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
          ...(sentReferences ? { references: sentReferences } : {}),
          ...(piImages?.length ? { images: piImages } : {}),
          ...(roleId ? { roleId } : {}),
          ...(skill ? { skillName: skill.name } : {}),
        }, { timeoutMs: 45_000 });
      }
    } catch (e) {
      if (optimisticNewSession && !createdRealSession) onSessionStarted?.(null);
      awaitingAgentStartRef.current = false;
      clearAwaitingAgentStartGuard();
      optimisticSessionIdRef.current = null;
      adoptingCreatedSessionRef.current = null;
      console.error("Failed to send message:", e);
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
      // Remove the optimistically-inserted user message so the UI doesn't
      // show a dangling message with no reply.
      setMessages((prev) => prev.filter((m) => m !== userMsg));
      // Reset the ref synchronously so the watchdog and SSE reconnect logic
      // see the correct state immediately — not after the next React render.
      agentRunningRef.current = false;
      pendingAbortOnSessionReadyRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      // If connectEvents was called before sendAgentCommand threw (existing
      // session path), close the orphaned EventSource so it doesn't keep
      // retrying in the background for a prompt that was never sent.
      if (sseReconnectTimerRef.current) {
        clearTimeout(sseReconnectTimerRef.current);
        sseReconnectTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      cancelPendingMessageUpdate();
    }
  }, [isNew, newSessionCwd, newSessionModel, agentMode, thinkingLevel, session, cancelPendingMessageUpdate, connectEvents, ensureEventsConnected, scheduleAwaitingAgentStartGuard, clearAwaitingAgentStartGuard, onSessionCreated, onSessionStarted]);

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
      // compaction_end 的 SSE handler 会刷新消息；这里不再把重复的 session 读取
      // 放在用户发送的关键路径上。SSE 断开时仍做一次非阻塞兜底刷新。
      void loadSession(sid, true);
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
        ...(sentReferences ? { references: sentReferences } : {}),
        ...(piImages?.length ? { images: piImages } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const sentReferences = references?.length ? references : undefined;
    const clientMessageId = createClientMessageId();
    setMessages((prev) => [...prev, {
      role: "user",
      content: buildUserContent(message, images),
      ...(sentReferences ? { references: sentReferences } : {}),
      ...(skill ? { skill } : {}),
      clientMessageId,
      timestamp: Date.now(),
    } as AgentMessage]);
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
        ...(sentReferences ? { references: sentReferences } : {}),
        ...(piImages?.length ? { images: piImages } : {}),
        ...(skill ? { skillName: skill.name } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

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
  }, [connectEvents, loadSession, scheduleAwaitingAgentStartGuard]);

  // Keep executeRecoveryRef in sync so handleAgentEvent (declared above) can
  // invoke the latest version without listing it as a dependency.
  useEffect(() => {
    executeRecoveryRef.current = executeRecovery;
  }, [executeRecovery]);

  // Keep a lightweight UI-facing counter so users can see when the watchdog is
  // getting close to intervening.
  useEffect(() => {
    if (!agentRunning) {
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
  }, [agentRunning, WATCHDOG_STALE_CONTENT_MS, WATCHDOG_STALE_EVENT_MS]);

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
    setMessages((prev) => [...prev, {
      role: "user",
      content: "请按刚才用户批准的计划开始实施。",
      clientMessageId,
      timestamp: Date.now(),
    } as AgentMessage]);
    try {
      connectEvents(sid);
      scheduleAwaitingAgentStartGuard(sid, currentTurnId);
      await sendAgentCommand(sid, { type: "follow_up", message: "请按刚才用户批准的计划开始实施。", clientMessageId });
    } catch (e) {
      awaitingAgentStartRef.current = false;
      clearAwaitingAgentStartGuard();
      console.error("Failed to build plan:", e);
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      setLastModelError(e instanceof Error ? e.message : String(e));
    }
  }, [clearAwaitingAgentStartGuard, connectEvents, handleAgentModeChange, scheduleAwaitingAgentStartGuard]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  const activeSessionId = session?.id;

  // Load or reset session when the active tab changes. Previously AppShell
  // forced a full ChatWindow remount via key={sessionKey}; responding to prop
  // changes here keeps the component tree alive and makes tab switches cheaper.
  useEffect(() => {
    const sessionId = activeSessionId;
    // If a brand-new session just received its real id, handleSend has already
    // connected SSE and populated optimistic messages. Do not tear it down just
    // because AppShell replaced the placeholder tab with the real session tab.
    if (sessionId && sessionId === sessionIdRef.current) return;
    if (sessionId && sessionId === optimisticSessionIdRef.current) return;
    if (sessionId && sessionId === adoptingCreatedSessionRef.current) {
      adoptingCreatedSessionRef.current = null;
      return;
    }

    let cancelled = false;

    // Cancel any pending SSE reconnect timer from the previous session
    if (sseReconnectTimerRef.current) {
      clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    cancelPendingMessageUpdate();
    lastEventSeqRef.current = 0;
    // Abort any inflight background loadSession / polling requests from the
    // previous session so they don't keep hitting the backend (and racing
    // this new session's requests). A fresh controller is installed for the
    // new session.
    sessionAbortRef.current?.abort();
    sessionAbortRef.current = new AbortController();
    loadSessionInflightRef.current = null;
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
    initialScrollDoneRef.current = false;
    pendingScrollToUserRef.current = false;
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
    setData(null);
    setMessages([]);
    setEntryIds([]);
    setCurrentModelOverride(null);
    setPendingModel(null);
    setPlanReady(false);
    setAgentRunning(false);
    setError(null);

    // Open session: load RECENT messages first (TODO 3 pagination) — this is a
    // cheaper first paint than the full GET /api/sessions/:id. Runtime state
    // is then fetched asynchronously (TODO 2) so neither a busy runtime nor a
    // huge history can block the first paint.
    loadRecentMessages(sessionId, true).then(() => {
      if (cancelled || sessionIdRef.current !== sessionId) return;

      // 远程连接（例如微信 Bot）可能会在当前 session 空闲时从外部发起 prompt。
      // 这里改为：打开已有 session 时始终保持 SSE 连接，以便接收未来的外部消息事件。
      connectEvents(sessionId);

      // Now fetch runtime state asynchronously — failures here never affect
      // the already-displayed messages.
      void loadSessionState(sessionId);
    });

    const activeSubagentToolIds = activeSubagentToolIdsRef.current;
    return () => {
      cancelled = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      cancelPendingMessageUpdate();
      activeSubagentToolIds.clear();
      stopSubagentLiveRefresh();
    };
  }, [cancelPendingMessageUpdate, connectEvents, loadRecentMessages, loadSession, loadSessionState, loadTools, activeTabId, newSessionCwd, activeSessionId, stopSubagentLiveRefresh]);

  useEffect(() => {
    entryIdsRef.current = entryIds;
  }, [entryIds]);

  // 兜底同步：远程连接（微信 Bot 等）可能从服务端直接写入当前 session，
  // 在某些 dev/runtime 场景下 SSE 事件不会可靠到达浏览器。这里对当前打开的
  // 已有 session 做轻量轮询，只在 entryIds 变化时刷新消息，避免必须右键 reload。
  useEffect(() => {
    if (!activeSessionId || newSessionCwd) return;
    let stopped = false;
    let inFlight = false;
    let tickController: AbortController | null = null;

    const tick = async () => {
      if (stopped || inFlight || sessionIdRef.current !== activeSessionId) return;
      const isRunning = agentRunningRef.current;
      if (isRunning) {
        const now = Date.now();
        const sseQuietMs = now - lastAgentEventAtRef.current;
        const contentQuietMs = now - lastContentChangedAtRef.current;
        const shouldPollRunning = awaitingAgentStartRef.current || sseQuietMs > 15_000 || contentQuietMs > 15_000;
        if (!shouldPollRunning) return;
      }

      inFlight = true;
      tickController = new AbortController();
      // Honour session-level abort too — covers tab switches that happen
      // while the fetch is in flight.
      const sessionSignal = sessionAbortRef.current?.signal;
      const onSessionAbort = () => tickController?.abort();
      if (sessionSignal) {
        if (sessionSignal.aborted) tickController.abort();
        else sessionSignal.addEventListener("abort", onSessionAbort, { once: true });
      }
      // Bound the request: an unbounded polling fetch on a slow backend is
      // exactly what produces the "loadSession background refresh failed"
      // cascade of warnings.
      const timeout = setTimeout(() => tickController?.abort(), 10_000);
      try {
        const url = `/api/sessions/${encodeURIComponent(activeSessionId)}${isRunning ? "?includeState" : ""}`;
        const res = await fetch(url, {
          cache: "no-store",
          signal: tickController.signal,
        });
        if (!res.ok) return;
        const d = await res.json() as SessionDataWithAgentState;
        if (stopped || sessionIdRef.current !== activeSessionId) return;
        applySessionSnapshot(d);
      } catch {
        // ignore transient polling errors (incl. abort on session switch)
      } finally {
        clearTimeout(timeout);
        if (sessionSignal) sessionSignal.removeEventListener("abort", onSessionAbort);
        inFlight = false;
      }
    };

    // 6s cadence: SSE is still the primary live channel, but when it goes
    // quiet during an active turn we read the session snapshot so the UI
    // recovers the same way a manual reload would.
    const timer = window.setInterval(tick, 6000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      tickController?.abort();
    };
  }, [activeSessionId, applySessionSnapshot, newSessionCwd]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current) {
        scrollToBottom("smooth");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load the configured model list fresh so ChatInput tracks ModelsConfig.
  useEffect(() => {
    let cancelled = false;
    fetchModels().then((d) => {
      if (cancelled) return;
      setModelNames(d.models);
      setAutoRecoveryModels(d.autoRecoveryModels ?? []);
      if (d.thinkingLevels) setModelThinkingLevels(d.thinkingLevels);
      if (d.thinkingLevelMaps) setModelThinkingLevelMaps(d.thinkingLevelMaps);
      if (d.modelList) {
        setModelList(d.modelList);
        if (isNew && d.modelList.length > 0) {
          const def = d.defaultModel;
          const match = def && d.modelList.find((m) => m.id === def.modelId && m.provider === def.provider);
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: d.modelList[0].provider, modelId: d.modelList[0].id };
          setNewSessionModel(selected);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isNew, modelsRefreshKey, modelsConfigVersion, setNewSessionModel]);

  useEffect(() => {
    window.addEventListener("deerhux.models-updated", bumpModelsConfigVersion);
    return () => window.removeEventListener("deerhux.models-updated", bumpModelsConfigVersion);
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
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, agentMode, planReady, thinkingLevel,
    retryInfo, contextUsage, systemPrompt: systemPrompt ?? lastSystemPromptRef.current, forkingEntryId,
    isCompacting, compactionProgress, clearCompactionProgress: () => setCompactionProgress(null), compactError, lastModelError, currentModel, displayModel, sessionStats,
    agentPhase, watchdogInfo, stallLevel, autoRecoveryMode,
    subagentEnabled,
    isNew,
    // TODO 3 — first-paint pagination affordance
    hasOlderMessages, loadingFullHistory, loadFullHistory,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleAgentModeChange, handleBuildPlan, handleThinkingLevelChange, loadTools, setData, setMessages,
    setSystemPrompt, setLastModelError, handleAutoRecover, handleDismissStall, handleAutoRecoveryModeChange, handleSubagentToggle,
    dispatch, setAgentRunning, setForkingEntryId,
  };
}
