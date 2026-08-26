import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { composeGlobalMemoryPrompt } from "./memory";
import { loadEnabledMcpServers } from "./mcp-runtime";
import { getDefaultModePromptSectionContent } from "./agent-modes";

/**
 * Decompose DeerHux's built-in system prompt into structured, configurable sections.
 *
 * DeerHux's buildSystemPrompt() produces a well-known format with these section
 * boundaries. This module parses that format back into sections and can
 * re-compose a custom prompt from a subset of sections.
 */

// ── Section types ──────────────────────────────────────────────────────────

export interface SystemPromptSection {
  /** Stable identifier for this section across versions */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Description shown in the UI */
  description: string;
  /** The actual text content of this section */
  content: string;
  /** Whether this section is currently enabled */
  enabled: boolean;
  /** Whether the user is allowed to edit the content (false for auto-generated sections) */
  editable: boolean;
}

export interface SystemPromptVersion {
  id: string;
  roleId?: string;
  name: string;
  description: string;
  /** Per-section overrides: only sections with non-default content or disabled state are stored */
  sections: Pick<SystemPromptSection, "id" | "enabled" | "content">[];
  createdAt: string;
  updatedAt: string;
}

export interface SystemPromptGlobalConfig {
  version: 1;
  sections: Pick<SystemPromptSection, "id" | "enabled" | "content">[];
  /** Skill names allowed for this role. null/undefined = all globally-enabled skills. [] = none. */
  skillNames?: string[] | null;
  /** MCP tool names allowed in this role's prompt. null/undefined = all discovered MCP tools. [] = none. */
  mcpToolNames?: string[] | null;
  activeVersionId?: string | null;
  updatedAt: string;
}

// ── Section definitions ────────────────────────────────────────────────────

const SECTION_SPECS: Omit<SystemPromptSection, "content" | "enabled">[] = [
  {
    id: "identity",
    label: "身份声明",
    description: "Agent 的核心身份描述和基本能力说明",
    editable: true,
  },
  {
    id: "tools",
    label: "可用工具",
    description: "当前会话可用的工具列表（动态生成）",
    editable: false,
  },
  {
    id: "guidelines",
    label: "行为准则",
    description: "文件操作、回答风格等行为规范",
    editable: true,
  },
  {
    id: "mode_control",
    label: "模式控制",
    description: "Ask / Plan / Agent 三种模式的运行时行为约束（根据当前模式自动生成）",
    editable: false,
  },
  {
    id: "project_context",
    label: "项目上下文",
    description: "来自 AGENTS.md 等项目文件的项目级指令",
    editable: false,
  },
  {
    id: "skills",
    label: "可用技能",
    description: "当前项目加载的技能列表",
    editable: false,
  },
  {
    id: "mcp_tools",
    label: "MCP 工具",
    description: "来自 MCP 配置窗口的 runtime tools，可按角色整体启用/禁用，并在下方细分工具",
    editable: false,
  },
  {
    id: "date_cwd",
    label: "日期与目录",
    description: "当前日期和工作目录",
    editable: false,
  },
  {
    id: "role_profile",
    label: "角色设定",
    description: "当前角色的设定库内容",
    editable: false,
  },
  {
    id: "global_memory",
    label: "全局记忆",
    description: "记忆窗口中管理的全局长期记忆，对所有角色生效",
    editable: false,
  },
];

const DEFAULT_SECTION_CONTENT: Record<string, string> = {
  identity: "You are an expert coding assistant operating inside DeerHux, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
  tools: "Available tools:\n[自动生成：根据当前会话启用的工具生成工具列表]",
  guidelines: "Guidelines:\n- 默认使用中文回复。\n- 执行前先简要复述对用户目标和关键约束的理解，再执行。\n- 输出从第一性原理出发，客观理性，拒绝鼓励式言论，拒绝“不是，而是”句式",
  mode_control: getDefaultModePromptSectionContent(),
  project_context: "<project_context>\n[自动生成：来自 AGENTS.md 等项目上下文文件]\n</project_context>",
  skills: "<available_skills>\n[自动生成：当前可用 skills 列表]\n</available_skills>",
  mcp_tools: "MCP runtime tools:\n[自动生成：来自 MCP 配置窗口；会话启动/重载时动态发现具体工具]",
  date_cwd: "Current date: [自动生成]\nCurrent working directory: [自动生成]",
  role_profile: "<!-- DEERHUX_ROLE_PROFILE_START -->\n[自动生成：当前角色设定]\n<!-- DEERHUX_ROLE_PROFILE_END -->",
};

