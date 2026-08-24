import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { cacheSessionPath, forceRefreshSessionList } from "./session-reader";
import type { AgentEnginePort, ToolInfo } from "./engine/port";
import type { AgentSessionPort } from "./session/port";
import type { ModelCatalogPort, RuntimeModel } from "./model/port";
import type { ProjectResourcePort } from "./project-resource/port";
import { composeDeerLoopEngine } from "./engine/deer-loop-composition";
import { normalizeCodeGraphToolNames } from "./codegraph/tools";
import type { TurnContextSnapshot } from "./engine/turn-context";
import { classifyLlmError } from "./llm-gateway";
import type { LlmRequestKind } from "./llm-gateway";
import { getLiveIslandClient } from "./live-island-client";
import { applyRolePromptToSystemPrompt } from "./roles";
import { applyRolePromptConfigToPrompt, isRoleSystemPromptSectionEnabled, readRoleSystemPromptConfig } from "./system-prompt-decomposer";
import { SUBAGENT_TOOL_NAME } from "./parallel-agent/subagent-tool";
import { getAgentEventStore } from "./agent-runtime/event-store";
import { getAgentRunStore } from "./agent-runtime/run-store";
import { isTerminalAgentRunStatus, type AgentRunRecord } from "./agent-runtime/run-types";
import { registerShutdownCleanup } from "./process-shutdown";
import type { AgentRuntimeEventBase } from "./agent-runtime/types";
import { hostEventBus, type HostRunningSession, type SessionTransientSnapshot } from "./host-event-bus";
import type { FileReference, ImageContent, SkillReference, TextContent, TurnCapabilities } from "./types";
import type { McpRuntime, McpRuntimeLease } from "./mcp-runtime";
import {
  applyModePrompt,
  getToolNamesForAgentMode,
  isReadOnlyAgentMode,
  normalizeAgentMode,
  stripModePrompt,
  type AgentMode,
} from "./agent-modes";

// ============================================================================
// Types
// ============================================================================

/** 兼容导出；服务端运行时事件统一使用 agent-runtime 基础契约。 */
export type AgentEvent = AgentRuntimeEventBase & {
  changedFiles?: string[];
};

type EventListener = (event: AgentEvent) => void;

interface SkillInvocation {
  name: string;
  content?: string;
}

interface PreparedTurnContext {
  message: string;
  displayMessage: string;
  references: FileReference[];
  skill?: SkillReference;
  systemPromptBlock: string;
  userPromptBlock: string;
}

interface TurnAdmissionSnapshot {
  systemPrompt: string;
  activeToolNames: readonly string[];
  roleId: string | null;
  agentMode: AgentMode;
}

interface EnsureMcpRuntimeOptions {
  activateMcp?: boolean;
  signal?: AbortSignal;
  /** 提交 Runtime 时，发起该任务的准入代次仍必须有效。 */
  canCommit?: () => boolean;
}

type RuntimeImage = {
  type: "image";
  data?: string;      // base64 (legacy, may be empty when filePath is set)
  filePath?: string;   // absolute filesystem path (new — backend reads from disk)
  mimeType: string;
};

/** SDK image format — data is always a non-empty string when passed to the model. */
type SdkImage = { type: "image"; data: string; mimeType: string };

/** Filter RuntimeImage[] down to only those with resolved data, for SDK calls. */
function toSdkImages(images?: RuntimeImage[]): SdkImage[] | undefined {
  if (!images?.length) return undefined;
  const out: SdkImage[] = [];
  for (const img of images) {
    if (typeof img.data === "string" && img.data.length > 0) {
      out.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }
  return out.length > 0 ? out : undefined;
}

type DisplayUserContent = string | (TextContent | ImageContent)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileReferenceName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function escapeTurnContextText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseSkillCommand(message: string): { skillName: string; message: string } | null {
  const match = message.match(/^\/skill:([\w-]+)(?:\s|$)([\s\S]*)/);
  if (!match) return null;
  return { skillName: match[1], message: match[2].trim() };
}

function normalizeReferences(value: unknown): FileReference[] {
  if (!Array.isArray(value)) return [];
  const references: FileReference[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const filePath = item.path.trim();
    if (!filePath) continue;
    references.push({
      path: filePath,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : fileReferenceName(filePath),
    });
  }
  return references;
}

function buildDisplayUserContent(message: string, images?: RuntimeImage[]): DisplayUserContent {
  if (!images?.length) return message;
  return [
    ...(message.trim() ? [{ type: "text" as const, text: message }] : []),
    ...images.map((image) => {
      if (image.filePath) {
        // Use file URL reference so session files stay lean (no base64 bloat)
        return {
          type: "image" as const,
          source: { type: "url" as const, url: `/api/files${image.filePath}?type=read` },
        };
      }
      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: image.mimeType, data: image.data ?? "" },
      };
    }),
  ];
}

function getNestedString(value: unknown, keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function getEventContentLength(event: AgentEvent): number | null {
  if (event.type !== "message_start" && event.type !== "message_update") return null;
  const message = isRecord(event.message) ? event.message : null;
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") length += block.text.length;
    else if (typeof block.thinking === "string") length += block.thinking.length;
    else if ("input" in block) length += JSON.stringify(block.input ?? {}).length;
    else if ("arguments" in block) length += JSON.stringify(block.arguments ?? {}).length;
  }
  return length;
}

function extractToolName(event: AgentEvent): string {
  return typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "";
}

function extractChangedFilePaths(event: AgentEvent): string[] {
  if (event.type === "tool_execution_end" && Array.isArray(event.changedFiles)) {
    const changedFiles = event.changedFiles.filter((filePath): filePath is string => typeof filePath === "string" && filePath.trim().length > 0);
    if (changedFiles.length > 0) return changedFiles;
  }

  const fallbackPath = extractChangedFilePath(event);
  return fallbackPath ? [fallbackPath] : [];
}

function extractChangedFilePath(event: AgentEvent): string | null {
  const toolName = extractToolName(event);
  if (toolName !== "write" && toolName !== "edit") return null;

  return getNestedString(event, ["filePath"])
    ?? getNestedString(event, ["path"])
    ?? getNestedString(event, ["file_path"])
    ?? getNestedString(event, ["args", "file_path"])
    ?? getNestedString(event, ["args", "path"])
    ?? getNestedString(event, ["input", "file_path"])
    ?? getNestedString(event, ["input", "path"])
    ?? getNestedString(event, ["result", "filePath"])
    ?? getNestedString(event, ["result", "path"])
    ?? getNestedString(event, ["result", "file_path"]);
}

