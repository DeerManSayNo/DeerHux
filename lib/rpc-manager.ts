import path from "path";
import { existsSync, readFileSync } from "fs";
import {
  buildSessionContext,
  DefaultResourceLoader,
  defineTool,
  formatSkillsForPrompt,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Message as PiMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { cacheSessionPath, forceRefreshSessionList } from "./session-reader";
import type { ToolInfo } from "./deerhux-types";
import type { AgentEnginePort } from "./engine/port";
import { DeerLoopEngine } from "./engine/deer-loop";
import type { AnyToolDefinition } from "./engine/tool-registry";
import { classifyLlmError } from "./llm-gateway";
import type { LlmRequestKind } from "./llm-gateway";
import { getLiveIslandClient } from "./live-island-client";
import { applyRolePromptToSystemPrompt } from "./roles";
import { applyRolePromptConfigToPrompt, isRoleSystemPromptSectionEnabled, readRoleSystemPromptConfig } from "./system-prompt-decomposer";
import { indexExists } from "./code-index/database";
import { searchIndex } from "./code-index/search";
import { createCodeGraphTools } from "./codegraph/tools";
import { createStandardCodingTools, STANDARD_CODING_TOOL_NAMES } from "./engine/coding-tools";
import { createSubagentTool, SUBAGENT_TOOL_NAME } from "./parallel-agent/subagent-tool";
import { getAgentEventStore } from "./agent-runtime/event-store";
import type { FileReference, ImageContent, SkillReference, TextContent } from "./types";
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

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

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
}

interface BaseSystemPromptResources {
  cwd: string;
  customPrompt?: string;
  appendSystemPrompt?: string[];
  contextFiles?: Array<{ path: string; content: string }>;
  formattedSkills?: string;
  now?: Date;
}

/**
 * Assemble the stable, resource-backed portion of the prompt. Role, mode and
 * live tool sections are intentionally applied later by AgentSessionWrapper;
 * selected skill contents remain a per-turn layer.
 */
function composeBaseSystemPrompt(resources: BaseSystemPromptResources): string {
  const basePrompt = resources.customPrompt?.trim() || [
    "You are an expert coding assistant operating inside DeerHux, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
    "Available tools:\n(none)",
    "Guidelines:\n- Be concise in your responses\n- Show file paths clearly when working with files",
  ].join("\n\n");
  const parts = [basePrompt];

  const appendPrompt = resources.appendSystemPrompt
    ?.map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n");
  if (appendPrompt) parts.push(appendPrompt);

  if (resources.contextFiles?.length) {
    const context = resources.contextFiles
      .map(({ path: filePath, content }) => (
        `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`
      ))
      .join("\n\n");
    parts.push(`<project_context>\n\nProject-specific instructions and guidelines:\n\n${context}\n\n</project_context>`);
  }

  if (resources.formattedSkills?.trim()) {
    parts.push(resources.formattedSkills.trim());
  }

  const now = resources.now ?? new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  parts.push(`Current date: ${date}\nCurrent working directory: ${resources.cwd.replace(/\\/g, "/")}`);
  return parts.join("\n\n");
}

async function loadBaseSystemPrompt(cwd: string, includeSkills: boolean): Promise<string> {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
  await loader.reload();
  const skills = includeSkills ? loader.getSkills().skills : [];
  return composeBaseSystemPrompt({
    cwd,
    customPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: loader.getAppendSystemPrompt(),
    contextFiles: loader.getAgentsFiles().agentsFiles,
    formattedSkills: skills.length ? formatSkillsForPrompt(skills) : undefined,
  });
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
  return typeof current === "string" && current.trim() ? current.trim() : null;
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
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}

const TURN_CONTEXT_BLOCK_RE = /\n*<turn_context>[\s\S]*?<\/turn_context>\s*/g;

/**
 * Remove any `<turn_context>…</turn_context>` blocks left over from a previous
 * turn. The per-turn context block is appended to the system prompt by
 * `withTemporarySystemPrompt` and must never leak into `baseSystemPrompt` —
 * otherwise the first turn's context (references/skill/mode) would be frozen
 * into every subsequent turn. Call this whenever we capture the system prompt
 * back from `agent.state` (where the SDK may still hold a turn-specific value)
 * into our own `baseSystemPrompt`.
 */