function buildToolsSectionContent(_cwd?: string | null): string {
  return ["Available tools:", "[自动生成：根据当前会话启用的工具生成工具列表]"].join("\n");
}

function buildMcpToolsSectionContent(cwd?: string | null): string {
  const lines = [
    "MCP runtime tools:",
    "- 可按角色整体启用/禁用 MCP 工具提示；具体 MCP tool 会在会话启动/重载时通过 tools/list 动态发现。",
    "- 若当前模型配置未勾选图片输入，用户仍上传图片时，DeerHux 会优先调用可用的 MCP 图片识别工具生成 <image_context>，再把识别结果交给文本模型回答。",
  ];
  if (cwd?.trim()) {
    const mcpServers = loadEnabledMcpServers(cwd).filter((server) => server.transport === "stdio");
    for (const server of mcpServers) {
      lines.push(`- mcp__${server.id}__<tool>: ${server.name}${server.description ? ` — ${server.description}` : ""} (stdio)`);
    }
    if (mcpServers.length === 0) lines.push("- 当前没有启用的 stdio MCP server。");
  }
  return lines.join("\n");
}

export function getDefaultSystemPromptSections(cwd?: string | null): SystemPromptSection[] {
  const globalMemoryContent = composeGlobalMemoryPrompt();
  return SECTION_SPECS.map((spec) => ({
    ...spec,
    content: spec.id === "global_memory"
      ? globalMemoryContent
      : spec.id === "tools"
        ? buildToolsSectionContent(cwd)
        : spec.id === "mcp_tools"
          ? buildMcpToolsSectionContent(cwd)
          : (DEFAULT_SECTION_CONTENT[spec.id] ?? ""),
    enabled: spec.id === "global_memory" ? globalMemoryContent.length > 0 : true,
  }));
}

// ── Parse helpers ──────────────────────────────────────────────────────────

function extractBetween(text: string, startMarker: string, endMarker?: string): string | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + startMarker.length;

  if (endMarker) {
    const endIdx = text.indexOf(endMarker, contentStart);
    if (endIdx === -1) return null;
    return text.slice(contentStart, endIdx).trim();
  }

  return text.slice(contentStart).trim();
}

function extractBetweenTags(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  return extractBetween(text, open, close);
}

/**
 * Check if text contains the DeerHux role profile markers.
 */
const ROLE_PROFILE_MARKERS = [
  ["<!-- DEERHUX_ROLE_PROFILE_START -->", "<!-- DEERHUX_ROLE_PROFILE_END -->"],
  ["<!-- PI_ROLE_PROFILE_START -->", "<!-- PI_ROLE_PROFILE_END -->"],
] as const;