function resolveChangedFilePath(filePath: string, cwd: string): string | null {
  if (!filePath || !filePath.trim() || filePath.includes("\0")) return null;
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedCwd, filePath);
  const relative = path.relative(resolvedCwd, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

const execFileAsync = promisify(execFile);

const GIT_STATUS_TIMEOUT_MS = 3_000;
const GIT_STATUS_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 异步读取 cwd 下的 Git 工作区状态。路径以绝对路径作为 Map key，以正确处理
 * session cwd 位于 Git 子目录的情况。失败时返回 null，调用方静默降级。
 */
export async function readGitStatusSnapshot(cwd: string): Promise<Map<string, string> | null> {
  try {
    const deadline = Date.now() + GIT_STATUS_TIMEOUT_MS;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const { stdout: prefixOutput } = await execFileAsync("git", ["rev-parse", "--show-prefix"], {
      cwd,
      encoding: "utf8",
      timeout: remainingMs(),
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    const cwdPrefix = prefixOutput.trim().replace(/\\/g, "/");
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."],
      { cwd, encoding: "buffer", timeout: remainingMs(), maxBuffer: GIT_STATUS_MAX_BUFFER, windowsHide: true },
    );
    const snapshot = new Map<string, string>();
    for (const entry of Buffer.from(stdout).toString("utf8").split("\0")) {
      // porcelain v1 -z + --no-renames: "XY path"; pathname is relative to Git root.
      if (entry.length < 4 || entry[2] !== " ") continue;
      const status = entry.slice(0, 2);
      const rootRelativePath = entry.slice(3);
      if (!rootRelativePath || rootRelativePath.includes("\0") || path.isAbsolute(rootRelativePath)) continue;
      const cwdRelativePath = cwdPrefix && rootRelativePath.startsWith(cwdPrefix)
        ? rootRelativePath.slice(cwdPrefix.length)
        : rootRelativePath;
      const absolutePath = resolveChangedFilePath(cwdRelativePath, cwd);
      if (absolutePath) snapshot.set(absolutePath, status);
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** 返回结束快照相对于回合开始快照新增或状态改变的工作区绝对路径。 */
export function diffGitStatusSnapshots(
  baseline: Map<string, string> | null,
  current: Map<string, string> | null,
  cwd: string,
): string[] {
  if (!baseline || !current) return [];
  const changed: string[] = [];
  for (const [absolutePath, status] of current) {
    if (baseline.get(absolutePath) === status) continue;
    if (resolveChangedFilePath(absolutePath, cwd)) changed.push(absolutePath);
  }
  return changed;
}

const TURN_CONTEXT_BLOCK_RE = /\n*<turn_context>[\s\S]*?<\/turn_context>\s*/g;

/**
 * Remove any `<turn_context>…</turn_context>` blocks left over from a previous
 * turn. Per-turn context now lives in the immutable TurnContextSnapshot and is
 * no longer written into the engine's persistent system prompt; this strip is a
 * defensive cleanup for legacy session state and for wrapper-side prompt
 * reassembly, ensuring stale turn context never leaks into `baseSystemPrompt`.
 */
function stripTurnContextBlock(prompt: string): string {
  return prompt.replace(TURN_CONTEXT_BLOCK_RE, "").trimEnd();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 让 Wrapper 的准入等待可被及时取消。底层任务可能不支持 AbortSignal，
 * 但竞速 Promise 会立即拒绝并持有晚到 rejection handler，避免未处理拒绝。
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const FULL_PRESET_MARKERS = ["bash", "edit", "write", "grep", "find", "ls"];

function isFullToolPreset(toolNames: string[]): boolean {
  return FULL_PRESET_MARKERS.every((name) => toolNames.includes(name));
}

function includesMcpTool(toolNames: string[]): boolean {
  return toolNames.some((name) => name.startsWith("mcp__"));
}

const TOOLS_SECTION_RE = /(^|\n)Available tools:\n[\s\S]*?(?=\n\n(?:In addition to the tools above|Guidelines:|<deerhux_mode>|<project_context>|<available_skills>|MCP runtime tools:|Current date:|<!-- (?:DEERHUX|PI)_ROLE|# Global Memory)|$)/;
const TOOL_SECTION_INSERT_MARKERS = [
  "\n\nGuidelines:",
  "\n\n<deerhux_mode>",
  "\n\n<project_context>",
  "\n\n<available_skills>",
  "\n\nMCP runtime tools:",
  "\n\nCurrent date:",
  "\n\n<!-- DEERHUX_ROLE",
  "\n\n<!-- PI_ROLE",
  "\n\n# Global Memory",
];

function buildLiveToolsSection(allTools: ToolInfo[], activeToolNames: string[]): string | null {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const activeTools = activeToolNames
    .map((name) => byName.get(name))
    .filter((tool): tool is ToolInfo => Boolean(tool));
  if (activeTools.length === 0) return null;

  return [
    "Available tools:",
    ...activeTools.map((tool) => `- ${tool.name}: ${tool.description || "Available tool"}`),
  ].join("\n");
}

function upsertToolsSection(prompt: string, toolsSection: string | null): string {
  if (!toolsSection) return prompt;

  if (TOOLS_SECTION_RE.test(prompt)) {
    return prompt.replace(TOOLS_SECTION_RE, (match, prefix: string) => `${prefix}${toolsSection}`);
  }

  const trimmed = prompt.trim();
  if (!trimmed) return toolsSection;

  const insertAt = TOOL_SECTION_INSERT_MARKERS
    .map((marker) => {
      const index = prompt.indexOf(marker);
      return index === -1 ? null : index;
    })
    .filter((index): index is number => index !== null)
    .sort((a, b) => a - b)[0];

  if (insertAt !== undefined) {
    return `${prompt.slice(0, insertAt).trimEnd()}\n\n${toolsSection}${prompt.slice(insertAt)}`;
  }

  return `${trimmed}\n\n${toolsSection}`;
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingToolEvents = new Map<string, AgentEvent>();
  /** 保证异步 Git 结算不会重排同一 session 的引擎事件。 */
  private agentEventQueue: Promise<void> = Promise.resolve();
  /** 当前逻辑回合的 Git 工作区状态；自动重试会复用，不会重新建基线。 */
  private gitChangedFilesBaseline: Map<string, string> | null = null;
  private gitChangedFilesTrackingActive = false;
  /** 已由工具事件明确报告的路径；Git 不可用时仍可完整降级。 */
  private explicitChangedFilesInTurn = new Set<string>();
  /** 终态 Git 结算期间阻止下一 prompt 复用同一份回合级变更状态。 */
  private changedFilesFinalizing = false;
  private unsubscribe: (() => void) | null = null;
  private idlePulseInterval: ReturnType<typeof setInterval> | null = null;
  private lastActiveAt = Date.now();
  private staleWarningSent = false;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private roleId: string | null = null;
  private agentMode: AgentMode = "agent";
  private modePromptEnabled = false;
  private temporaryRoleSettings: string[] = [];
  private baseSystemPrompt = "";
  private lastEventType = "";
  private lastEventAt = 0;
  private lastContentAt = 0;
  private eventCount = 0;
  private runStartedAt = 0;
  private lastContentLength = 0;
  /** Tracks whether an agent turn is actively running (agent_start → agent_end).
   *  Unlike isStreaming, this stays true during gaps between tool execution
   *  and the next model response, and during auto-retry backoff. */
  private _isRunning = false;
  /** 对外可见的逻辑回合状态；以最终 agent_end 为终态边界。 */
  private _turnActive = false;
  /** prompt 正在做异步预处理、尚未进入 engine.prompt 的准入锁。 */
  private pendingPromptController: AbortController | null = null;
  /** recover / 空闲 follow-up 在停止旧回合与建立新回合之间持有的统一新回合准入锁。 */
  private freshTurnAdmissionController: AbortController | null = null;
  /** 同一 clientMessageId 的并发重试共享同一准入结果，不能落入 AGENT_BUSY。 */
  private pendingPromptAdmissions = new Map<string, { turnId?: string; promise: Promise<{ turnId: string }> }>();
  /** 用户已请求停止；直到准入任务和 engine turn 都停止前保持为 true。 */
  private _stopRequested = false;
  private activeTurnId = 0;
  private activeTurnPromise: Promise<void> | null = null;
  /** Stable string key for the currently-running turn, e.g. "sess:t3".
   * Attached to every stored/broadcast event so clients can filter by turn
   * and reconnect with precise replay boundaries. */
  private currentTurnKey: string | null = null;
  /** 持久化运行态的当前回合；进程重启后由 RunStore 收敛为 interrupted。 */
  private currentRunId: string | null = null;
  private sawAssistantEventInTurn = false;
  /** When true, the subagent tool is kept in the active tool set. */
  private _subagentEnabled = false;

  constructor(
    public readonly inner: AgentEnginePort,
    private readonly session: AgentSessionPort,
    private readonly modelCatalog: ModelCatalogPort,
    private readonly projectResources: ProjectResourcePort,
    roleId?: string | null,
    private mcpRuntimeLease?: McpRuntimeLease | null,
    agentMode?: AgentMode | null,
    /** Run 记录的请求类别：主回合 main / 子 Agent worker subagent。 */
    private readonly requestKind: AgentRunRecord["requestKind"] = "main",
  ) {
    this.roleId = roleId ?? null;
    this.agentMode = normalizeAgentMode(agentMode);
    this.modePromptEnabled = agentMode !== undefined && agentMode !== null;
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(inner.systemPrompt));
    this.applyRolePrompt();
  }

  private get mcpRuntime(): McpRuntime | null {
    return this.mcpRuntimeLease?.runtime ?? null;
  }

  private syncRoleMcpActiveTools(targetRuntime: McpRuntime | null = this.mcpRuntime): void {
    const allMcpToolNames = targetRuntime?.toolNames ?? [];
    if (allMcpToolNames.length === 0) return;

    const config = readRoleSystemPromptConfig(this.roleId);
    const mcpSection = config.sections.find((s) => s.id === "mcp_tools");
    const allowedMcpToolNames = mcpSection?.enabled === false ? [] : (config.mcpToolNames ?? allMcpToolNames);
    const allowed = new Set(allowedMcpToolNames);
    const allMcp = new Set(allMcpToolNames);
    const activeBefore = this.inner.getActiveToolNames();
    const nonMcpActive = activeBefore.filter((name) => !allMcp.has(name) && !name.startsWith("mcp__"));
    const hadActiveMcp = activeBefore.some((name) => allMcp.has(name) || name.startsWith("mcp__"));
    const isFullPreset = ["grep", "find", "ls"].every((name) => nonMcpActive.includes(name));
    if (!hadActiveMcp && !isFullPreset) return;

    const nextMcpActive = allMcpToolNames.filter((name) => allowed.has(name));
    const nextActive = [...new Set([...nonMcpActive, ...nextMcpActive])];
    const currentKey = activeBefore.join("\0");
    const nextKey = nextActive.join("\0");
    if (currentKey === nextKey) return;

    this.inner.setActiveToolsByName(nextActive);
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.systemPrompt));
  }

  /** Keep subagent in (or out of) the active tool set based on capability and mode. */
  private applySubagentToActiveTools(): void {
    const all = this.inner.getAllTools();
    if (!all.some((t) => t.name === SUBAGENT_TOOL_NAME)) return; // tool not registered for this session
    const current = this.inner.getActiveToolNames();
    const shouldEnable = this._subagentEnabled && !isReadOnlyAgentMode(this.agentMode);
    if (shouldEnable) {
      if (!current.includes(SUBAGENT_TOOL_NAME)) {
        this.inner.setActiveToolsByName([...current, SUBAGENT_TOOL_NAME]);
      }
    } else if (current.includes(SUBAGENT_TOOL_NAME)) {
      this.inner.setActiveToolsByName(current.filter((name) => name !== SUBAGENT_TOOL_NAME));
    }
  }

  private setSubagentEnabled(enabled: boolean): void {
    this._subagentEnabled = enabled;
    this.applySubagentToActiveTools();
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.systemPrompt));
    this.applyRolePrompt();
  }

  private readTurnCapabilities(command: Record<string, unknown>): TurnCapabilities {
    const value = command.capabilities;
    if (!isRecord(value)) return {};
    return typeof value.subagent === "boolean" ? { subagent: value.subagent } : {};
  }

  private applyTurnCapabilities(command: Record<string, unknown>): void {
    const capabilities = this.readTurnCapabilities(command);
    if (typeof capabilities.subagent === "boolean") {
      this.setSubagentEnabled(capabilities.subagent);
    }
  }

  /**
   * ★ R13 加固：外层加 try/catch，失败时至少恢复到 this.baseSystemPrompt
   * （不带 role/mode 修饰），防止 role 配置损坏导致 system prompt 污染所有后续 turn。
   *
   * 注意：内部恢复 baseSystemPrompt 失败后会重新 throw，让调用方感知并处理；
   * 回合级上下文已改由不可变 TurnContextSnapshot 承载，不再依赖此处的临时覆盖。
   */
  private applyRolePrompt(
    targetRuntime: McpRuntime | null = this.mcpRuntime,
    throwOnFailure = false,
  ): void {
    try {
      try {
        this.syncRoleMcpActiveTools(targetRuntime);
      } catch (syncErr) {
        // 普通配置刷新保持原有 best-effort 语义；MCP 安装事务必须感知失败并回滚。
        if (throwOnFailure) throw syncErr;
        console.error("syncRoleMcpActiveTools failed, MCP tools unchanged:", syncErr);
      }
      const promptWithTools = upsertToolsSection(
        this.baseSystemPrompt,
        buildLiveToolsSection(this.inner.getAllTools(), this.inner.getActiveToolNames()),
      );
      const configuredPrompt = applyRolePromptConfigToPrompt(promptWithTools, this.roleId);
      const shouldApplyModePrompt = this.modePromptEnabled && isRoleSystemPromptSectionEnabled(this.roleId, "mode_control");
      const promptWithMode = shouldApplyModePrompt ? applyModePrompt(configuredPrompt, this.agentMode) : configuredPrompt;
      const nextPrompt = isRoleSystemPromptSectionEnabled(this.roleId, "role_profile")
        ? applyRolePromptToSystemPrompt(promptWithMode, this.roleId, this.temporaryRoleSettings, this.session.cwd)
        : promptWithMode;
      this.inner.setSystemPromptPersistent(nextPrompt);
    } catch (err) {
      console.error("applyRolePrompt failed, restoring to bare baseSystemPrompt:", err);
      try {
        this.inner.setSystemPromptPersistent(this.baseSystemPrompt);
      } catch (err2) {
        console.error("Failed to restore bare baseSystemPrompt:", err2);
        // ★ R13 发现5（严重修复）：内部恢复也失败 → 重新 throw，
        // 让调用方（set_role / set_mode / set_tools 等重建入口）感知失败并中止
        throw err2;
      }
      if (throwOnFailure) throw err;
    }
  }

  private persistAgentMode(): void {
    if (!this.session.persisted) return;
    try {
      this.session.appendCustomEntry("agent_mode", { mode: this.agentMode });
    } catch { /* best effort */ }
  }

  private async setAgentMode(mode: AgentMode, persist = true): Promise<void> {
    this.agentMode = normalizeAgentMode(mode);
    this.modePromptEnabled = true;
    if (this.agentMode === "agent" && this.mcpRuntime) {
      this.inner.setActiveToolsByName([...new Set([...getToolNamesForAgentMode(this.agentMode), ...this.mcpRuntime.toolNames])]);
    } else {
      this.inner.setActiveToolsByName(getToolNamesForAgentMode(this.agentMode));
    }
    this.applySubagentToActiveTools();
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.systemPrompt));
    this.applyRolePrompt();
    if (persist) this.persistAgentMode();
  }

  private appendDisplayUserMessage(content: unknown, references: FileReference[], skill?: SkillReference, clientMessageId?: string, turnId?: string): void {
    if (!this.session.persisted) return;
    // This entry is the durable prompt-admission receipt. Do not silently ignore
    // persistence failures: without it a timed-out client cannot safely determine
    // whether retrying the prompt would execute tools twice.
    this.session.appendCustomEntry("display_user_message", {
      content,
      ...(references.length ? { references } : {}),
      ...(skill ? { skill } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(turnId ? { turnId } : {}),
      agentMode: this.agentMode,
    });
  }

  findAcceptedPrompt(clientMessageId: string): { turnId?: string } | null {
    const pending = this.pendingPromptAdmissions.get(clientMessageId);
    if (pending) return { turnId: pending.turnId };
    for (const entry of this.session.getCustomEntries("display_user_message")) {
      const data = entry.data as { clientMessageId?: unknown; turnId?: unknown } | undefined;
      if (data?.clientMessageId !== clientMessageId) continue;
      return { turnId: typeof data.turnId === "string" ? data.turnId : undefined };
    }
    return null;
  }

  private appendTurnContextMetadata(references: FileReference[], skill?: SkillReference, mode: AgentMode = this.agentMode): void {
    if (!this.session.persisted) return;
    try {
      this.session.appendCustomEntry("turn_context", {
        mode,
        ...(references.length ? { references } : {}),
        ...(skill ? { skill } : {}),
      });
    } catch { /* best effort: only affects UI metadata */ }
  }

  private async resolveSkillInvocation(name: string | undefined): Promise<SkillInvocation | undefined> {
    const skillName = name?.trim();
    if (!skillName) return undefined;
    const cwd = this.session.cwd;
    return await this.projectResources.resolveSkill(cwd, skillName) ?? { name: skillName };
  }

  private buildTurnSystemPromptBlock(references: FileReference[]): string {
    if (references.length === 0) return "";
    const lines = [
      "<turn_context>",
      "User-selected references for this turn:",
      "Use these files or folders only if the user's request requires them. Do not summarize or analyze them just because they are listed.",
    ];
    for (const ref of references) lines.push(`- ${escapeTurnContextText(ref.path)}`);
    lines.push("</turn_context>");
    return lines.join("\n");
  }

  private buildSkillUserPromptBlock(skill?: SkillInvocation): string {
    if (!skill) return "";
    const lines = [`The user explicitly invoked the skill \`${skill.name}\` for this turn.`];
    if (skill.content?.trim()) {
      lines.push("Follow the skill instructions below while completing the user's request:");
      lines.push("<selected_skill>", skill.content.trim(), "</selected_skill>");
    } else {
      lines.push("The selected skill content could not be loaded; proceed using the skill name as metadata only.");
    }
    return lines.join("\n");
  }

  private async prepareTurnContext(
    rawMessage: string,
    rawReferences: unknown,
    rawSkillName: unknown,
    _agentMode: AgentMode,
  ): Promise<PreparedTurnContext> {
    const references = normalizeReferences(rawReferences);
    const parsedSkill = parseSkillCommand(rawMessage);
    const explicitSkillName = typeof rawSkillName === "string" ? rawSkillName : undefined;
    const skillName = explicitSkillName ?? parsedSkill?.skillName;
    const message = parsedSkill ? parsedSkill.message : rawMessage;
    const skillInvocation = await this.resolveSkillInvocation(skillName);
    const skill = skillInvocation ? { name: skillInvocation.name } : undefined;
    const displayMessage = message.trim() || (skill ? `使用技能：${skill.name}` : rawMessage);
    return {
      message: message.trim() || (skill ? `Use the selected skill: ${skill.name}.` : rawMessage),
      displayMessage,
      references,
      skill,
      systemPromptBlock: this.buildTurnSystemPromptBlock(references),
      userPromptBlock: this.buildSkillUserPromptBlock(skillInvocation),
    };
  }

  private transitionCurrentRun(transition: {
    status: AgentRunRecord["status"];
    lastEventType?: string;
    errorCode?: string;
    error?: string;
  }): void {
    if (!this.currentRunId) return;
    const store = getAgentRunStore();
    // 幂等：已达终态的 Run 不再转移（事件重放 / destroy 兜底路径会重复触发）。
    const current = store.get(this.currentRunId);
    if (!current || isTerminalAgentRunStatus(current.status)) return;
    try {
      store.transition(this.currentRunId, transition);
    } catch (error) {
      // Run 状态不能反向破坏已经开始的用户回合；保留可检索日志供运维处理。
      console.error("Failed to persist agent run transition", error);
    }
  }

  getLastRun(): AgentRunRecord | null {
    return getAgentRunStore().getLatestForSession(this.session.id);
  }

  private createPromptRun(turnKey: string, clientMessageId?: string): string {
    const runId = `run_${turnKey}_${Date.now().toString(36)}`;
    getAgentRunStore().create({
      runId,
      sessionId: this.session.id,
      turnId: turnKey,
      ...(clientMessageId ? { clientMessageId } : {}),
      requestKind: this.requestKind,
      model: { provider: this.inner.model.provider, modelId: this.inner.model.id },
    });
    this.currentRunId = runId;
    return runId;
  }

  private captureTurnAdmission(command: Record<string, unknown>): TurnAdmissionSnapshot {
    const commandRoleId = typeof command.roleId === "string" ? command.roleId : undefined;
    if (commandRoleId) this.setRole(commandRoleId);
    this.applyTurnCapabilities(command);
    return Object.freeze({
      systemPrompt: stripTurnContextBlock(this.inner.systemPrompt),
      activeToolNames: Object.freeze([...this.inner.getActiveToolNames()]),
      roleId: this.roleId,
      agentMode: this.agentMode,
    });
  }

  private buildFrozenTurnContext(
    turnId: string,
    turnContext: PreparedTurnContext,
    admission: TurnAdmissionSnapshot,
  ): TurnContextSnapshot {
    const instructionContext = turnContext.systemPromptBlock.trim();
    const skillUserPrompt = turnContext.userPromptBlock.trim();
    const effectiveSystemPrompt = instructionContext
      ? `${admission.systemPrompt}\n\n${instructionContext}`
      : admission.systemPrompt;
    return Object.freeze({
      turnId,
      effectiveSystemPrompt,
      ...(instructionContext ? { instructionContext } : {}),
      ...(skillUserPrompt ? { skillUserPrompt } : {}),
      activeToolNames: admission.activeToolNames,
      roleId: admission.roleId,
      agentMode: admission.agentMode,
      references: Object.freeze([...turnContext.references]),
      ...(turnContext.skill ? { skill: Object.freeze({ ...turnContext.skill }) } : {}),
      createdAt: Date.now(),
    });
  }

  private setRole(roleId: string | null, persist = true): void {
    const normalized = roleId?.trim() || null;
    const changed = this.roleId !== normalized;
    this.roleId = normalized;
    this.applyRolePrompt();
    if (persist && changed && this.session.persisted) {
      try {
        this.session.appendCustomEntry("role_profile", { roleId: this.roleId });
      } catch { /* best effort */ }
    }
  }

  get sessionId(): string {
    return this.session.id;
  }

  get sessionFile(): string {
    return this.session.file ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  private async beginChangedFilesTurn(): Promise<void> {
    // 上一终态的 Git 结算仍在进行时，短暂等待其完成，避免新回合基线
    // 覆盖尚未读取结束快照的旧基线（Git 超时 3s，上限留出余量）。
    const finalizeDeadline = Date.now() + 3_500;
    while (this.changedFilesFinalizing && Date.now() < finalizeDeadline) {
      await sleepMs(10);
    }
    this.explicitChangedFilesInTurn.clear();
    this.gitChangedFilesBaseline = this.session.cwd ? await readGitStatusSnapshot(this.session.cwd) : null;
    this.gitChangedFilesTrackingActive = true;
  }

  private consumeExplicitChangedFiles(): string[] {
    const changedFiles = [...this.explicitChangedFilesInTurn];
    this.explicitChangedFilesInTurn.clear();
    this.gitChangedFilesBaseline = null;
    this.gitChangedFilesTrackingActive = false;
    return changedFiles;
  }

  private enrichFallbackTerminalEvent(event: AgentEvent): AgentEvent {
    const changedFiles = this.consumeExplicitChangedFiles();
    return changedFiles.length > 0 ? { ...event, changedFiles } : event;
  }

  private appendRuntimeAudit(customType: "auto_retry" | "abort" | "recover", data: Record<string, unknown>): void {
    try {
      this.session.appendCustomEntry(customType, data);
    } catch (error) {
      // 审计记录不能阻断正常的重试 / 中止 / 恢复控制流。
      console.warn(`Failed to persist ${customType} audit entry`, error);
    }
  }

  start(): void {
    if (this.unsubscribe) return;

    const liveIsland = getLiveIslandClient();
    const cwd = this.session.cwd;
    liveIsland.trackSession(this.session.id, cwd);

    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      const turnKey = this.currentTurnKey;
      if (event.type === "agent_end" && event.willRetry !== true) this.changedFilesFinalizing = true;
      if (event.type === "agent_start") {
        this.transitionCurrentRun({ status: "running", lastEventType: event.type });
      } else if (event.type === "agent_end" && event.willRetry !== true) {
        const error = typeof event.error === "string" ? event.error : undefined;
        const errorCode = typeof event.errorCode === "string" ? event.errorCode : undefined;
        const stopReason = typeof event.stopReason === "string" ? event.stopReason : undefined;
        const cancelled = stopReason === "aborted" || error === "aborted";
        this.transitionCurrentRun({
          status: cancelled ? "cancelled" : error ? "failed" : "succeeded",
          lastEventType: event.type,
          ...(!cancelled && error ? { error } : {}),
          ...(!cancelled && errorCode ? { errorCode } : {}),
        });
      }
      if (event.type === "agent_start" || event.type === "agent_end") this.recordEventStatus(event);
      // 串行化异步 Git 读取；单个 Git 超时只延后本 session 的收尾，绝不阻塞 Node 事件循环。
      this.agentEventQueue = this.agentEventQueue
        .then(() => this.handleEngineEvent(event, liveIsland, turnKey))
        .catch((error) => {
          if (event.type === "agent_end" && event.willRetry !== true) this.changedFilesFinalizing = false;
          console.warn("agent event handling failed:", error);
        });
    });
    this.startIdlePulse();
    // A wrapper may be cold-started after a mux connection baseline was sent.
    // Publish its initial idle/transient state so late creation still converges.
    this.emitHostState();
  }

  private async handleEngineEvent(
    event: AgentEvent,
    liveIsland: ReturnType<typeof getLiveIslandClient>,
    turnKey: string | null,
  ): Promise<void> {
    // ★ R7 审查修复：防止在 destroy() → unsubscribe() 窗口期间，
    // 已销毁 session 的 SDK 回调继续触发副作用
    if (!this._alive) return;

    const currentCwd = this.session.cwd;
    let emittedEvent = event;

      // 基线在 prompt/fresh-turn 准入时建立，避免普通回合在 agent_start 前已标记活跃而漏建；
      // 自动重试的 agent_start 只复用已有基线。
      if (event.type === "agent_start" && !this.gitChangedFilesTrackingActive) {
        await this.beginChangedFilesTurn();
      }

      // Enrich only the final boundary, before EventStore/SSE/listeners observe it.
      if (event.type === "agent_end" && event.willRetry !== true) {
        const gitChangedFiles = currentCwd
          ? diffGitStatusSnapshots(this.gitChangedFilesBaseline, await readGitStatusSnapshot(currentCwd), currentCwd)
          : [];
        const changedFiles = [...new Set([...this.explicitChangedFilesInTurn, ...gitChangedFiles])];
        if (changedFiles.length > 0) emittedEvent = { ...event, changedFiles };
        this.gitChangedFilesBaseline = null;
        this.gitChangedFilesTrackingActive = false;
        this.explicitChangedFilesInTurn.clear();
        this.changedFilesFinalizing = false;
      }

      if (event.type === "auto_retry_start") {
        this.appendRuntimeAudit("auto_retry", {
          phase: "start",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          retryAfterMs: event.retryAfterMs,
        });
      } else if (event.type === "auto_retry_end") {
        this.appendRuntimeAudit("auto_retry", {
          phase: "end",
          success: event.success,
          attempt: event.attempt,
          ...(event.finalError ? { finalError: event.finalError } : {}),
        });
      }
      // Tag every event with the current turn key so real-time broadcasts
      // match SSE replay semantics (where turnId comes from the store).
      const tagged = turnKey ? { ...emittedEvent, turnId: turnKey } as AgentEvent : emittedEvent;
      getAgentEventStore().append({
        sessionId: this.session.id,
        runId: this.session.id,
        ...(turnKey ? { turnId: turnKey } : {}),
        event: emittedEvent,
      });
      if (emittedEvent.type !== "agent_start" && emittedEvent.type !== "agent_end") this.recordEventStatus(emittedEvent);
      this.touch();
      for (const l of this.listeners) l(tagged);

      // Forward to AIControls Live Island
      liveIsland.handleEvent(this.session.id, currentCwd, emittedEvent);

      if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
        this.pendingToolEvents.set(event.toolCallId, event);
        return;
      }
      const sourceEvent = event.type === "tool_execution_end" && typeof event.toolCallId === "string"
        ? { ...(this.pendingToolEvents.get(event.toolCallId) ?? {}), ...event }
        : event;
      if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
        this.pendingToolEvents.delete(event.toolCallId);
      }
      const changedFilePaths = extractChangedFilePaths(sourceEvent);
      if (changedFilePaths.length > 0 && currentCwd) {
        const seenChangedFiles = new Set<string>();
        for (const changedFilePath of changedFilePaths) {
          const resolved = resolveChangedFilePath(changedFilePath, currentCwd);
          if (!resolved || seenChangedFiles.has(resolved)) continue;
          seenChangedFiles.add(resolved);
          this.explicitChangedFilesInTurn.add(resolved);
          const fileChangedEvent: AgentEvent = { type: "agent_file_changed", filePath: resolved, toolName: extractToolName(sourceEvent) };
          getAgentEventStore().append({
            sessionId: this.session.id,
            runId: this.session.id,
            ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
            event: fileChangedEvent,
          });
          for (const l of this.listeners) l(turnKey ? { ...fileChangedEvent, turnId: turnKey } as AgentEvent : fileChangedEvent);
        }
      }
  }

  // Idle timeout: keep inactive wrappers cheap, but never kill a running turn
  // just because a reasoning model stays quiet for longer than 10 minutes.
  private static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  private static readonly ACTIVE_TURN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly TOOL_EXEC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  // How long before the hard idle destroy we emit an `agent_stale_warning`
  // event, giving the frontend a chance to auto-recover (abort + follow_up)
  // instead of letting the session be torn down silently. This closes the gap
  // where the frontend watchdog missed its recovery window (e.g. the tab was
  // backgrounded and setInterval was throttled, or retry/tools phases skipped
  // the check). SSE pushes this event regardless of tab throttling.
  private static readonly IDLE_STALE_WARNING_LEAD_MS = 2 * 60 * 1000;

  // ── 基于 generation number 的 GC 模式 + 懒淘汰（lazy eviction）──
  // 用 generation counter + lastActiveAt 替代 setTimeout 直接销毁，
  // 在 send()/onEvent() 入口做懒淘汰检查；pulse 仅做兜底巡检。
  // 参考：VS Code DisposableStore + Prisma connection pool 的 lastUsedAt 检查。

  /** 标记活跃，更新 lastActiveAt 并重置 stale 警告标记。 */
  private touch(): void {
    this.lastActiveAt = Date.now();
    // Any new event means the turn is making progress — allow the next idle
    // window to fire a fresh stale warning.
    this.staleWarningSent = false;
  }

  /** 根据当前状态计算对应的空闲超时时间。 */
  private getLazyTimeout(): number {
    const hasActiveTools = this.pendingToolEvents.size > 0;
    return hasActiveTools
      ? AgentSessionWrapper.TOOL_EXEC_IDLE_TIMEOUT_MS
      : this._isRunning
        ? AgentSessionWrapper.ACTIVE_TURN_IDLE_TIMEOUT_MS
        : AgentSessionWrapper.IDLE_TIMEOUT_MS;
  }

  /**
   * 懒淘汰检查：在 send() / onEvent() 入口被调用。超时则同步销毁。
   * pulse 也走同一个入口，避免 setTimeout 的 event-loop 竞态窗口。
   */
  private checkIdleLazily(): void {
    if (!this._alive) return;
    const timeout = this.getLazyTimeout();
    if (this.lastActiveAt + timeout < Date.now()) {
      this.destroy();
      return;
    }

    // stale warning: 只在 turn 活跃时发出，空闲 session 直接等销毁
    if (this._isRunning && !this.staleWarningSent) {
      const idleMs = Date.now() - this.lastActiveAt;
      const destroyIn = timeout - idleMs;
      if (destroyIn > 0 && destroyIn <= AgentSessionWrapper.IDLE_STALE_WARNING_LEAD_MS
          && idleMs >= 60_000) {
        this.emitStaleWarning();
      }
    }
  }

  /** 启动定期 pulse（60s），做兜底懒淘汰巡检。pulse 本身不销毁——它调用 checkIdleLazily。 */
  private startIdlePulse(): void {
    if (this.idlePulseInterval) return;
    this.idlePulseInterval = setInterval(() => {
      this.checkIdleLazily();
    }, 60_000);
  }

  private emitStaleWarning(): void {
    if (!this._alive || this.staleWarningSent) return;
    const idleMs = this.lastEventAt ? Date.now() - this.lastEventAt : 0;
    // Defensive floor: if the last event was very recent, the turn is making
    // progress. This guards against misconfiguration (IDLE_STALE_WARNING_LEAD_MS
    // set so large that warningDelay collapses toward 0 and the timer fires
    // shortly after turn start) or future bugs that fail to clear the timer.
    // It cannot fully eliminate the event-loop race where a timer callback
    // (timers phase) runs just before a queued SDK I/O callback (poll phase)
    // that would have reset the timer — that window is tiny and the fallout
    // (one abort + follow_up) is acceptable, so we don't add setImmediate
    // indirection just for it.
    if (idleMs < 60_000) return;
    this.staleWarningSent = true;
    for (const l of this.listeners) {
      l({
        type: "agent_stale_warning",
        idleMs,
        destroyInMs: AgentSessionWrapper.IDLE_STALE_WARNING_LEAD_MS,
        isRunning: this._isRunning,
        isStreaming: Boolean(this.inner.isStreaming),
        lastEventType: this.lastEventType,
      });
    }
  }

  private emitHostState(updatedAt = Date.now()): void {
    const status = this.getStatus();
    hostEventBus.emit({
      type: "host_running_snapshot",
      sessions: listRpcHostRunningSessions(updatedAt),
    });
    hostEventBus.emit({
      type: "session_transient_snapshot",
      sessionId: this.sessionId,
      running: status.isRunning,
      isStreaming: status.isStreaming,
      isCompacting: status.isCompacting,
      thinkingLevel: this.inner.thinkingLevel,
      updatedAt,
    });
  }

  private recordEventStatus(event: AgentEvent): void {
    const previous = this.getStatus();
    const now = Date.now();
    if (event.type === "agent_start" || !this.runStartedAt || (!this.inner.isStreaming && !this.inner.isCompacting)) {
      this.runStartedAt = now;
      this.eventCount = 0;
      this.lastContentLength = 0;
      this.lastContentAt = now;
    }
    this.eventCount += 1;
    this.lastEventType = event.type;
    this.lastEventAt = now;

    // Track active turn state (agent_start → agent_end).
    // Auto-retry keeps the turn alive: SDK emits agent_end with willRetry=true,
    // then either agent_start (retry success) or auto_retry_end with success=false.
    if (event.type === "agent_start") {
      this._turnActive = true;
      this._isRunning = true;
      this.sawAssistantEventInTurn = false;
    }
    if (event.type === "agent_end") {
      const willRetry = (event as { willRetry?: boolean }).willRetry ?? false;
      if (!willRetry) {
        // agent_end 是对外的终态边界。内部 Promise 仍可能在 finally 中收尾，
        // 但不能再把 UI/API 误报为运行中。
        this._turnActive = false;
        this._isRunning = false;
        this._stopRequested = false;
        forceRefreshSessionList();
      }
    }
    if (event.type === "auto_retry_end") {
      const success = (event as { success?: boolean }).success ?? true;
      if (!success) {
        this._turnActive = false;
        this._isRunning = false;
      }
    }

    const nextContentLength = getEventContentLength(event);
    if (nextContentLength !== null && nextContentLength !== this.lastContentLength) {
      this.lastContentLength = nextContentLength;
      this.lastContentAt = now;
    }
    if (
      (event.type === "message_start" || event.type === "message_update" || event.type === "message_end")
      && isRecord(event.message)
      && event.message.role === "assistant"
    ) {
      this.sawAssistantEventInTurn = true;
    }

    const current = this.getStatus();
    if (
      previous.isRunning !== current.isRunning
      || previous.isStreaming !== current.isStreaming
      || previous.isCompacting !== current.isCompacting
      || event.type === "agent_start"
      || event.type === "agent_end"
      || event.type === "compaction_start"
      || event.type === "compaction_end"
      || event.type === "auto_compaction_start"
      || event.type === "auto_compaction_end"
    ) {
      this.emitHostState(now);
    }
  }

  getTransientState(): { thinkingLevel?: string } {
    return { thinkingLevel: this.inner.thinkingLevel };
  }

  getStatus() {
    const now = Date.now();
    const runningForMs = this.runStartedAt ? Math.max(0, now - this.runStartedAt) : 0;
    return {
      sessionId: this.sessionId,
      isStreaming: Boolean(this.inner.isStreaming),
      isCompacting: Boolean(this.inner.isCompacting),
      lastEventType: this.lastEventType,
      eventCount: this.eventCount,
      eventRate: runningForMs > 0 ? this.eventCount / (runningForMs / 1000) : 0,
      eventIdleMs: this.lastEventAt ? now - this.lastEventAt : null,
      contentIdleMs: this.lastContentAt ? now - this.lastContentAt : null,
      isRunning: this.isTurnRunningForUi(),
      stopRequested: this._stopRequested,
    };
  }

  onEvent(listener: EventListener): () => void {
    this.checkIdleLazily();
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  private trackTurn(turnId: number, promise: Promise<void>): void {
    this.activeTurnPromise = promise;

    promise.catch((err: unknown) => {
      // If a recovery follow_up has already started, this rejection belongs to
      // the aborted old turn and must not mark the new turn as failed. Likewise,
      // an engine that already emitted its terminal agent_end needs no duplicate.
      if (!this._alive || this.activeTurnId !== turnId || (!this._turnActive && !this._isRunning)) return;
      this._turnActive = false;
      this._isRunning = false;
      this._stopRequested = false;
      const msg = err instanceof Error ? err.message : String(err);
      // 推断标准化错误码，让前端能按 errorCode（如 UPSTREAM_TTFT_TIMEOUT）触发
      // 备用模型 recovery——与 engine 正常 emit 的 agent_end 行为一致。
      const errorCode = classifyLlmError(err).code;
      this.transitionCurrentRun({
        status: "failed",
        lastEventType: "wrapper_unhandled_error",
        error: msg,
        ...(errorCode && errorCode !== "UNKNOWN" ? { errorCode } : {}),
      });
      const ev: AgentEvent = this.enrichFallbackTerminalEvent({ type: "agent_end", willRetry: false, error: msg });
      if (errorCode && errorCode !== "UNKNOWN") ev.errorCode = errorCode;
      getAgentEventStore().append({
        sessionId: this.session.id,
        runId: this.session.id,
        ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
        event: ev,
      });
      for (const l of this.listeners) l(ev);
    }).finally(() => {
      if (this.activeTurnId !== turnId) return;
      this.activeTurnPromise = null;
      if (this._isRunning && !this.inner.isStreaming && this.sawAssistantEventInTurn) {
        this._turnActive = false;
        this._isRunning = false;
        this._stopRequested = false;
        const error = [
          "Agent 回合 Promise 已结束，但底层引擎没有发送最终 agent_end",
          `session=${this.session.id}`,
          `lastEventType=${this.lastEventType || "unknown"}`,
          `eventCount=${this.eventCount}`,
        ].join("；");
        const ev: AgentEvent = this.enrichFallbackTerminalEvent({ type: "agent_end", willRetry: false, error });
        getAgentEventStore().append({
          sessionId: this.session.id,
          runId: this.session.id,
          ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
          event: ev,
        });
        for (const l of this.listeners) l(ev);
      }
    });
  }

  private async waitForCurrentTurnToStop(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleepMs(Math.min(50, remaining));
    }
  }

  private async abortAndSettleCurrentTurn(timeoutMs = 8_000): Promise<void> {
    const turnPromise = this.activeTurnPromise;
    const turnId = this.activeTurnId;
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;

    // inner.abort() 自身会等待 Engine 最多 30 秒。Recover 的 8 秒必须是包含
    // 这段等待的总 deadline，而不是等 abort 返回后才开始计时。
    const abortPromise = Promise.resolve().then(() => this.inner.abort());
    void abortPromise.catch((error) => {
      if (timedOut) console.error("Late agent abort failed", error);
    });
    const abortSettled = await Promise.race([
      abortPromise.then(() => true),
      sleepMs(Math.max(0, deadline - Date.now())).then(() => false),
    ]);
    if (!abortSettled) {
      timedOut = true;
      throw new Error(`abort timeout: current turn did not settle within ${timeoutMs}ms`);
    }

    await this.waitForCurrentTurnToStop(Math.max(0, deadline - Date.now()));
    if (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
      timedOut = true;
      throw new Error(`abort timeout: current turn did not settle within ${timeoutMs}ms`);
    }

    if (turnPromise && this.activeTurnId === turnId) {
      const turnSettled = await Promise.race([
        turnPromise.then(() => true, () => true),
        sleepMs(Math.max(0, deadline - Date.now())).then(() => false),
      ]);
      if (!turnSettled) {
        timedOut = true;
        throw new Error(`abort timeout: current turn promise did not settle within ${timeoutMs}ms`);
      }
    }
  }

  private reserveFreshTurnAdmission(message: string): AbortController {
    if (this.freshTurnAdmissionController || this.pendingPromptController) {
      throw new Error(`AGENT_BUSY: ${message}`);
    }
    const controller = new AbortController();
    this.freshTurnAdmissionController = controller;
    return controller;
  }

  private releaseFreshTurnAdmission(controller: AbortController): void {
    if (this.freshTurnAdmissionController === controller) {
      this.freshTurnAdmissionController = null;
    }
  }

  private canReloadMcpNow(): boolean {
    return !this.isTurnBusy() && !this._turnActive && !this._stopRequested;
  }

  private installMcpRuntime(nextRuntime: McpRuntime, activateMcp: boolean): void {
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const nextMcpToolNames = new Set(nextRuntime.toolNames);
    const activeBefore = this.inner.getActiveToolNames();
    const systemPromptBefore = this.inner.systemPrompt;
    const baseSystemPromptBefore = this.baseSystemPrompt;

    const nextActiveToolNames = activeBefore.filter((name) => !previousMcpToolNames.has(name) && !name.startsWith("mcp__"));
    if (activateMcp) nextActiveToolNames.push(...nextMcpToolNames);

    try {
      // 后续同步全部显式使用 nextRuntime，不能通过尚未切换的 Lease getter
      // 读到旧 Runtime。任一步失败都在 catch 中恢复 Registry、激活名单和 Prompt。
      this.inner.replaceCustomTools({
        removeNames: [...previousMcpToolNames],
        addTools: nextRuntime.tools,
        extraAllowedNames: [...nextMcpToolNames],
        activeToolNames: nextActiveToolNames,
      });
      this.inner.applyToolExecutionModes();
      this.baseSystemPrompt = stripTurnContextBlock(this.inner.systemPrompt);
      this.applyRolePrompt(nextRuntime, true);
    } catch (error) {
      this.baseSystemPrompt = baseSystemPromptBefore;
      try {
        this.inner.replaceCustomTools({
          removeNames: [...nextMcpToolNames],
          addTools: previousRuntime?.tools ?? [],
          extraAllowedNames: [...previousMcpToolNames],
          activeToolNames: activeBefore,
        });
        this.inner.applyToolExecutionModes();
        this.inner.setSystemPromptPersistent(systemPromptBefore);
      } catch (rollbackError) {
        console.error("Failed to roll back MCP runtime installation", rollbackError);
      }
      throw error;
    }
  }

  private canCommitAsyncRuntime(signal?: AbortSignal, extraCheck?: () => boolean): boolean {
    return this._alive && !signal?.aborted && (extraCheck?.() ?? true);
  }

  private throwIfAsyncRuntimeInvalid(signal?: AbortSignal, extraCheck?: () => boolean): void {
    if (!this._alive) throw new DOMException("Session destroyed", "AbortError");
    signal?.throwIfAborted();
    if (extraCheck && !extraCheck()) {
      throw new DOMException("MCP commit no longer allowed", "AbortError");
    }
  }

  /** 独立成可替换边界，便于用 gate 验证 acquire 晚到时的 Lease ownership。 */
  private async acquireMcpRuntimeLease(): Promise<McpRuntimeLease> {
    const { acquireMcpRuntime } = await import("./mcp-runtime");
    return acquireMcpRuntime(this.session.cwd);
  }

  private async ensureMcpRuntimeLoaded(options: EnsureMcpRuntimeOptions = {}): Promise<McpRuntime | null> {
    const { activateMcp = false, signal, canCommit } = options;
    this.throwIfAsyncRuntimeInvalid(signal, canCommit);

    if (this.mcpRuntime) {
      if (activateMcp) {
        this.throwIfAsyncRuntimeInvalid(signal, canCommit);
        this.installMcpRuntime(this.mcpRuntime, true);
      }
      return this.mcpRuntime;
    }

    this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    const lease = await this.acquireMcpRuntimeLease();
    let leaseOwned = true;
    const releaseLease = () => {
      if (!leaseOwned) return;
      leaseOwned = false;
      lease.release();
    };

    if (!this.canCommitAsyncRuntime(signal, canCommit)) {
      releaseLease();
      this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    }

    try {
      // installMcpRuntime 是同步事务；提交前的校验与 Lease ownership 转移之间
      // 不存在 event-loop 抢占点，晚到任务无法越过该边界污染未来回合。
      this.installMcpRuntime(lease.runtime, activateMcp);
      this.mcpRuntimeLease = lease;
      leaseOwned = false;
      return lease.runtime;
    } catch (error) {
      releaseLease();
      throw error;
    }
  }

  private async prepareImageFallback(
    message: string,
    images?: RuntimeImage[],
    displayMessage = message,
    signal?: AbortSignal,
    canCommit?: () => boolean,
  ): Promise<{ message: string; images?: RuntimeImage[]; displayContent?: DisplayUserContent }> {
    this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    if (!images?.length) return { message, images };

    // Resolve filePath → base64 data for images that are stored on disk.
    // This keeps session files lean (only file references) while still
    // sending actual image data to the model API when needed.
    const fs = await import("fs");
    this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    const resolvedImages = await Promise.all(images.map(async (img) => {
      signal?.throwIfAborted();
      if (img.filePath && !img.data) {
        try {
          const fileData = fs.readFileSync(img.filePath);
          const base64 = fileData.toString("base64");
          return { ...img, data: base64 };
        } catch {
          // File read failed — pass through without data
          return img;
        }
      }
      return img;
    }));
    this.throwIfAsyncRuntimeInvalid(signal, canCommit);

    const displayContent = buildDisplayUserContent(displayMessage, resolvedImages);
    const supportsImageInput = (this.inner.model as { input?: string[] } | null | undefined)?.input?.includes("image") ?? false;
    if (supportsImageInput) return { message, images: resolvedImages, displayContent };

    let mcpRuntime: McpRuntime | null = null;
    try {
      mcpRuntime = await this.ensureMcpRuntimeLoaded({ signal, canCommit });
    } catch (error) {
      if (signal?.aborted || !this._alive || (canCommit && !canCommit())) throw error;
    }
    this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    if (mcpRuntime) {
      const sdkFallbackImages = toSdkImages(resolvedImages);
      if (sdkFallbackImages?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawDescriptions = await mcpRuntime.describeImages(sdkFallbackImages as any, message, signal).catch((error) => {
          if (signal?.aborted) throw error;
          return [] as string[];
        });
        this.throwIfAsyncRuntimeInvalid(signal, canCommit);
        // Filter out error lines — keep only actual image descriptions.
        const validDescriptions = rawDescriptions.filter(
          (text) => !text.startsWith("MCP 图片识别失败") && !/^图片 \d+ 识别失败/.test(text),
        );
        if (validDescriptions.length > 0) {
          const imageContext = validDescriptions
            .map((text, index) => `图片 ${index + 1}:\n${text}`)
            .join("\n\n");
          this.throwIfAsyncRuntimeInvalid(signal, canCommit);
          return {
            message: `${message}\n\n<image_context source="mcp-vision-fallback">\n${imageContext}\n</image_context>\n\n注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。`,
            images: undefined,
            displayContent,
          };
        }
      }
    }

    this.throwIfAsyncRuntimeInvalid(signal, canCommit);
    // No usable MCP vision fallback — just return the message without images.
    return { message, images: undefined, displayContent };
  }

  private async reloadMcpRuntime(): Promise<{ ok: boolean; skipped?: boolean; toolNames?: string[]; serverStatuses?: McpRuntime["serverStatuses"] }> {
    if (!this.canReloadMcpNow()) {
      return { ok: false, skipped: true };
    }

    const cwd = this.session.cwd;
    const { acquireMcpRuntime } = await import("./mcp-runtime");
    const nextLease = await acquireMcpRuntime(cwd);

    // acquire 期间可能有新 Prompt/Recover/Steer/Follow-up 进入准入。
    // 此时新 Lease 不能安装，也不能泄漏。
    if (!this.canReloadMcpNow()) {
      nextLease.release();
      return { ok: false, skipped: true };
    }

    const nextRuntime = nextLease.runtime;
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const activeBefore = this.inner.getActiveToolNames();
    const hadActiveMcp = activeBefore.some((name) => previousMcpToolNames.has(name) || name.startsWith("mcp__"));
    const isFullPreset = isFullToolPreset(activeBefore);

    try {
      this.installMcpRuntime(nextRuntime, hadActiveMcp || isFullPreset);
    } catch (error) {
      nextLease.release();
      throw error;
    }

    this.mcpRuntimeLease?.release();
    this.mcpRuntimeLease = nextLease;

    return { ok: true, toolNames: nextRuntime.toolNames, serverStatuses: nextRuntime.serverStatuses };
  }

  /**
   * Prepare + commit + track a fresh prompt turn. Shared by `prompt` and
   * `recover` so both follow identical event/persistence semantics
   * (display_user_message append, message_end/user echo, trackTurn).
   */
  private async commitAndTrackPromptTurn(
    rawMessage: string,
    references: unknown,
    skillName: unknown,
    images: Array<{ type: "image"; data: string; mimeType: string }> | undefined,
    clientMessageId: string | undefined,
    admission: TurnAdmissionSnapshot,
    signal?: AbortSignal,
    canCommit?: () => boolean,
  ): Promise<{ turnId: string }> {
    const turnNum = ++this.activeTurnId;
    const turnKey = `${this.session.id}:t${turnNum}`;
    this.currentTurnKey = turnKey;
    this.createPromptRun(turnKey, clientMessageId);
    this.transitionCurrentRun({ status: "preparing", lastEventType: "prompt_preparing" });

    try {
      const turnContext = await this.prepareTurnContext(rawMessage, references, skillName, admission.agentMode);
      signal?.throwIfAborted();
      if (turnContext.displayMessage) {
        getLiveIslandClient().recordPrompt(this.session.id, turnContext.displayMessage);
      }
      const prepared = await this.prepareImageFallback(turnContext.message, images, turnContext.displayMessage, signal, canCommit);
      signal?.throwIfAborted();
      const frozenContext = this.buildFrozenTurnContext(turnKey, turnContext, admission);

      const displayUserContent = prepared.displayContent ?? turnContext.displayMessage;
      // 先写入 durable receipt，再通知 SSE / 启动引擎。写失败时客户端可安全重试，
      // 且绝不允许模型先看到一条刷新后不存在的用户消息。
      // 顺序约束：display_user_message 必须是 user message 的直接 parent——
      // session-reader 的 getDisplayUserMessage 靠这个父子关系回读 clientMessageId
      // 与展示内容；turn_context 插在中间会切断该链路（见 32a2d25 引入的回归）。
      this.appendTurnContextMetadata(turnContext.references, turnContext.skill, admission.agentMode);
      this.appendDisplayUserMessage(displayUserContent, turnContext.references, turnContext.skill, clientMessageId, turnKey);
      await this.beginChangedFilesTurn();

      const userEchoEvent = {
        type: "message_end",
        message: {
          role: "user",
          content: displayUserContent,
          ...(turnContext.references.length ? { references: turnContext.references } : {}),
          ...(turnContext.skill ? { skill: turnContext.skill } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
          agentMode: admission.agentMode,
          timestamp: Date.now(),
        },
      } as AgentEvent;
      getAgentEventStore().append({
        sessionId: this.session.id,
        runId: this.session.id,
        ...(turnKey ? { turnId: turnKey } : {}),
        event: userEchoEvent,
      });
      for (const l of this.listeners) {
        l(turnKey ? { ...userEchoEvent, turnId: turnKey } as AgentEvent : userEchoEvent);
      }

      this.trackTurn(turnNum, this.inner.prompt({
        text: prepared.message,
        ...(toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : {}),
        context: frozenContext,
      }));
      return { turnId: turnKey };
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      this.transitionCurrentRun({
        status: aborted ? "cancelled" : "failed",
        lastEventType: "prompt_admission_failed",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { errorCode: error.code } : {}),
      });
      throw error;
    }
  }

  private async startPreparedFreshTurn(options: {
    prepared: { message: string; images?: RuntimeImage[]; displayContent?: DisplayUserContent };
    turnContext: PreparedTurnContext;
    admission: TurnAdmissionSnapshot;
    source: "steer_promoted" | "follow_up_promoted";
  }): Promise<{ turnId: string }> {
    const turnNum = ++this.activeTurnId;
    const turnKey = `${this.session.id}:t${turnNum}`;
    const frozenContext = this.buildFrozenTurnContext(turnKey, options.turnContext, options.admission);
    const displayUserContent = options.prepared.displayContent ?? options.turnContext.displayMessage;

    this.currentTurnKey = turnKey;
    this.createPromptRun(turnKey);
    this.transitionCurrentRun({ status: "preparing", lastEventType: `${options.source}_preparing` });
    try {
      this.appendTurnContextMetadata(options.turnContext.references, options.turnContext.skill, options.admission.agentMode);
      this.appendDisplayUserMessage(displayUserContent, options.turnContext.references, options.turnContext.skill, undefined, turnKey);
      this._turnActive = true;
      await this.beginChangedFilesTurn();
      this.trackTurn(turnNum, this.inner.prompt({
        text: options.prepared.message,
        ...(toSdkImages(options.prepared.images) ? { images: toSdkImages(options.prepared.images)! } : {}),
        context: frozenContext,
      }));
      return { turnId: turnKey };
    } catch (error) {
      this._turnActive = false;
      const aborted = error instanceof DOMException && error.name === "AbortError";
      this.transitionCurrentRun({
        status: aborted ? "cancelled" : "failed",
        lastEventType: `${options.source}_admission_failed`,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 内部准入保护：允许比实际回合状态更保守，防止旧清理与新 prompt 竞争。 */
  private isTurnBusy(): boolean {
    // isCompacting：自动压缩在 `_isRunning`/stream 之前就会占用回合；漏计会导致
    // abort 认为已空闲、stopRequested 立刻被清掉，UI 卡在「正在压缩上下文…」。
    return Boolean(
      this.pendingPromptController
      || this.freshTurnAdmissionController
      || this._isRunning
      || this.inner.isStreaming
      || this.inner.isCompacting,
    );
  }

  /**
   * 面向 UI/API 的回合状态。它以最终 agent_end 为终态，不受内部 Promise
   * finally 收尾时序影响；避免前端在收到 agent_end 后又被状态刷新重新锁住。
   */
  private isTurnRunningForUi(): boolean {
    return this._turnActive;
  }

  async send(command: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> {
    this.touch();
    this.checkIdleLazily();
    const type = command.type as string;

    switch (type) {
      case "prompt": {
        const promptClientMessageId = typeof command.clientMessageId === "string" && command.clientMessageId.trim()
          ? command.clientMessageId.trim()
          : undefined;
        // Check idempotency before the busy guard: a retry for the currently
        // running turn is a successful duplicate, not an AGENT_BUSY conflict.
        if (promptClientMessageId) {
          const pending = this.pendingPromptAdmissions.get(promptClientMessageId);
          if (pending) {
            const accepted = await pending.promise;
            return { accepted: true, duplicate: true, clientMessageId: promptClientMessageId, turnId: accepted.turnId };
          }
          const accepted = this.findAcceptedPrompt(promptClientMessageId);
          if (accepted) {
            return { accepted: true, duplicate: true, clientMessageId: promptClientMessageId, turnId: accepted.turnId };
          }
        }
        if (this.isTurnBusy() || this.changedFilesFinalizing || this._stopRequested) {
          throw new Error("AGENT_BUSY: 当前会话仍有回合运行或正在停止，请等待回合结束后重试");
        }
        const admission = this.captureTurnAdmission(command);
        const admissionController = new AbortController();
        this._turnActive = true;
        this.pendingPromptController = admissionController;
        // Once a stable clientMessageId exists, admission belongs to the
        // wrapper/idempotency key rather than to one fragile HTTP connection.
        // A timed-out first waiter must not cancel a healthy same-id retry.
        const abortAdmission = () => admissionController.abort(requestSignal?.reason);
        const bindRequestAbort: AbortSignal | undefined = promptClientMessageId ? undefined : requestSignal;
        if (bindRequestAbort) {
          if (bindRequestAbort.aborted) abortAdmission();
          else bindRequestAbort.addEventListener("abort", abortAdmission, { once: true });
        }
        const promptText = typeof command.message === "string" ? command.message : "";
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        let admissionPromise: Promise<{ turnId: string }> | null = null;
        try {
          admissionPromise = this.commitAndTrackPromptTurn(
            promptText,
            command.references,
            command.skillName,
            promptImages,
            promptClientMessageId,
            admission,
            admissionController.signal,
            () => this.pendingPromptController === admissionController,
          );
          if (promptClientMessageId) {
            const pending = { promise: admissionPromise } as { turnId?: string; promise: Promise<{ turnId: string }> };
            this.pendingPromptAdmissions.set(promptClientMessageId, pending);
            void admissionPromise.then((value) => { pending.turnId = value.turnId; }, () => {});
          }
          const result = await admissionPromise;
          if (promptClientMessageId) this.pendingPromptAdmissions.delete(promptClientMessageId);
          return { accepted: true, duplicate: false, ...(promptClientMessageId ? { clientMessageId: promptClientMessageId } : {}), ...result };
        } catch (error) {
          if (promptClientMessageId) this.pendingPromptAdmissions.delete(promptClientMessageId);
          // 失败发生在 trackTurn 建立前时，不会有 engine 的 agent_end 兜底；
          // 必须在 wrapper 层撤销对外运行态，避免 get_state 残留 true。
          this._turnActive = false;
          throw error;
        } finally {
          bindRequestAbort?.removeEventListener("abort", abortAdmission);
          if (this.pendingPromptController === admissionController) {
            this.pendingPromptController = null;
          }
          if (!this.isTurnBusy()) this._stopRequested = false;
        }
      }

      case "set_role": {
        this.setRole(typeof command.roleId === "string" ? command.roleId : null);
        return { roleId: this.roleId, systemPrompt: this.inner.systemPrompt };
      }

      case "set_system_prompt": {
        const rawPrompt = typeof command.prompt === "string" ? command.prompt : "";
        this.baseSystemPrompt = stripModePrompt(rawPrompt);
        this.inner.setSystemPromptPersistent(rawPrompt);
        this.applyRolePrompt();
        return {
          systemPrompt: this.inner.systemPrompt,
        };
      }

      case "add_temporary_role_setting": {
        const text = typeof command.text === "string" ? command.text.trim() : "";
        if (text) this.temporaryRoleSettings.push(text);
        this.applyRolePrompt();
        return { ok: true, systemPrompt: this.inner.systemPrompt };
      }

      case "abort": {
        const source = typeof command.source === "string" ? command.source : "user";
        const reason = typeof command.reason === "string" ? command.reason : "stop_requested";
        this.appendRuntimeAudit("abort", { source, reason, running: this.isTurnBusy() });
        // Abort must be a low-latency control command. `inner.abort()` triggers
        // AbortController.abort() synchronously, but its returned promise only
        // resolves after the running prompt/tool loop has fully settled. If we
        // await it here, the HTTP request can appear to hang for seconds while
        // cleanup finishes, making the UI stop button feel ineffective.
        this._stopRequested = this.isTurnBusy();
        if (this._stopRequested) {
          this.transitionCurrentRun({ status: "stopping", lastEventType: "abort_requested" });
        }
        this.pendingPromptController?.abort(new DOMException("Stop requested", "AbortError"));
        this.freshTurnAdmissionController?.abort(new DOMException("Stop requested", "AbortError"));
        // 显式打断压缩（inner.abort 也会做）；保证压缩窗口 stop 一定生效。
        this.inner.abortCompaction();
        void this.inner.abort().then(() => {
          if (!this.isTurnBusy()) this._stopRequested = false;
        }).catch((err: unknown) => {
          console.error("Failed to abort agent turn:", err);
        });
        return {
          stopRequested: this._stopRequested,
          stopped: !this.isTurnBusy(),
        };
      }

      case "recover": {
        // Atomic abort-and-continue: reserve fresh-turn admission before settling
        // the old turn so no prompt/recover/idle follow-up can enter the gap.
        const recoveryAdmissionController = this.reserveFreshTurnAdmission("当前会话已有新回合正在准入，请稍后重试恢复");
        const recoverySource = typeof command.source === "string" ? command.source : "manual";
        const recoveryReason = typeof command.reason === "string" ? command.reason : "continue";
        this.appendRuntimeAudit("recover", {
          phase: "start",
          source: recoverySource,
          reason: recoveryReason,
          running: this.isTurnBusy(),
        });
        this.appendRuntimeAudit("abort", {
          source: recoverySource,
          reason: `recover:${recoveryReason}`,
          running: this.isTurnBusy(),
        });
        try {
          // 先只解析模型，找不到时保持旧回合不变；真正切换必须等旧回合 Abort/settle，
          // 否则 DeerLoopEngine 会拒绝运行中 setModel。
          const provider = typeof command.provider === "string" ? command.provider.trim() : undefined;
          const modelId = typeof command.modelId === "string" ? command.modelId.trim() : undefined;
          const recoveryModel = provider && modelId
            ? this.modelCatalog.resolve(provider, modelId)
            : undefined;
          if (provider && modelId && !recoveryModel) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
          }

          await this.abortAndSettleCurrentTurn();
          recoveryAdmissionController.signal.throwIfAborted();
          let modelChanged = false;
          if (recoveryModel) {
            await this.inner.setModel(recoveryModel);
            recoveryAdmissionController.signal.throwIfAborted();
            modelChanged = true;
          }
          const admission = this.captureTurnAdmission(command);

          const recoverText = typeof command.message === "string" ? command.message : "";
          const recoverImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const recoverClientMessageId = typeof command.clientMessageId === "string" && command.clientMessageId.trim()
            ? command.clientMessageId.trim()
            : undefined;
          const recoverTurn = await this.commitAndTrackPromptTurn(
            recoverText,
            command.references,
            command.skillName,
            recoverImages,
            recoverClientMessageId,
            admission,
            recoveryAdmissionController.signal,
            () => this.freshTurnAdmissionController === recoveryAdmissionController,
          );
          this.appendRuntimeAudit("recover", {
            phase: "end",
            success: true,
            source: recoverySource,
            reason: recoveryReason,
            modelChanged,
            turnId: recoverTurn.turnId,
          });
          return { recovered: true, modelChanged, turnId: recoverTurn.turnId };
        } catch (error) {
          this.appendRuntimeAudit("recover", {
            phase: "end",
            success: false,
            source: recoverySource,
            reason: recoveryReason,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          this.releaseFreshTurnAdmission(recoveryAdmissionController);
          if (!this.isTurnBusy()) this._stopRequested = false;
        }
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.session.id,
          sessionFile: this.session.file ?? "",
          isStreaming: this.inner.isStreaming,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          autoRecoveryMode: this.inner.autoRecoveryMode,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.systemPrompt,
          thinkingLevel: this.inner.thinkingLevel,
          agentMode: this.agentMode,
          capabilities: { subagent: this._subagentEnabled },
          activeToolNames: this.inner.getActiveToolNames(),
          isRunning: this.isTurnRunningForUi(),
          stopRequested: this._stopRequested,
          lastRun: this.getLastRun(),
          mcp: this.mcpRuntime ? {
            toolNames: this.mcpRuntime.toolNames,
            serverStatuses: this.mcpRuntime.serverStatuses,
          } : null,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.modelCatalog.resolve(provider, modelId);

        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const result = this.session.fork(command.entryId as string);
        if (!result) return { cancelled: true };
        cacheSessionPath(result.sessionId, result.sessionFile);
        forceRefreshSessionList();
        // Fork 后必须立即销毁：底层 Session 实现可能原地移动内部状态。
        this.destroy();
        return { cancelled: false, newSessionId: result.sessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigate(command.targetId as string);
        return {
          cancelled: result.cancelled,
          editorText: result.editorText,
          aborted: result.aborted,
        };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        this.emitHostState();
        return null;
      }

      case "compact": {
        const provider = typeof command.provider === "string" ? command.provider : undefined;
        const modelId = typeof command.modelId === "string" ? command.modelId : undefined;
        let summaryModel: RuntimeModel | undefined;
        if (provider && modelId) {
          summaryModel = this.modelCatalog.resolve(provider, modelId);
          if (!summaryModel) throw new Error(`压缩模型不存在: ${provider}/${modelId}`);
        }
        const abortOnDisconnect = () => this.inner.abortCompaction();
        requestSignal?.addEventListener("abort", abortOnDisconnect, { once: true });
        const compactionRunId = `run_${this.session.id}:compact:${Date.now().toString(36)}`;
        getAgentRunStore().create({
          runId: compactionRunId,
          sessionId: this.session.id,
          turnId: compactionRunId,
          requestKind: "compaction",
          model: { provider: this.inner.model.provider, modelId: this.inner.model.id },
        });
        const previousRunId = this.currentRunId;
        this.currentRunId = compactionRunId;
        this.transitionCurrentRun({ status: "running", lastEventType: "compaction_start" });
        try {
          const result = await this.inner.compact(
            command.customInstructions as string | undefined,
            "manual",
            summaryModel ? { model: summaryModel as never, provider, modelId } : undefined,
          );
          this.transitionCurrentRun({ status: "succeeded", lastEventType: "compaction_end" });
          return result;
        } catch (compactError) {
          this.transitionCurrentRun({
            status: "failed",
            lastEventType: "compaction_failed",
            error: compactError instanceof Error ? compactError.message : String(compactError),
            ...(compactError instanceof Error && "code" in compactError && typeof (compactError as { code?: unknown }).code === "string"
              ? { errorCode: (compactError as { code: string }).code }
              : {}),
          });
          throw compactError;
        } finally {
          this.currentRunId = previousRunId;
          requestSignal?.removeEventListener("abort", abortOnDisconnect);
        }
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        if (!this._isRunning && !this.inner.isStreaming) {
          throw new Error("AGENT_NOT_RUNNING: 当前没有可插入的运行回合");
        }
        const steerAdmissionController = this.reserveFreshTurnAdmission("当前有新回合正在准入，请稍后重试 Steer");
        try {
          const admission = this.captureTurnAdmission(command);
          const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const steerText = typeof command.message === "string" ? command.message : "";
          const turnContext = await raceWithAbort(
            this.prepareTurnContext(steerText, command.references, command.skillName, admission.agentMode),
            steerAdmissionController.signal,
          );
          const prepared = await raceWithAbort(
            this.prepareImageFallback(
              turnContext.message,
              steerImages,
              turnContext.displayMessage,
              steerAdmissionController.signal,
              () => this.freshTurnAdmissionController === steerAdmissionController,
            ),
            steerAdmissionController.signal,
          );

          if (this._isRunning || this.inner.isStreaming) {
            this.appendTurnContextMetadata(turnContext.references, turnContext.skill, admission.agentMode);
            this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
            await this.inner.steer({
              text: prepared.message,
              ...(toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : {}),
              context: this.buildFrozenTurnContext(`${this.session.id}:steer:${Date.now().toString(36)}`, turnContext, admission),
            });
            return null;
          }

          // 准备期间根回合已结束：不能把消息留在无人消费的 steeringQueue。
          // 使用 Steer 自己冻结的环境提升为独立新回合。
          return await this.startPreparedFreshTurn({ prepared, turnContext, admission, source: "steer_promoted" });
        } finally {
          this.releaseFreshTurnAdmission(steerAdmissionController);
        }
      }

      case "follow_up": {
        const queueIntoRunningTurn = this._isRunning || this.inner.isStreaming;
        if (!queueIntoRunningTurn && (this.isTurnBusy() || this.changedFilesFinalizing || this._stopRequested)) {
          throw new Error("AGENT_BUSY: 当前会话已有回合或新回合正在准入，请稍后重试");
        }
        const followAdmissionController = this.reserveFreshTurnAdmission("当前会话已有回合或新回合正在准入，请稍后重试");
        try {
          const admission = this.captureTurnAdmission(command);
          const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const followText = typeof command.message === "string" ? command.message : "";
          const turnContext = await raceWithAbort(
            this.prepareTurnContext(followText, command.references, command.skillName, admission.agentMode),
            followAdmissionController.signal,
          );
          const prepared = await raceWithAbort(
            this.prepareImageFallback(
              turnContext.message,
              followImages,
              turnContext.displayMessage,
              followAdmissionController.signal,
              () => this.freshTurnAdmissionController === followAdmissionController,
            ),
            followAdmissionController.signal,
          );

          if (this._isRunning || this.inner.isStreaming) {
            this.appendTurnContextMetadata(turnContext.references, turnContext.skill, admission.agentMode);
            this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
            await this.inner.followUp({
              text: prepared.message,
              ...(toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : {}),
              context: this.buildFrozenTurnContext(`${this.session.id}:follow:${Date.now().toString(36)}`, turnContext, admission),
            });
            return null;
          }

          return await this.startPreparedFreshTurn({ prepared, turnContext, admission, source: "follow_up_promoted" });
        } finally {
          this.releaseFreshTurnAdmission(followAdmissionController);
        }
      }

      case "mcp_reload": {
        return this.reloadMcpRuntime();
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "set_tools": {
        const requested = normalizeCodeGraphToolNames(
          Array.isArray(command.toolNames) ? command.toolNames.filter((name): name is string => typeof name === "string") : [],
        );
        if (isReadOnlyAgentMode(this.agentMode)) {
          this.inner.setActiveToolsByName(getToolNamesForAgentMode(this.agentMode));
          this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.systemPrompt));
          this.applyRolePrompt();
          return null;
        }
        const isFullPreset = isFullToolPreset(requested);
        if (isFullPreset || includesMcpTool(requested)) {
          await this.ensureMcpRuntimeLoaded({ activateMcp: true });
        }
        const toolNames = isFullPreset
          ? [...new Set([...requested, ...(this.mcpRuntime?.toolNames ?? [])])]
          : requested;
        this.inner.setActiveToolsByName(toolNames);
        this.applySubagentToActiveTools();
        this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.systemPrompt));
        this.applyRolePrompt();
        return null;
      }

      case "set_subagent_enabled": {
        this.setSubagentEnabled(command.enabled === true);
        return { enabled: this._subagentEnabled };
      }

      case "get_mode": {
        return { mode: this.agentMode, systemPrompt: this.inner.systemPrompt };
      }

      case "set_mode": {
        const nextMode = normalizeAgentMode(command.mode);
        await this.setAgentMode(nextMode);
        return { mode: this.agentMode, systemPrompt: this.inner.systemPrompt };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "set_auto_recovery_mode": {
        const mode = command.mode;
        if (mode !== "off" && mode !== "conservative" && mode !== "aggressive") {
          throw new Error(`Invalid auto recovery mode: ${String(mode)}`);
        }
        this.inner.setAutoRecoveryMode(mode);
        return { mode };
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    const hadActiveTurn = Boolean(
      this._turnActive
      || this.pendingPromptController
      || this._isRunning
      || this.inner.isStreaming
      || this.inner.isCompacting,
    );
    this._turnActive = false;
    this._isRunning = false;
    this._alive = false;
    this.pendingPromptController?.abort(new DOMException("Session destroyed", "AbortError"));
    this.pendingPromptController = null;
    this.freshTurnAdmissionController?.abort(new DOMException("Session destroyed", "AbortError"));
    this.freshTurnAdmissionController = null;
    this._stopRequested = true;
    if (this.idlePulseInterval) { clearInterval(this.idlePulseInterval); this.idlePulseInterval = null; }
    this.unsubscribe?.();
    // 活跃回合被销毁时必须向 Journal 写入终态；空闲 wrapper 回收不是业务回合结束。
    if (hadActiveTurn) {
      // 持久化 Run 同步收敛：wrapper 消失后运行态事实不能再停留在非终态
      //（否则进程重启后 reconcile 会把它误判为 interrupted——虽然语义接近，
      // 但 destroy 的直接原因是可记录的）。
      this.transitionCurrentRun({
        status: "interrupted",
        lastEventType: "wrapper_destroyed",
        errorCode: "RUNTIME_STOPPED",
        error: "Agent 会话 wrapper 在回合尚未结束时被销毁。",
      });
      const destroyEvent: AgentEvent = this.enrichFallbackTerminalEvent({
        type: "agent_end",
        willRetry: false,
        error: `Agent 会话在回合尚未结束时被销毁（session=${this.session.id}，lastEventType=${this.lastEventType || "unknown"}，eventIdleMs=${this.lastEventAt ? Date.now() - this.lastEventAt : "unknown"}）。`,
      });
      // SSE consumers subscribe to EventStore rather than wrapper.listeners.
      getAgentEventStore().append({
        sessionId: this.session.id,
        runId: this.session.id,
        ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
        event: destroyEvent,
      });
      for (const l of this.listeners) {
        try { l(destroyEvent); } catch { /* best effort */ }
      }
    }
    // Abort any ongoing agent turn (streaming, tools, retries) so underlying
    // WebSocket connections and child processes are released promptly.
    // Fire-and-forget: destroy() is called synchronously from idle timeout,
    // fork, and DELETE handler; blocking would delay those callers.
    //
    // Active Turn 要等 Abort 后再释放 MCP；Idle Registry 驱逐没有运行中工具，
    // 可立即释放，避免新 Session 启动时旧/新子进程短时叠加。
    const mcpLease = this.mcpRuntimeLease;
    this.mcpRuntimeLease = null;
    if (!hadActiveTurn) mcpLease?.release();
    this.inner.abort()
      .catch(() => {})
      .finally(() => {
        if (hadActiveTurn) mcpLease?.release();
        this.inner.dispose();
      })
      .catch(() => {}); // 防御性 catch：dispose 未来若抛异常，避免 unhandled rejection
    // 清理 EventStore 中该 session 的事件桶，避免长期运行后内存持续增长。
    // fork / idle-timeout / DELETE 都会走到这里，确保 session 销毁时释放事件缓存。
    getAgentEventStore().clearRun(this.session.id);
    this.emitHostState();
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __deerhuxSessions: Map<string, AgentSessionWrapper> | undefined;
  var __deerhuxSessionAliases: Map<string, string> | undefined;
  /** Stable new-session request id → real session id，带 TTL 的快速幂等索引。 */
  var __deerhuxCreatedSessions: Map<string, { sessionId: string; createdAt: number } | string> | undefined;
  var __deerhuxSessionStartReservations: number | undefined;
  var __deerhuxStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__deerhuxSessions) {
    globalThis.__deerhuxSessions = new Map();
    const cleanup = () => globalThis.__deerhuxSessions?.forEach((s) => s.destroy());
    registerShutdownCleanup(cleanup);
  }
  return globalThis.__deerhuxSessions;
}

// ★ Security/reliability: hard cap on concurrent in-process sessions to prevent
// unbounded memory growth under fork storms or high concurrency.
export class SessionCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Agent session capacity reached (${capacity}); wait for an active session to finish`);
    this.name = "SessionCapacityError";
  }
}

const MAX_REGISTRY_SESSIONS = (() => {
  const configured = Number(process.env.DEERHUX_MAX_LIVE_SESSIONS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 16;
})();

function evictIdleSessionsIfNeeded(): boolean {
  while (true) {
    const alive = uniqueRegistrySessions();
    const reserved = globalThis.__deerhuxSessionStartReservations ?? 0;
    if (alive.length + reserved < MAX_REGISTRY_SESSIONS) return true;

    // 永不驱逐运行中会话；选择最久未活动的 Idle Wrapper。
    let victim: AgentSessionWrapper | null = null;
    let victimIdle = -1;
    for (const session of alive) {
      const status = session.getStatus();
      if (status.isStreaming || status.isCompacting || status.isRunning) continue;
      const idle = Math.max(status.eventIdleMs ?? 0, status.contentIdleMs ?? 0);
      if (idle > victimIdle) {
        victimIdle = idle;
        victim = session;
      }
    }

    if (!victim) {
      console.warn(
        `[rpc-manager] Registry at capacity (${alive.length}+${reserved}/${MAX_REGISTRY_SESSIONS}); all sessions active, rejecting startup`,
      );
      return false;
    }
    console.warn(
      `[rpc-manager] Registry at capacity (${alive.length}+${reserved}/${MAX_REGISTRY_SESSIONS}), evicting idle session ${victim.sessionId}`,
    );
    victim.destroy();
  }
}

function getSessionAliases(): Map<string, string> {
  if (!globalThis.__deerhuxSessionAliases) globalThis.__deerhuxSessionAliases = new Map();
  const aliases = globalThis.__deerhuxSessionAliases;
  const registry = getRegistry();
  for (const [alias, realSessionId] of aliases) {
    if (!registry.has(realSessionId)) aliases.delete(alias);
  }
  while (aliases.size > 4_000) {
    const oldest = aliases.keys().next().value as string | undefined;
    if (!oldest) break;
    aliases.delete(oldest);
  }
  return aliases;
}

function resolveSessionAlias(sessionKey: string): string {
  return getSessionAliases().get(sessionKey) ?? sessionKey;
}

const CREATED_SESSION_TTL_MS = 24 * 60 * 60_000;
const CREATED_SESSION_MAX = 2_000;

function getCreatedSessions(): Map<string, { sessionId: string; createdAt: number }> {
  if (!globalThis.__deerhuxCreatedSessions) globalThis.__deerhuxCreatedSessions = new Map();
  const entries = globalThis.__deerhuxCreatedSessions;
  const now = Date.now();
  const cutoff = now - CREATED_SESSION_TTL_MS;
  for (const [key, value] of entries) {
    // 兼容 Next HMR 前旧模块留下的 Map<string,string>。
    if (typeof value === "string") entries.set(key, { sessionId: value, createdAt: now });
    else if (value.createdAt < cutoff) entries.delete(key);
  }
  while (entries.size > CREATED_SESSION_MAX) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
  return entries as Map<string, { sessionId: string; createdAt: number }>;
}

/** Resolve a stable new-session request id after its startup lock has settled. */
export function getCreatedSessionId(requestKey: string): string | undefined {
  const entries = getCreatedSessions();
  const found = entries.get(requestKey);
  if (!found) return undefined;
  // Map 插入序即 LRU 顺序；访问后移到末尾。
  entries.delete(requestKey);
  entries.set(requestKey, found);
  return found.sessionId;
}

function rememberCreatedSession(requestKey: string, sessionId: string): void {
  const entries = getCreatedSessions();
  entries.delete(requestKey);
  entries.set(requestKey, { sessionId, createdAt: Date.now() });
  while (entries.size > CREATED_SESSION_MAX) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
}

function getRegistrySession(sessionKey: string): AgentSessionWrapper | undefined {
  const registry = getRegistry();
  return registry.get(sessionKey) ?? registry.get(resolveSessionAlias(sessionKey));
}

function registerSessionAliases(realSessionId: string, wrapper: AgentSessionWrapper, aliases: readonly string[]): void {
  const registry = getRegistry();
  const aliasMap = getSessionAliases();
  registry.set(realSessionId, wrapper);
  for (const alias of aliases) {
    if (!alias || alias === realSessionId) continue;
    aliasMap.set(alias, realSessionId);
    registry.set(alias, wrapper);
  }
}

function unregisterSessionWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  for (const [key, value] of [...registry.entries()]) {
    if (value === wrapper) registry.delete(key);
  }
  const aliasMap = getSessionAliases();
  for (const [alias, realSessionId] of [...aliasMap.entries()]) {
    if (registry.get(realSessionId) === wrapper || realSessionId === wrapper.sessionId) aliasMap.delete(alias);
  }
}

function uniqueRegistrySessions(): AgentSessionWrapper[] {
  return [...new Set(getRegistry().values())].filter((session) => session.isAlive());
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__deerhuxStartLocks) globalThis.__deerhuxStartLocks = new Map();
  return globalThis.__deerhuxStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistrySession(sessionId);
}

export function getRpcRuntimeDiagnostics(): {
  wrappers: number;
  running: number;
  streaming: number;
  compacting: number;
  registryKeys: number;
  aliases: number;
  createdSessionKeys: number;
  startLocks: number;
  startReservations: number;
  maxWrappers: number;
} {
  const wrappers = uniqueRegistrySessions();
  const states = wrappers.map((session) => session.getStatus());
  return {
    wrappers: wrappers.length,
    running: states.filter((state) => state.isRunning).length,
    streaming: states.filter((state) => state.isStreaming).length,
    compacting: states.filter((state) => state.isCompacting).length,
    registryKeys: getRegistry().size,
    aliases: getSessionAliases().size,
    createdSessionKeys: getCreatedSessions().size,
    startLocks: getLocks().size,
    startReservations: globalThis.__deerhuxSessionStartReservations ?? 0,
    maxWrappers: MAX_REGISTRY_SESSIONS,
  };
}

export function listRpcSessionStates() {
  return uniqueRegistrySessions().map((session) => session.getStatus());
}

export function listRpcHostRunningSessions(updatedAt = Date.now()): HostRunningSession[] {
  return listRpcSessionStates()
    .filter((state) => state.isRunning || state.isCompacting)
    .map((state) => ({
      sessionId: state.sessionId,
      running: state.isRunning,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      lastEventType: state.lastEventType,
      eventCount: state.eventCount,
      eventRate: state.eventRate,
      eventIdleMs: state.eventIdleMs,
      contentIdleMs: state.contentIdleMs,
      updatedAt,
    }));
}

export function listRpcSessionTransientSnapshots(updatedAt = Date.now()): SessionTransientSnapshot[] {
  return uniqueRegistrySessions().map((session) => {
    const status = session.getStatus();
    const state = session.getTransientState();
    return {
      type: "session_transient_snapshot",
      sessionId: status.sessionId,
      running: status.isRunning,
      isStreaming: status.isStreaming,
      isCompacting: status.isCompacting,
      thinkingLevel: state.thinkingLevel,
      updatedAt,
    };
  });
}

export function reloadMcpForIdleSessions(): Promise<Array<{ sessionId: string; ok: boolean; skipped?: boolean; error?: string; toolNames?: string[] }>> {
  return Promise.all(uniqueRegistrySessions()
    .map(async (session) => {
      try {
        const result = await session.send({ type: "mcp_reload" }) as { ok?: boolean; skipped?: boolean; toolNames?: string[] };
        return { sessionId: session.sessionId, ok: result.ok === true, skipped: result.skipped, toolNames: result.toolNames };
      } catch (error) {
        return { sessionId: session.sessionId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), DeerHux generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
type StartRpcSessionOptions = {
  allowSubagentTool?: boolean;
  maxToolRounds?: number;
  requestKind?: LlmRequestKind;
};

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  roleId?: string | null,
  agentMode?: AgentMode | null,
  model?: { provider: string; modelId: string },
  options?: StartRpcSessionOptions,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const locks = getLocks();
  const lockKey = resolveSessionAlias(sessionId);

  const existing = getRegistrySession(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: existing.sessionId };

  const inflight = locks.get(lockKey) ?? locks.get(sessionId);
  if (inflight) return inflight;

  // 容量检查与启动预留必须在第一个 await 前原子完成，防止不同 session 的并发
  // cold-start 全部看到同一个旧 Registry 大小并穿透上限。
  if (!evictIdleSessionsIfNeeded()) {
    throw new SessionCapacityError(MAX_REGISTRY_SESSIONS);
  }
  globalThis.__deerhuxSessionStartReservations = (globalThis.__deerhuxSessionStartReservations ?? 0) + 1;

  const deerStarting = (async () => {
    const { session, realSessionId } = await startDeerLoopSession(
      sessionId, sessionFile, cwd, toolNames, roleId, agentMode, model, options,
    );
    if (!sessionFile && sessionId.startsWith("__new__")) {
      rememberCreatedSession(sessionId, realSessionId);
    }
    return { session, realSessionId };
  })().finally(() => {
    globalThis.__deerhuxSessionStartReservations = Math.max(0, (globalThis.__deerhuxSessionStartReservations ?? 1) - 1);
    locks.delete(lockKey);
    locks.delete(sessionId);
  });
  locks.set(lockKey, deerStarting);
  if (lockKey !== sessionId) locks.set(sessionId, deerStarting);
  return deerStarting;
}

// ===========================================================================
// ★ M6+：自研 DeerLoopEngine 创建路径（默认，不再灰度）
//
// 取代 pi 的 createAgentSession：用 DeerLoopEngine + ToolRegistry + ToolExecutor 管理
// 整个 agent loop，pi-ai 只做 LLM 传输。注册与 pi 路径等价的真实工具集（code_search /
// codegraph / mcp / subagent），支持角色/模式 prompt 注入，通过 SessionPort 做
// JSONL 持久化。
// ===========================================================================

/**
 * 创建 DeerLoopEngine，注册真实工具，包装成 AgentSessionWrapper，注册到 registry。
 *
 * @param sessionId 前端请求的会话 id
 * @param sessionFile 已有 jsonl 文件路径（fork/navigateTree/恢复时传入）
 * @param cwd 工作目录
 * @param toolNames 激活工具名（undefined=全部可用；[]=纯文本；[...]=指定集）
 * @param roleId 角色 id（null=无角色；undefined=由前端透传决定）
 * @param agentMode AgentMode（null=无模式；undefined=默认）
 */
async function startDeerLoopSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  roleId?: string | null,
  agentMode?: AgentMode | null,
  modelOverride?: { provider: string; modelId: string },
  options?: StartRpcSessionOptions,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const composed = await composeDeerLoopEngine({
    sessionId,
    sessionFile,
    cwd,
    toolNames,
    agentMode,
    modelOverride,
    allowSubagentTool: options?.allowSubagentTool,
    maxToolRounds: options?.maxToolRounds,
    requestKind: options?.requestKind,
  });
  const { engine, sessionPort, modelCatalog, projectResources, realSessionId, realSessionFile, mcpRuntimeLease, explicitMode } = composed;

  try {
    const wrapper = new AgentSessionWrapper(
      engine, sessionPort, modelCatalog, projectResources, roleId, mcpRuntimeLease, explicitMode,
      options?.requestKind === "subagent" ? "subagent" : "main",
    );
    wrapper.start();

    const sessionAliases = sessionId && sessionId !== realSessionId ? [sessionId] : [];
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile, sessionAliases);
    if (!sessionFile) forceRefreshSessionList();

    wrapper.onDestroy(() => unregisterSessionWrapper(wrapper));
    registerSessionAliases(realSessionId, wrapper, sessionAliases);
    return { session: wrapper, realSessionId };
  } catch (error) {
    mcpRuntimeLease?.release();
    engine.dispose();
    throw error;
  }
}