function stripTurnContextBlock(prompt: string): string {
  return prompt.replace(TURN_CONTEXT_BLOCK_RE, "").trimEnd();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const FULL_PRESET_MARKERS = ["bash", "edit", "write", "grep", "find", "ls"];

function isFullToolPreset(toolNames: string[]): boolean {
  return FULL_PRESET_MARKERS.every((name) => toolNames.includes(name));
}

function includesMcpTool(toolNames: string[]): boolean {
  return toolNames.some((name) => name.startsWith("mcp__"));
}

const TOOLS_SECTION_RE = /(^|\n)Available tools:\n[\s\S]*?(?=\n\n(?:In addition to the tools above|Guidelines:|<deerhux_mode>|<project_context>|<available_skills>|MCP runtime tools:|Current date:|<!-- PI_ROLE|# Global Memory)|$)/;
const TOOL_SECTION_INSERT_MARKERS = [
  "\n\nGuidelines:",
  "\n\n<deerhux_mode>",
  "\n\n<project_context>",
  "\n\n<available_skills>",
  "\n\nMCP runtime tools:",
  "\n\nCurrent date:",
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
  private sawAssistantEventInTurn = false;
  /** When true, the subagent tool is kept in the active tool set. */
  private _subagentEnabled = false;

  constructor(public readonly inner: AgentEnginePort, roleId?: string | null, private mcpRuntimeLease?: McpRuntimeLease | null, agentMode?: AgentMode | null) {
    this.roleId = roleId ?? null;
    this.agentMode = normalizeAgentMode(agentMode);
    this.modePromptEnabled = agentMode !== undefined && agentMode !== null;
    this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(inner.agent.state?.systemPrompt ?? ""));
    this.applyRolePrompt();
  }

  private get mcpRuntime(): McpRuntime | null {
    return this.mcpRuntimeLease?.runtime ?? null;
  }

  private syncRoleMcpActiveTools(): void {
    const allMcpToolNames = this.mcpRuntime?.toolNames ?? [];
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
    if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
  }

  /** Keep subagent in (or out of) the active tool set based on the toggle. */
  private applySubagentToActiveTools(): void {
    const all = this.inner.getAllTools();
    if (!all.some((t) => t.name === SUBAGENT_TOOL_NAME)) return; // tool not registered for this session
    const current = this.inner.getActiveToolNames();
    if (this._subagentEnabled) {
      if (!current.includes(SUBAGENT_TOOL_NAME)) {
        this.inner.setActiveToolsByName([...current, SUBAGENT_TOOL_NAME]);
      }
    } else if (current.includes(SUBAGENT_TOOL_NAME)) {
      this.inner.setActiveToolsByName(current.filter((name) => name !== SUBAGENT_TOOL_NAME));
    }
  }

  /**
   * ★ R13 加固：外层加 try/catch，失败时至少恢复到 this.baseSystemPrompt
   * （不带 role/mode 修饰），防止 role 配置损坏导致 system prompt 污染所有后续 turn。
   *
   * 注意：内部恢复 baseSystemPrompt 失败后会重新 throw，让调用方
   * （如 withTemporarySystemPrompt）的快照安全网有机会介入。
   */
  private applyRolePrompt(): void {
    try {
      if (!this.inner.agent.state) return;
      const savedActiveTools = this.inner.getActiveToolNames(); // ★ R13 发现6：保存旧 active tools，异常时回滚
      try {
        this.syncRoleMcpActiveTools();
      } catch (syncErr) {
        // syncRoleMcp 失败不中断整个 applyRolePrompt，MCP 工具保持旧状态即可
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
        ? applyRolePromptToSystemPrompt(promptWithMode, this.roleId, this.temporaryRoleSettings, this.inner.sessionManager.getCwd())
        : promptWithMode;
      this.inner.setSystemPromptPersistent(nextPrompt);
    } catch (err) {
      console.error("applyRolePrompt failed, restoring to bare baseSystemPrompt:", err);
      try {
        this.inner.setSystemPromptPersistent(this.baseSystemPrompt);
      } catch (err2) {
        console.error("Failed to restore bare baseSystemPrompt:", err2);
        // ★ R13 发现5（严重修复）：内部恢复也失败 → 重新 throw，
        // 让 withTemporarySystemPrompt 的快照恢复安全网介入
        throw err2;
      }
    }
  }

  private persistAgentMode(): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    try {
      this.inner.sessionManager.appendCustomEntry("agent_mode", { mode: this.agentMode });
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
    if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
    this.applyRolePrompt();
    if (persist) this.persistAgentMode();
  }

  private appendDisplayUserMessage(content: unknown, references: FileReference[], skill?: SkillReference, clientMessageId?: string, turnId?: string): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    // This entry is the durable prompt-admission receipt. Do not silently ignore
    // persistence failures: without it a timed-out client cannot safely determine
    // whether retrying the prompt would execute tools twice.
    this.inner.sessionManager.appendCustomEntry("display_user_message", {
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
    for (const entry of this.inner.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "display_user_message") continue;
      const data = entry.data as { clientMessageId?: unknown; turnId?: unknown } | undefined;
      if (data?.clientMessageId !== clientMessageId) continue;
      return { turnId: typeof data.turnId === "string" ? data.turnId : undefined };
    }
    return null;
  }

  private appendTurnContextMetadata(references: FileReference[], skill?: SkillReference): void {
    if (!this.inner.sessionManager.isPersisted()) return;
    try {
      this.inner.sessionManager.appendCustomEntry("turn_context", {
        mode: this.agentMode,
        ...(references.length ? { references } : {}),
        ...(skill ? { skill } : {}),
      });
    } catch { /* best effort: only affects UI metadata */ }
  }

  private async resolveSkillInvocation(name: string | undefined): Promise<SkillInvocation | undefined> {
    const skillName = name?.trim();
    if (!skillName) return undefined;
    const cwd = this.inner.sessionManager.getCwd();
    try {
      const { DefaultResourceLoader, getAgentDir } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const skill = loader.getSkills().skills.find((item: { name?: string }) => item.name === skillName);
      const filePath = (skill as { filePath?: unknown } | undefined)?.filePath;
      if (typeof filePath === "string" && existsSync(filePath)) {
        return { name: skillName, content: readFileSync(filePath, "utf8") };
      }
    } catch { /* fall through to DeerHux builtins */ }

    const builtinPath = path.join(process.cwd(), "lib", "builtin-skills", skillName, "SKILL.md");
    if (existsSync(builtinPath)) {
      return { name: skillName, content: readFileSync(builtinPath, "utf8") };
    }
    return { name: skillName };
  }

  private buildTurnSystemPromptBlock(ctx: { references: FileReference[]; skill?: SkillInvocation }): string {
    const lines = ["<turn_context>"];
    lines.push(`Current turn mode: ${this.agentMode}`);
    if (ctx.references.length > 0) {
      lines.push("");
      lines.push("User-selected references for this turn:");
      lines.push("Use these files or folders only if the user's request requires them. Do not summarize or analyze them just because they are listed.");
      for (const ref of ctx.references) lines.push(`- ${escapeTurnContextText(ref.path)}`);
    }
    if (ctx.skill) {
      lines.push("");
      lines.push(`Selected skill for this turn: ${ctx.skill.name}`);
      if (ctx.skill.content?.trim()) {
        lines.push("<selected_skill>");
        lines.push(ctx.skill.content.trim());
        lines.push("</selected_skill>");
      } else {
        lines.push("The selected skill content could not be loaded; proceed using the skill name as metadata only.");
      }
    }
    lines.push("</turn_context>");
    return lines.join("\n");
  }

  private async prepareTurnContext(rawMessage: string, rawReferences: unknown, rawSkillName: unknown): Promise<PreparedTurnContext> {
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
      systemPromptBlock: this.buildTurnSystemPromptBlock({ references, skill: skillInvocation }),
    };
  }

  private withTemporarySystemPrompt<T>(turnPromptBlock: string, run: () => Promise<T>): Promise<T> {
    // Strip any stale <turn_context> block that may have been baked into the
    // state by a previous turn (e.g. after a tool-set change during the turn
    // re-synced baseSystemPrompt from agent.state). This guarantees each turn
    // is assembled from the *current* role/mode config plus this turn's block,
    // so the model always sees the freshly-assembled prompt instead of the
    // very first turn's frozen context.
    //
    // ★ R13 快照恢复：在应用临时 prompt 前保存完整快照，finally 中优先尝试
    //    applyRolePrompt() 正常恢复；失败则用快照直接覆盖；再失败回退到裸 baseSystemPrompt。
    //    防止 applyRolePrompt() 内部抛异常（如 role 配置损坏）导致 system prompt
    //    永远停留在带 <turn_context> 的临时状态。
    const savedSystemPrompt = this.inner.agent.state?.systemPrompt ?? "";
    const savedBaseSystemPrompt = this.baseSystemPrompt;

    const currentPrompt = stripTurnContextBlock(this.inner.agent.state?.systemPrompt ?? "");
    const nextPrompt = turnPromptBlock.trim() ? `${currentPrompt}\n\n${turnPromptBlock.trim()}` : currentPrompt;
    if (turnPromptBlock.trim()) this.inner.setSystemPromptPersistent(nextPrompt);
    return run().finally(() => {
      try {
        this.applyRolePrompt();
      } catch (err) {
        console.error("Failed to restore system prompt via applyRolePrompt, falling back to snapshot:", err);
        // 快照恢复
        this.baseSystemPrompt = savedBaseSystemPrompt;
        try {
          this.inner.setSystemPromptPersistent(savedSystemPrompt);
        } catch (err2) {
          console.error("Failed to restore system prompt via snapshot fallback, using bare baseSystemPrompt:", err2);
          // 最终回退：裸 baseSystemPrompt（不带 role/mode 修饰）
          try {
            this.inner.setSystemPromptPersistent(this.baseSystemPrompt);
          } catch (err3) {
            console.error("Failed to restore even bare system prompt:", err3);
          }
        }
      }
    });
  }

  private setRole(roleId: string | null, persist = true): void {
    const normalized = roleId?.trim() || null;
    const changed = this.roleId !== normalized;
    this.roleId = normalized;
    this.applyRolePrompt();
    if (persist && changed && this.inner.sessionManager.isPersisted()) {
      try {
        this.inner.sessionManager.appendCustomEntry("role_profile", { roleId: this.roleId });
      } catch { /* best effort */ }
    }
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  private appendRuntimeAudit(customType: "auto_retry" | "abort" | "recover", data: Record<string, unknown>): void {
    try {
      this.inner.appendCustomEntry?.(customType, data);
    } catch (error) {
      // 审计记录不能阻断正常的重试 / 中止 / 恢复控制流。
      console.warn(`Failed to persist ${customType} audit entry`, error);
    }
  }

  start(): void {
    if (this.unsubscribe) return;

    const liveIsland = getLiveIslandClient();
    const cwd = this.inner.sessionManager.getCwd();
    liveIsland.trackSession(this.inner.sessionId, cwd);

    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      // ★ R7 审查修复：防止在 destroy() → unsubscribe() 窗口期间，
      // 已销毁 session 的 SDK 回调继续触发副作用
      if (!this._alive) return;

      const turnKey = this.currentTurnKey;
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
      const tagged = turnKey ? { ...event, turnId: turnKey } as AgentEvent : event;
      getAgentEventStore().append({
        sessionId: this.inner.sessionId,
        runId: this.inner.sessionId,
        ...(turnKey ? { turnId: turnKey } : {}),
        event,
      });
      this.recordEventStatus(event);
      this.touch();
      for (const l of this.listeners) l(tagged);

      // Forward to AIControls Live Island
      const currentCwd = this.inner.sessionManager.getCwd();
      liveIsland.handleEvent(this.inner.sessionId, currentCwd, event);

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
          const fileChangedEvent: AgentEvent = { type: "agent_file_changed", filePath: resolved, toolName: extractToolName(sourceEvent) };
          getAgentEventStore().append({
            sessionId: this.inner.sessionId,
            runId: this.inner.sessionId,
            ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
            event: fileChangedEvent,
          });
          for (const l of this.listeners) l(turnKey ? { ...fileChangedEvent, turnId: turnKey } as AgentEvent : fileChangedEvent);
        }
      }
    });
    this.startIdlePulse();
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

  private recordEventStatus(event: AgentEvent): void {
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
      const ev: AgentEvent = { type: "agent_end", messages: [], willRetry: false, error: msg };
      if (errorCode && errorCode !== "UNKNOWN") ev.errorCode = errorCode;
      getAgentEventStore().append({
        sessionId: this.inner.sessionId,
        runId: this.inner.sessionId,
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
          `session=${this.inner.sessionId}`,
          `lastEventType=${this.lastEventType || "unknown"}`,
          `eventCount=${this.eventCount}`,
        ].join("；");
        const ev: AgentEvent = { type: "agent_end", messages: [], willRetry: false, error };
        getAgentEventStore().append({
          sessionId: this.inner.sessionId,
          runId: this.inner.sessionId,
          ...(this.currentTurnKey ? { turnId: this.currentTurnKey } : {}),
          event: ev,
        });
        for (const l of this.listeners) l(ev);
      }
    });
  }

  private async waitForCurrentTurnToStop(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while ((this._isRunning || this.inner.isStreaming) && Date.now() - start < timeoutMs) {
      await sleepMs(50);
    }
  }

  private async abortAndSettleCurrentTurn(): Promise<void> {
    const turnPromise = this.activeTurnPromise;
    const turnId = this.activeTurnId;

    await this.inner.abort();
    await this.waitForCurrentTurnToStop(8_000);

    // 8s 后仍在跑 —— turn 卡死，拒绝继续，避免与新 turn 竞争 SDK 状态
    if (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
      throw new Error("abort timeout: current turn did not settle within 8s");
    }

    if (turnPromise && this.activeTurnId === turnId) {
      await Promise.race([
        turnPromise.catch(() => {}),
        sleepMs(2_000),
      ]);
    }
  }

  private installMcpRuntime(nextRuntime: McpRuntime, activateMcp: boolean): void {
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const nextMcpToolNames = new Set(nextRuntime.toolNames);
    const activeBefore = this.inner.getActiveToolNames();

    const nextActiveToolNames = activeBefore.filter((name) => !previousMcpToolNames.has(name) && !name.startsWith("mcp__"));
    if (activateMcp) nextActiveToolNames.push(...nextMcpToolNames);

    // H9：运行时热替换自定义工具。对 pi 私有字段（_customTools / _allowedToolNames /
    // _refreshToolRegistry）的直接操作已收敛到 AgentEnginePort.replaceCustomTools。
    // 这里只保留“保留哪些工具 / 激活哪些”的编排决策。
    this.inner.replaceCustomTools({
      removeNames: [...previousMcpToolNames],
      addTools: nextRuntime.tools,
      extraAllowedNames: [...nextMcpToolNames],
      activeToolNames: nextActiveToolNames,
    });
    this.inner.applyToolExecutionModes();

    if (this.inner.agent.state) {
      this.baseSystemPrompt = stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? "");
    }
    this.applyRolePrompt();
  }

  private async ensureMcpRuntimeLoaded(activateMcp = false): Promise<McpRuntime | null> {
    if (this.mcpRuntime) {
      if (activateMcp) this.installMcpRuntime(this.mcpRuntime, true);
      return this.mcpRuntime;
    }

    const cwd = this.inner.sessionManager.getCwd();
    const { acquireMcpRuntime } = await import("./mcp-runtime");
    const lease = await acquireMcpRuntime(cwd);
    try {
      this.installMcpRuntime(lease.runtime, activateMcp);
      this.mcpRuntimeLease = lease;
      return lease.runtime;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private async prepareImageFallback(
    message: string,
    images?: RuntimeImage[],
    displayMessage = message,
  ): Promise<{ message: string; images?: RuntimeImage[]; displayContent?: DisplayUserContent }> {
    if (!images?.length) return { message, images };

    // Resolve filePath → base64 data for images that are stored on disk.
    // This keeps session files lean (only file references) while still
    // sending actual image data to the model API when needed.
    const fs = await import("fs");
    const resolvedImages = await Promise.all(images.map(async (img) => {
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

    const displayContent = buildDisplayUserContent(displayMessage, resolvedImages);
    const supportsImageInput = (this.inner.model as { input?: string[] } | null | undefined)?.input?.includes("image") ?? false;
    if (supportsImageInput) return { message, images: resolvedImages, displayContent };

    const mcpRuntime = await this.ensureMcpRuntimeLoaded(false).catch(() => null);
    if (mcpRuntime) {
      const sdkFallbackImages = toSdkImages(resolvedImages);
      if (sdkFallbackImages?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawDescriptions = await mcpRuntime.describeImages(sdkFallbackImages as any, message).catch(() => [] as string[]);
        // Filter out error lines — keep only actual image descriptions.
        const validDescriptions = rawDescriptions.filter(
          (text) => !text.startsWith("MCP 图片识别失败") && !/^图片 \d+ 识别失败/.test(text),
        );
        if (validDescriptions.length > 0) {
          const imageContext = validDescriptions
            .map((text, index) => `图片 ${index + 1}:\n${text}`)
            .join("\n\n");
          return {
            message: `${message}\n\n<image_context source="mcp-vision-fallback">\n${imageContext}\n</image_context>\n\n注意：当前模型配置未勾选图片输入，上面的 image_context 是由 MCP 图片识别服务生成的，请基于该内容回答用户。`,
            images: undefined,
            displayContent,
          };
        }
      }
    }

    // No usable MCP vision fallback — just return the message without images.
    return { message, images: undefined, displayContent };
  }

  private async reloadMcpRuntime(): Promise<{ ok: boolean; skipped?: boolean; toolNames?: string[]; serverStatuses?: McpRuntime["serverStatuses"] }> {
    if (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
      return { ok: false, skipped: true };
    }

    const cwd = this.inner.sessionManager.getCwd();
    const { createMcpRuntime } = await import("./mcp-runtime");
    const nextRuntime = await createMcpRuntime(cwd);
    const previousRuntime = this.mcpRuntime;
    const previousMcpToolNames = new Set(previousRuntime?.toolNames ?? []);
    const activeBefore = this.inner.getActiveToolNames();
    const hadActiveMcp = activeBefore.some((name) => previousMcpToolNames.has(name) || name.startsWith("mcp__"));
    const isFullPreset = isFullToolPreset(activeBefore);

    try {
      this.installMcpRuntime(nextRuntime, hadActiveMcp || isFullPreset);
    } catch (error) {
      nextRuntime.close();
      throw error;
    }

    this.mcpRuntimeLease?.release();
    this.mcpRuntimeLease = { runtime: nextRuntime, release: () => nextRuntime.close() };

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
    signal?: AbortSignal,
    roleId?: string,
  ): Promise<{ turnId: string }> {
    const turnNum = ++this.activeTurnId;
    const turnKey = `${this.inner.sessionId}:t${turnNum}`;
    this.currentTurnKey = turnKey;
    const turnContext = await this.prepareTurnContext(rawMessage, references, skillName);
    signal?.throwIfAborted();
    if (turnContext.displayMessage) {
      getLiveIslandClient().recordPrompt(this.inner.sessionId, turnContext.displayMessage);
    }
    const prepared = await this.prepareImageFallback(turnContext.message, images, turnContext.displayMessage);
    signal?.throwIfAborted();
    if (roleId) this.setRole(roleId);

    const displayUserContent = prepared.displayContent ?? turnContext.displayMessage;
    const userEchoEvent = {
      type: "message_end",
      message: {
        role: "user",
        content: displayUserContent,
        ...(turnContext.references.length ? { references: turnContext.references } : {}),
        ...(turnContext.skill ? { skill: turnContext.skill } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        agentMode: this.agentMode,
        timestamp: Date.now(),
      },
    } as AgentEvent;
    // Mirror the synthetic user echo into the EventStore so pure-SSE
    // clients (e.g. WeChat bot) can replay it after reconnect — matches
    // how agent_file_changed is committed below.
    getAgentEventStore().append({
      sessionId: this.inner.sessionId,
      runId: this.inner.sessionId,
      ...(turnKey ? { turnId: turnKey } : {}),
      event: userEchoEvent,
    });
    for (const l of this.listeners) {
      l(turnKey ? { ...userEchoEvent, turnId: turnKey } as AgentEvent : userEchoEvent);
    }

    this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
    this.appendDisplayUserMessage(displayUserContent, turnContext.references, turnContext.skill, clientMessageId, turnKey);
    this.trackTurn(turnNum, this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
      this.inner.prompt(prepared.message, toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : undefined)
    )));
    return { turnId: turnKey };
  }

  /** 内部准入保护：允许比实际回合状态更保守，防止旧清理与新 prompt 竞争。 */
  private isTurnBusy(): boolean {
    // isCompacting：自动压缩在 `_isRunning`/stream 之前就会占用回合；漏计会导致
    // abort 认为已空闲、stopRequested 立刻被清掉，UI 卡在「正在压缩上下文…」。
    return Boolean(
      this.pendingPromptController
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
        if (this.isTurnBusy() || this._stopRequested) {
          throw new Error("AGENT_BUSY: 当前会话仍有回合运行或正在停止，请等待回合结束后重试");
        }
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
        const promptRoleId = typeof command.roleId === "string" ? command.roleId : undefined;
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
            admissionController.signal,
            promptRoleId,
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
        return { roleId: this.roleId, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "set_system_prompt": {
        const rawPrompt = typeof command.prompt === "string" ? command.prompt : "";
        if (this.inner.agent.state) {
          this.baseSystemPrompt = stripModePrompt(rawPrompt);
          this.inner.setSystemPromptPersistent(rawPrompt);
        }
        this.applyRolePrompt();
        return {
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
        };
      }

      case "add_temporary_role_setting": {
        const text = typeof command.text === "string" ? command.text.trim() : "";
        if (text) this.temporaryRoleSettings.push(text);
        this.applyRolePrompt();
        return { ok: true, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
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
        this.pendingPromptController?.abort(new DOMException("Stop requested", "AbortError"));
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
        // Atomic abort-and-continue: settle the old turn, optionally switch
        // model, then start a fresh prompt turn. Replaces the frontend's
        // manual abort + while-wait + sleep(150) + follow_up choreography.
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
          // 先切模型：失败时旧 turn 还活着，session 状态完全不变，前端可安全重试
          const provider = typeof command.provider === "string" ? command.provider.trim() : undefined;
          const modelId = typeof command.modelId === "string" ? command.modelId.trim() : undefined;
          let modelChanged = false;
          if (provider && modelId) {
            const registry = this.inner.modelRegistry;
            let model = registry.find(provider, modelId);
            if (!model) {
              const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
              model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
            }
            if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
            await this.inner.setModel(model);
            modelChanged = true;
          }

          // 模型就绪后再 abort + settle + 开新 turn
          await this.abortAndSettleCurrentTurn();

          const recoverText = typeof command.message === "string" ? command.message : "";
          const recoverImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const recoverClientMessageId = typeof command.clientMessageId === "string" && command.clientMessageId.trim()
            ? command.clientMessageId.trim()
            : undefined;
          const recoverTurn = await this.commitAndTrackPromptTurn(recoverText, command.references, command.skillName, recoverImages, recoverClientMessageId);
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
        }
      }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
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
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          agentMode: this.agentMode,
          isRunning: this.isTurnRunningForUi(),
          stopRequested: this._stopRequested,
          mcp: this.mcpRuntime ? {
            toolNames: this.mcpRuntime.toolNames,
            serverStatuses: this.mcpRuntime.serverStatuses,
          } : null,
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const registry = this.inner.modelRegistry;
        let model = registry.find(provider, modelId);

        // Existing AgentSession instances keep the ModelRegistry they were
        // created with. If ~/.deerhux/agent/models.json was edited while this
        // wrapper is alive, the UI may already show the new model (loaded via
        // /api/models) but the stale in-memory registry cannot find it. Try a
        // fresh registry before failing so newly-saved models are selectable
        // without restarting the app/session.
        if (!model) {
          const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
          model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
        }

        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        forceRefreshSessionList();
        this.destroy();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        return null;
      }

      case "compact": {
        const provider = typeof command.provider === "string" ? command.provider : undefined;
        const modelId = typeof command.modelId === "string" ? command.modelId : undefined;
        let summaryModel: ReturnType<typeof this.inner.modelRegistry.find> | undefined;
        if (provider && modelId) {
          summaryModel = this.inner.modelRegistry.find(provider, modelId);
          // 与 set_model 一致：热更新过的 models.json 可能尚未进入当前 registry。
          if (!summaryModel) {
            const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
            summaryModel = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
          }
          if (!summaryModel) throw new Error(`压缩模型不存在: ${provider}/${modelId}`);
        }
        const abortOnDisconnect = () => this.inner.abortCompaction();
        requestSignal?.addEventListener("abort", abortOnDisconnect, { once: true });
        try {
          return await this.inner.compact(
            command.customInstructions as string | undefined,
            "manual",
            summaryModel ? { model: summaryModel as never, provider, modelId } : undefined,
          );
        } finally {
          requestSignal?.removeEventListener("abort", abortOnDisconnect);
        }
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const steerText = typeof command.message === "string" ? command.message : "";
        const turnContext = await this.prepareTurnContext(steerText, command.references, command.skillName);
        const prepared = await this.prepareImageFallback(turnContext.message, steerImages, turnContext.displayMessage);
        this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
        this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
        await this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
          this.inner.steer(prepared.message, toSdkImages(prepared.images))
        ));
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const followText = typeof command.message === "string" ? command.message : "";
        const turnContext = await this.prepareTurnContext(followText, command.references, command.skillName);
        const prepared = await this.prepareImageFallback(turnContext.message, followImages, turnContext.displayMessage);
        this.appendTurnContextMetadata(turnContext.references, turnContext.skill);
        this.appendDisplayUserMessage(prepared.displayContent ?? turnContext.displayMessage, turnContext.references, turnContext.skill);
        const imageOptions = toSdkImages(prepared.images) ? { images: toSdkImages(prepared.images)! } : undefined;
        const message = prepared.message;

        if (this._isRunning || this.inner.isStreaming) {
          // SDK followUp only queues for an already-active turn. It should be
          // sent while the turn is still active so the agent can drain it.
          await this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
            this.inner.followUp(message, toSdkImages(prepared.images))
          ));
          return null;
        }

        // If the previous turn was already aborted/stopped, followUp would only
        // sit in the queue and never trigger a model call. Start a fresh turn.
        const followTurnNum = ++this.activeTurnId;
        this.currentTurnKey = `${this.inner.sessionId}:t${followTurnNum}`;
        this.trackTurn(followTurnNum, this.withTemporarySystemPrompt(turnContext.systemPromptBlock, () => (
          this.inner.prompt(message, imageOptions)
        )));
        return null;
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
        const requested = Array.isArray(command.toolNames) ? command.toolNames.filter((name): name is string => typeof name === "string") : [];
        if (isReadOnlyAgentMode(this.agentMode)) {
          this.inner.setActiveToolsByName(getToolNamesForAgentMode(this.agentMode));
          if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
          this.applyRolePrompt();
          return null;
        }
        const isFullPreset = isFullToolPreset(requested);
        if (isFullPreset || includesMcpTool(requested)) {
          await this.ensureMcpRuntimeLoaded(true);
        }
        const toolNames = isFullPreset
          ? [...new Set([...requested, ...(this.mcpRuntime?.toolNames ?? [])])]
          : requested;
        this.inner.setActiveToolsByName(toolNames);
        this.applySubagentToActiveTools();
        if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
        this.applyRolePrompt();
        return null;
      }

      case "set_subagent_enabled": {
        this._subagentEnabled = command.enabled === true;
        this.applySubagentToActiveTools();
        if (this.inner.agent.state) this.baseSystemPrompt = stripModePrompt(stripTurnContextBlock(this.inner.agent.state.systemPrompt ?? ""));
        this.applyRolePrompt();
        return { enabled: this._subagentEnabled };
      }

      case "get_mode": {
        return { mode: this.agentMode, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
      }

      case "set_mode": {
        const nextMode = normalizeAgentMode(command.mode);
        await this.setAgentMode(nextMode);
        return { mode: this.agentMode, systemPrompt: this.inner.agent.state?.systemPrompt ?? "" };
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
    this._alive = false;
    this.pendingPromptController?.abort(new DOMException("Session destroyed", "AbortError"));
    this.pendingPromptController = null;
    this._stopRequested = true;
    if (this.idlePulseInterval) { clearInterval(this.idlePulseInterval); this.idlePulseInterval = null; }
    this.unsubscribe?.();
    // 活跃回合被销毁时必须向 Journal 写入终态；空闲 wrapper 回收不是业务回合结束。
    if (hadActiveTurn) {
      const destroyEvent: AgentEvent = {
        type: "agent_end",
        messages: [],
        willRetry: false,
        error: `Agent 会话在回合尚未结束时被销毁（session=${this.inner.sessionId}，lastEventType=${this.lastEventType || "unknown"}，eventIdleMs=${this.lastEventAt ? Date.now() - this.lastEventAt : "unknown"}）。`,
      };
      // SSE consumers subscribe to EventStore rather than wrapper.listeners.
      getAgentEventStore().append({
        sessionId: this.inner.sessionId,
        runId: this.inner.sessionId,
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
    // 先捕获 MCP lease 引用并置空实例字段，再在 abort 完成后再释放，
    // 避免 abort 异步等待期间 MCP runtime 被提前关闭导致工具调用抛连接错误。
    const mcpLease = this.mcpRuntimeLease;
    this.mcpRuntimeLease = null;
    this.inner.abort()
      .catch(() => {})
      .finally(() => {
        mcpLease?.release();
        this.inner.dispose();
      })
      .catch(() => {}); // 防御性 catch：dispose 未来若抛异常，避免 unhandled rejection
    // 清理 EventStore 中该 session 的事件桶，避免长期运行后内存持续增长。
    // fork / idle-timeout / DELETE 都会走到这里，确保 session 销毁时释放事件缓存。
    getAgentEventStore().clearRun(this.inner.sessionId);
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __deerhuxSessions: Map<string, AgentSessionWrapper> | undefined;
  var __deerhuxSessionAliases: Map<string, string> | undefined;
  /** Stable new-session request id → real session id. Kept after wrapper eviction. */
  var __deerhuxCreatedSessions: Map<string, string> | undefined;
  var __deerhuxStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__deerhuxSessions) {
    globalThis.__deerhuxSessions = new Map();
    const cleanup = () => globalThis.__deerhuxSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__deerhuxSessions;
}

// ★ Security/reliability: hard cap on concurrent in-process sessions to prevent
// unbounded memory growth under fork storms or high concurrency.
const MAX_REGISTRY_SESSIONS = 64;

function evictIdleSessionsIfNeeded(): void {
  const alive = uniqueRegistrySessions();
  if (alive.length < MAX_REGISTRY_SESSIONS) return;

  // Find the session with the longest idle time that is NOT actively streaming
  // or compacting — never evict a session mid-turn.
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

  if (victim) {
    console.warn(
      `[rpc-manager] Registry at capacity (${alive.length}/${MAX_REGISTRY_SESSIONS}), evicting idle session ${victim.sessionId}`,
    );
    victim.destroy();
  } else {
    console.warn(
      `[rpc-manager] Registry at capacity (${alive.length}/${MAX_REGISTRY_SESSIONS}); all sessions active, skipping eviction`,
    );
  }
}

function getSessionAliases(): Map<string, string> {
  if (!globalThis.__deerhuxSessionAliases) globalThis.__deerhuxSessionAliases = new Map();
  return globalThis.__deerhuxSessionAliases;
}

function resolveSessionAlias(sessionKey: string): string {
  return getSessionAliases().get(sessionKey) ?? sessionKey;
}

function getCreatedSessions(): Map<string, string> {
  if (!globalThis.__deerhuxCreatedSessions) globalThis.__deerhuxCreatedSessions = new Map();
  return globalThis.__deerhuxCreatedSessions;
}

/** Resolve a stable new-session request id after its startup lock has settled. */
export function getCreatedSessionId(requestKey: string): string | undefined {
  return getCreatedSessions().get(requestKey);
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

export function listRpcSessionStates(): Array<{ sessionId: string; isStreaming: boolean; isCompacting: boolean; lastEventType: string; eventCount: number; eventRate: number; eventIdleMs: number | null; contentIdleMs: number | null }> {
  return uniqueRegistrySessions()
    .map((session) => session.getStatus());
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

  // ★ Security/reliability: enforce registry capacity before spawning a new session
  evictIdleSessionsIfNeeded();

  const deerStarting = (async () => {
    const { session, realSessionId } = await startDeerLoopSession(
      sessionId, sessionFile, cwd, toolNames, roleId, agentMode, model, options,
    );
    if (!sessionFile && sessionId.startsWith("__new__")) {
      getCreatedSessions().set(sessionId, realSessionId);
    }
    return { session, realSessionId };
  })().finally(() => {
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
// codegraph / mcp / subagent），支持角色/模式 prompt 注入，走 SessionManager 做
// jsonl 持久化。
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
  const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // 先打开持久化会话并恢复“给模型看的”原始上下文。只打开 jsonl 而不把
  // buildSessionContext 的结果注入 loop，会让历史续聊从空 transcript 开始。
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, undefined)
    : SessionManager.create(cwd, undefined);
  const restoredContext = sessionFile
    ? buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId())
    : null;
  const restoredModel = restoredContext?.model
    ? { provider: restoredContext.model.provider, modelId: restoredContext.model.modelId }
    : undefined;
  const restoredThinkingLevel = restoredContext?.thinkingLevel;
  const initialMessages = (restoredContext?.messages ?? []) as PiMessage[];

  // 选取默认 model。优先级：modelOverride（worker 继承父 session 的 model）
  // > 历史 session 最近使用的 model > DEERHUX_LOOP_MODEL > 第一个可用 model。worker 若退回默认
  // getAvailable()[0]，会与父 session 的 model 不一致（实测 deepseek-v4-pro
  // 不稳定会超时），导致 subagent 全军覆没。
  let model = modelRegistry.getAvailable()[0];
  const effectiveModel = modelOverride ?? restoredModel;
  const override = effectiveModel
    ? `${effectiveModel.provider}/${effectiveModel.modelId}`
    : process.env.DEERHUX_LOOP_MODEL;
  if (override) {
    const [provider, modelId] = override.split("/");
    if (provider && modelId) {
      const found = modelRegistry.find(provider, modelId);
      if (found) model = found;
    }
  }
  if (!model) {
    throw new Error(
      "DeerLoopEngine 启动失败：未找到可用 model。请在 ~/.deerhux/agent 配置 API key，" +
        "或设 DEERHUX_LOOP_MODEL=provider/modelId 指定模型。",
    );
  }

  // ─── 工具准备（与 pi 路径对齐：code_search + codegraph + subagent + mcp）───
  // 尽早取真实 sessionId：coding tools 需要它做 context archive 白名单与 spill。
  const realSessionIdEarly = sessionManager.getSessionId();
  const standardCodingTools = createStandardCodingTools(cwd, { sessionId: realSessionIdEarly });
  try {
    const { getContextDir } = await import("./engine/context-archive");
    const { addAllowedRoot } = await import("./file-access");
    addAllowedRoot(getContextDir(realSessionIdEarly));
  } catch {
    // context archive 白名单失败不阻塞会话启动
  }
  const allCodingToolNames = [...STANDARD_CODING_TOOL_NAMES];
  const hasCodeIndex = indexExists(cwd);
  const codeSearchTool = hasCodeIndex ? defineTool({
    name: "code_search",
    label: "Code Search",
    description: "Search the codebase using a pre-built index. Returns file paths, line ranges, and concise code snippets.",
    promptSnippet: "code_search: Search the indexed codebase by keywords and get file paths, line ranges, and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query keywords" }),
      path: Type.Optional(Type.String({ description: "Restrict to files under this relative path" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results, default 20" })),
    }),
    executionMode: "parallel" as const,
    execute: async (_toolCallId, params, signal) => {
      const results = await searchIndex(cwd, params.query, {
        path: params.path,
        limit: params.limit ?? 20,
        signal,
      });
      const text = results.length
        ? results.map(r => `${r.path}:${r.startLine}-${r.endLine} (score ${r.score})\n${r.snippet}`).join("\n\n")
        : `No indexed results for: ${params.query}`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  }) : null;
  const codeGraphTools = await createCodeGraphTools(cwd);
  const allowSubagentTool = options?.allowSubagentTool !== false;
  // holder 持有 engine 引用而非 model 快照：getParentModel 在 subagent 工具执行时
  // 实时读取 engine.model，从而跟随主 agent 运行中切换的供应商/模型（set_model →
  // engine.setModel → engine.model 变）。若存快照，切换后的 subagent 会用旧 model。
  const sessionContextHolder: { id: string | undefined; engine?: AgentEnginePort } = { id: undefined };
  const subagentTool = allowSubagentTool ? createSubagentTool(cwd, {
    getParentSessionId: () => sessionContextHolder.id,
    // Subagent 工具执行时，当前 leaf 通常是包含该 toolCall 的 assistant
    // message。把它持久化为稳定锚点，前端可沿当前 user turn 精确归位，
    // 不再依赖容易受刷新、分支和缺失时间戳影响的 createdAt 猜测。
    getParentEntryId: () => sessionManager.getLeafId() ?? undefined,
    getParentModel: () => {
      const m = sessionContextHolder.engine?.model;
      return m ? { provider: String(m.provider), modelId: String(m.id ?? "") } : undefined;
    },
  }) : null;

  const hasExplicitMode = agentMode !== undefined && agentMode !== null;
  const effectiveMode = normalizeAgentMode(agentMode);
  const requestedToolNames = toolNames ?? (hasExplicitMode ? getToolNamesForAgentMode(effectiveMode) : []);
  const shouldLoadMcpAtStartup = (!hasExplicitMode && isFullToolPreset(requestedToolNames)) || includesMcpTool(requestedToolNames);
  const mcpRuntimeLease = shouldLoadMcpAtStartup
    ? await import("./mcp-runtime").then(({ acquireMcpRuntime }) => acquireMcpRuntime(cwd))
    : null;
  const mcpRuntime = mcpRuntimeLease?.runtime ?? null;

  const customTools: AnyToolDefinition[] = [
    ...standardCodingTools,
    ...(codeSearchTool ? [codeSearchTool] : []),
    ...codeGraphTools,
    ...(subagentTool ? [subagentTool] : []),
    ...(mcpRuntime?.tools ?? []),
  ];
  const availableToolNames = [
    ...allCodingToolNames,
    ...(codeSearchTool ? ["code_search"] : []),
    ...codeGraphTools.map(t => t.name),
    ...(mcpRuntime?.toolNames ?? []),
  ];

  let activeToolNames: string[];
  if (toolNames !== undefined || hasExplicitMode) {
    if (requestedToolNames.length === 0) {
      activeToolNames = [];
    } else if (!hasExplicitMode && isFullToolPreset(requestedToolNames)) {
      activeToolNames = availableToolNames;
    } else {
      const available = new Set(availableToolNames);
      activeToolNames = requestedToolNames.filter(name => available.has(name));
    }
  } else {
    // 未传 toolNames 且无 agentMode：激活全部可用工具（与 pi 路径默认行为对齐）
    // subagent 按方案 B 只注册、不默认激活；availableToolNames 故意不包含它。
    // 用户显式调用 set_subagent_enabled 后，AgentSessionWrapper.applySubagentToActiveTools
    // 才会把已注册的 subagent 加入 active tool set 与 system prompt。
    activeToolNames = availableToolNames;
  }

  // ─── system prompt 构造 ───
  // 基础层必须来自 ResourceLoader，否则自研 loop 会绕过 pi SDK 在 AgentSession
  // 初始化时完成的 AGENTS.md / skills / append prompt / date / cwd 装配。
  // 角色、模式和实时工具由 wrapper 在这个稳定基础层之上统一应用。
  let systemPrompt = await loadBaseSystemPrompt(cwd, activeToolNames.includes("read"));
  // 全部工具关闭时清空 system prompt（对齐 pi 路径行为）
  if (toolNames?.length === 0) {
    systemPrompt = "";
  }

  // ★ 用 SessionManager 的真实 sessionId（uuid）作为 engine 的 sessionId，而不是
  //   前端/worker 传入的临时 key（如 `__collab__...`）。否则 registry 与
  //   subagent-registry 用临时 key 注册，而 SessionManager.listAll() 返回真实 uuid，
  //   两者对不上 → worker session 的 isSubagent 标记失效 → worker session 泄露到
  //   侧边栏项目列表（表现为「多出一模一样的 session」）。
  const realSessionId = realSessionIdEarly;

  // ─── 构造 DeerLoopEngine ───
  const engine: AgentEnginePort = new DeerLoopEngine({
    model,
    cwd,
    sessionId: realSessionId,
    systemPrompt,
    initialMessages,
    thinkingLevel: restoredThinkingLevel && restoredThinkingLevel !== "off"
      ? restoredThinkingLevel as ThinkingLevel
      : undefined,
    // 用 ModelRegistry 解析 key，而不是直接 AuthStorage.getApiKey(provider)。
    // 原因：custom providers 的 apiKey/headers 可能来自 models.json，pi 路径也是通过
    // ModelRegistry.getApiKeyForProvider / getApiKeyAndHeaders 处理。直接读 AuthStorage
    // 会漏掉 Opencodego 等 models.json provider，导致 No API key。
    getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
    sessionManager,
    modelRegistry,
    tools: customTools,
    activeToolNames,
    maxToolRounds: options?.maxToolRounds,
    requestKind: options?.requestKind,
  });

  // ★ M4：安装默认重试策略
  engine.installRetryHardening();

  // 用 AgentSessionWrapper 包装
  const wrapper = new AgentSessionWrapper(engine, roleId, mcpRuntimeLease, hasExplicitMode ? effectiveMode : undefined);
  wrapper.start();

  sessionContextHolder.id = realSessionId;
  sessionContextHolder.engine = engine;
  const realSessionFile = sessionManager.getSessionFile?.() ?? undefined;
  const sessionAliases = sessionId && sessionId !== realSessionId ? [sessionId] : [];
  if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile, sessionAliases);
  if (!sessionFile) forceRefreshSessionList();

  wrapper.onDestroy(() => unregisterSessionWrapper(wrapper));
  registerSessionAliases(realSessionId, wrapper, sessionAliases);

  return { session: wrapper, realSessionId };
}