function findRoleProfileMarkers(text: string): typeof ROLE_PROFILE_MARKERS[number] | null {
  return ROLE_PROFILE_MARKERS.find(([startMarker]) => text.includes(startMarker)) ?? null;
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Decompose a full system prompt string into its sections.
 * Parses based on DeerHux's known buildSystemPrompt output format.
 * Sections that aren't found in the prompt get empty content and disabled=false.
 */
export function decomposeSystemPrompt(fullPrompt: string): SystemPromptSection[] {
  const sections: SystemPromptSection[] = [];
  let remaining = fullPrompt;

  for (const spec of SECTION_SPECS) {
    let content = "";
    let found = false;

    switch (spec.id) {
      case "identity": {
        // Identity: from start to "Available tools:" (or "Available" if tools section exists)
        const endMarker = remaining.includes("Available tools:")
          ? "Available tools:"
          : remaining.includes("Available")
            ? "Available"
            : "\n\n";
        const idx = remaining.indexOf(endMarker);
        if (idx > 0) {
          content = remaining.slice(0, idx).trim();
          remaining = remaining.slice(idx);
          found = true;
        } else {
          content = remaining.trim();
          remaining = "";
          found = content.length > 0;
        }
        break;
      }

      case "tools": {
        // Tools: from "Available tools:" to the next blank line followed by non-tool content
        const toolsMatch = remaining.match(/Available tools:\n([\s\S]*?)(?=\n\n(?!- )|\nGuidelines:|In addition)/);
        if (toolsMatch) {
          content = `Available tools:\n${toolsMatch[1].trim()}`;
          remaining = remaining.slice(toolsMatch[0].length);
          found = true;
        } else {
          // Try simpler: "Available tools:" to first double newline that's not followed by "- "
          const simple = remaining.match(/Available tools:[\s\S]*?(?=\n\n(?!- )|$)/);
          if (simple) {
            content = simple[0].trim();
            remaining = remaining.slice(simple[0].length);
            found = true;
          }
        }
        break;
      }

      case "guidelines": {
        // Guidelines section: "Guidelines:" to next major section
        const glMatch = remaining.match(/Guidelines:\n([\s\S]*?)(?=\n\n<deerhux_mode>|\n\n<project_context>|\n\n<available_skills>|\n\nCurrent date:|\n\n<!-- (?:DEERHUX|PI)_ROLE|$)/);
        if (glMatch) {
          content = `Guidelines:\n${glMatch[1].trim()}`;
          remaining = remaining.slice(glMatch[0].length);
          found = true;
        }
        break;
      }

      case "mode_control": {
        const modeContent = extractBetweenTags(remaining, "deerhux_mode");
        if (modeContent !== null) {
          content = `<deerhux_mode>\n${modeContent}\n</deerhux_mode>`;
          const closeTag = "</deerhux_mode>";
          const endIdx = remaining.indexOf(closeTag);
          if (endIdx !== -1) {
            remaining = remaining.slice(endIdx + closeTag.length);
          }
          found = true;
        }
        break;
      }

      case "project_context": {
        const ctxContent = extractBetweenTags(remaining, "project_context");
        if (ctxContent !== null) {
          content = `<project_context>\n${ctxContent}\n</project_context>`;
          // Remove from remaining
          const closeTag = "</project_context>";
          const endIdx = remaining.indexOf(closeTag);
          if (endIdx !== -1) {
            remaining = remaining.slice(endIdx + closeTag.length);
          }
          found = true;
        }
        break;
      }

      case "skills": {
        const skillsContent = extractBetweenTags(remaining, "available_skills");
        if (skillsContent !== null) {
          content = `<available_skills>\n${skillsContent}\n</available_skills>`;
          const closeTag = "</available_skills>";
          const endIdx = remaining.indexOf(closeTag);
          if (endIdx !== -1) {
            remaining = remaining.slice(endIdx + closeTag.length);
          }
          found = true;
        }
        break;
      }

      case "mcp_tools": {
        const mcpMatch = remaining.match(/(MCP runtime tools:\n[\s\S]*?)(?=\n\nCurrent date:|\n\n<!-- (?:DEERHUX|PI)_ROLE|\n\n# Global Memory|$)/);
        if (mcpMatch) {
          content = mcpMatch[1].trim();
          remaining = remaining.slice(mcpMatch[0].length);
          found = true;
        }
        break;
      }

      case "date_cwd": {
        // Date and CWD: at the very end
        const dateMatch = remaining.match(/(Current date:.*?)(?:\nCurrent working directory:.*?)?(?=\n\n<!-- (?:DEERHUX|PI)_ROLE|$)/);
        if (dateMatch) {
          content = dateMatch[0].trim();
          remaining = remaining.slice(dateMatch[0].length);
          found = true;
        }
        break;
      }

      case "role_profile": {
        const markers = findRoleProfileMarkers(remaining);
        if (markers) {
          const [startMarker, endMarker] = markers;
          const roleContent = extractBetween(remaining, startMarker, endMarker);
          if (roleContent !== null) {
            content = `<!-- DEERHUX_ROLE_PROFILE_START -->\n${roleContent}\n<!-- DEERHUX_ROLE_PROFILE_END -->`;
            const endIdx = remaining.indexOf(endMarker);
            if (endIdx !== -1) {
              remaining = remaining.slice(endIdx + endMarker.length);
            }
            found = true;
          }
        }
        break;
      }

      case "global_memory": {
        const gmMatch = remaining.match(/(# Global Memory \/ 全局记忆[\s\S]*?)(?=\n# |\n<!-- (?:DEERHUX|PI)_ROLE|\n<project_context>|\n<available_skills>|$)/);
        if (gmMatch) {
          content = gmMatch[1].trimEnd();
          remaining = remaining.slice(gmMatch[0].length);
          found = content.length > 0;
        }
        break;
      }
    }

    // Trim remaining whitespace/newlines
    remaining = remaining.replace(/^\n+/, "");

    sections.push({
      ...spec,
      content,
      enabled: found,
    });
  }

  return sections;
}

/**
 * Compose a full system prompt from a list of sections.
 * Only sections with enabled=true are included.
 */
export function composeSystemPrompt(sections: SystemPromptSection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    if (!section.enabled || !section.content.trim()) continue;
    parts.push(section.content.trim());
  }

  return parts.join("\n\n");
}

// ── Version management ─────────────────────────────────────────────────────

interface RoleConfigsFile {
  version: 1;
  configs: Record<string, SystemPromptGlobalConfig>;
}

const DEFAULT_ROLE_ID = "default";

function normalizeRoleId(roleId?: string | null): string {
  return roleId?.trim() || DEFAULT_ROLE_ID;
}

function nowIso(): string {
  return new Date().toISOString();
}

function uid(prefix = "spv"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function versionsFilePath(): string {
  return path.join(getAgentDir(), "system-prompt-versions.json");
}

export function readVersions(roleId?: string | null): SystemPromptVersion[] {
  const file = versionsFilePath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: 1; versions?: SystemPromptVersion[] };
    const versions = parsed.versions ?? [];
    if (roleId === undefined) return versions;
    const normalized = normalizeRoleId(roleId);
    return versions.filter((v) => normalizeRoleId(v.roleId) === normalized);
  } catch {
    return [];
  }
}

function writeVersions(versions: SystemPromptVersion[]): void {
  const file = versionsFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, versions }, null, 2));
}

export function createVersion(input: {
  roleId?: string | null;
  name: string;
  description?: string;
  sections: Pick<SystemPromptSection, "id" | "enabled" | "content">[];
}): SystemPromptVersion {
  const versions = readVersions();
  const version: SystemPromptVersion = {
    id: uid(),
    roleId: normalizeRoleId(input.roleId),
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    sections: input.sections,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  writeVersions([...versions, version]);
  return version;
}

export function updateVersion(
  versionId: string,
  patch: Partial<Pick<SystemPromptVersion, "name" | "description" | "sections">>
): SystemPromptVersion | null {
  const versions = readVersions();
  const idx = versions.findIndex((v) => v.id === versionId);
  if (idx === -1) return null;
  const current = versions[idx];
  const next: SystemPromptVersion = {
    ...current,
    ...patch,
    name: patch.name?.trim() || current.name,
    description: patch.description ?? current.description,
    updatedAt: nowIso(),
  };
  versions[idx] = next;
  writeVersions(versions);
  return next;
}

export function deleteVersion(versionId: string): boolean {
  const versions = readVersions();
  const next = versions.filter((v) => v.id !== versionId);
  if (next.length === versions.length) return false;
  writeVersions(next);
  return true;
}

/**
 * Filter the skills section in a system prompt to only include allowed skill names.
 * If allowedSkillNames is null/undefined, all skills pass through.
 * If allowedSkillNames is [], the entire <available_skills> block is removed.
 * Works on the full prompt text by parsing the <available_skills> block.
 */
export function filterSkillsInPrompt(prompt: string, allowedSkillNames: string[] | null | undefined): string {
  if (allowedSkillNames === null || allowedSkillNames === undefined) return prompt;

  const skillsTag = "<available_skills>";
  const skillsCloseTag = "</available_skills>";
  const startIdx = prompt.indexOf(skillsTag);
  if (startIdx === -1) return prompt;
  const endIdx = prompt.indexOf(skillsCloseTag, startIdx);
  if (endIdx === -1) return prompt;

  const before = prompt.slice(0, startIdx);
  const skillsBlock = prompt.slice(startIdx + skillsTag.length, endIdx);
  const after = prompt.slice(endIdx + skillsCloseTag.length);

  // Parse individual <skill>...</skill> entries
  const allowed = new Set(allowedSkillNames);
  const keptSkills: string[] = [];
  const skillRegex = /( *)<skill>\n([\s\S]*?) *<\/skill>/g;
  let match: RegExpExecArray | null;
  while ((match = skillRegex.exec(skillsBlock)) !== null) {
    const indent = match[1] ?? "";
    const inner = match[2];
    const nameMatch = inner.match(/<name>([^<]+)<\/name>/);
    if (nameMatch && allowed.has(nameMatch[1].trim())) {
      keptSkills.push(`${indent}<skill>\n${inner.trimEnd()}\n${indent}</skill>`);
    }
  }

  if (keptSkills.length === 0) {
    // Remove the entire skills section, trim trailing newlines
    return (before.trimEnd() + "\n\n" + after.trimStart()).trim();
  }

  return before + skillsTag + "\n" + keptSkills.join("\n") + "\n" + skillsCloseTag + after;
}

/**
 * Filter MCP tool lines in the full prompt. MCP tools are injected by the SDK as
 * lines in `Available tools:` whose names start with `mcp__`.
 * null/undefined keeps all MCP tool lines; [] removes all MCP tool lines.
 */
export function filterMcpToolsInPrompt(prompt: string, allowedMcpToolNames: string[] | null | undefined): string {
  if (allowedMcpToolNames === null || allowedMcpToolNames === undefined) return prompt;
  const allowed = new Set(allowedMcpToolNames);
  return prompt
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\s*-\s+(mcp__[\w-]+__[\w-]+(?:_\d+)?):/);
      if (!match) return true;
      return allowed.has(match[1]);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Apply a version's section config to a set of live sections.
 * Returns the merged sections: live content from the current prompt,
 * but with enabled/disabled toggles and editable content from the version.
 */
export function applyVersionToSections(
  liveSections: SystemPromptSection[],
  version: SystemPromptVersion
): SystemPromptSection[] {
  return applySectionOverrides(liveSections, version.sections);
}

export function applySectionOverrides(
  liveSections: SystemPromptSection[],
  overrides: Pick<SystemPromptSection, "id" | "enabled" | "content">[]
): SystemPromptSection[] {
  return liveSections.map((live) => {
    const override = overrides.find((s) => s.id === live.id);
    if (!override) return live;
    const useDynamicFallback = live.id === "tools" && override.enabled && !live.content.trim() && override.content.trim();
    return {
      ...live,
      enabled: override.enabled,
      content: live.editable
        ? (override.content || live.content)
        : useDynamicFallback
          ? override.content
          : live.content,
    };
  });
}

export function roleConfigsFilePath(): string {
  return path.join(getAgentDir(), "system-prompt-configs.json");
}

export function readRoleSystemPromptConfig(roleId?: string | null): SystemPromptGlobalConfig {
  const normalized = normalizeRoleId(roleId);
  const file = roleConfigsFilePath();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoleConfigsFile>;
      const config = parsed.configs?.[normalized];
      if (config) {
        return {
          version: 1,
          sections: Array.isArray(config.sections) ? config.sections : [],
          skillNames: config.skillNames ?? null,
          mcpToolNames: config.mcpToolNames ?? null,
          activeVersionId: config.activeVersionId ?? null,
          updatedAt: config.updatedAt ?? nowIso(),
        };
      }
    } catch { /* fall back */ }
  }
  // Backward compatibility: the old global config becomes the default role config.
  if (normalized === DEFAULT_ROLE_ID) return readGlobalSystemPromptConfig();
  return { version: 1, sections: [], skillNames: null, mcpToolNames: null, activeVersionId: null, updatedAt: nowIso() };
}

export function writeRoleSystemPromptConfig(roleId: string | null | undefined, input: {
  sections: Pick<SystemPromptSection, "id" | "enabled" | "content">[];
  skillNames?: string[] | null;
  mcpToolNames?: string[] | null;
  activeVersionId?: string | null;
}): SystemPromptGlobalConfig {
  const normalized = normalizeRoleId(roleId);
  const file = roleConfigsFilePath();
  let configs: Record<string, SystemPromptGlobalConfig> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RoleConfigsFile>;
      configs = parsed.configs ?? {};
    } catch { configs = {}; }
  }
  const config: SystemPromptGlobalConfig = {
    version: 1,
    sections: input.sections,
    skillNames: input.skillNames ?? null,
    mcpToolNames: input.mcpToolNames ?? null,
    activeVersionId: input.activeVersionId ?? null,
    updatedAt: nowIso(),
  };
  configs[normalized] = config;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, configs }, null, 2));
  return config;
}

export function configFilePath(): string {
  return path.join(getAgentDir(), "system-prompt-config.json");
}

export function readGlobalSystemPromptConfig(): SystemPromptGlobalConfig {
  const file = configFilePath();
  if (!existsSync(file)) return { version: 1, sections: [], activeVersionId: null, updatedAt: nowIso() };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SystemPromptGlobalConfig>;
    return {
      version: 1,
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      activeVersionId: parsed.activeVersionId ?? null,
      updatedAt: parsed.updatedAt ?? nowIso(),
    };
  } catch {
    return { version: 1, sections: [], activeVersionId: null, updatedAt: nowIso() };
  }
}

export function writeGlobalSystemPromptConfig(input: {
  sections: Pick<SystemPromptSection, "id" | "enabled" | "content">[];
  activeVersionId?: string | null;
}): SystemPromptGlobalConfig {
  const config: SystemPromptGlobalConfig = {
    version: 1,
    sections: input.sections,
    activeVersionId: input.activeVersionId ?? null,
    updatedAt: nowIso(),
  };
  const file = configFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2));
  return config;
}

export function isRoleSystemPromptSectionEnabled(roleId: string | null | undefined, sectionId: string): boolean {
  const config = readRoleSystemPromptConfig(roleId);
  const override = config.sections.find((s) => s.id === sectionId);
  return override?.enabled ?? true;
}

export function applyRolePromptConfigToPrompt(prompt: string, roleId?: string | null): string {
  const config = readRoleSystemPromptConfig(roleId);
  // Strip DeerHux's internal documentation section from the raw prompt permanently.
  // This section tells the LLM where DeerHux's docs are — unnecessary token waste for users.
  let result = prompt.replace(/\n\nPi documentation[\s\S]*?(?=\n\n<project_context>|\n\n<available_skills>|\n\nCurrent date:|\n\n<!-- (?:DEERHUX|PI)_ROLE|$)/, "");
  if (config.sections.length > 0) {
    const live = decomposeSystemPrompt(prompt);
    const merged = applySectionOverrides(live, config.sections);
    result = composeSystemPrompt(merged);
  }
  // Apply per-role skill filter (null = all, [] = none, ["a","b"] = only those)
  result = filterSkillsInPrompt(result, config.skillNames);
  // Apply per-role MCP prompt filter. The MCP module switch lives in sections;
  // when disabled it removes all MCP tool lines from `Available tools:`.
  const mcpSection = config.sections.find((s) => s.id === "mcp_tools");
  const mcpAllowedNames = mcpSection?.enabled === false ? [] : config.mcpToolNames;
  result = filterMcpToolsInPrompt(result, mcpAllowedNames);
  // Ensure SDK's hardcoded English guidelines are replaced with Chinese version
  result = ensureChineseGuidelines(result);
  return result;
}

/**
 * Replace the SDK's legacy hardcoded guidelines with DeerHux's defaults when the
 * user has not customized the section.
 */
function ensureChineseGuidelines(prompt: string): string {
  return prompt.replace(
    "- Be concise in your responses\n- Show file paths clearly when working with files",
    "- 默认使用中文回复。\n- 执行前先简要复述对用户目标和关键约束的理解，再执行。\n- 输出从第一性原理出发，客观理性，拒绝鼓励式言论，拒绝“不是，而是”句式",
  );
}

export function isGlobalSystemPromptSectionEnabled(sectionId: string): boolean {
  return isRoleSystemPromptSectionEnabled(DEFAULT_ROLE_ID, sectionId);
}

export function applyGlobalConfigToPrompt(prompt: string): string {
  return applyRolePromptConfigToPrompt(prompt, DEFAULT_ROLE_ID);
}
