export type AgentMode = "ask" | "plan" | "agent";

export interface AgentModeConfig {
  id: AgentMode;
  label: string;
  shortLabel: string;
  description: string;
  toolNames: string[];
  promptBlock: string;
  readOnly: boolean;
}

export const READ_ONLY_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "code_search",
  "codegraph",
];

export const AGENT_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "codegraph",
];

export const MODE_PROMPT_START = "<deerhux_mode>";
export const MODE_PROMPT_END = "</deerhux_mode>";
export const MODE_PROMPT_PLACEHOLDER = "[自动生成：运行时根据当前 Ask / Plan / Agent 模式注入具体约束]";
const TURN_MODE_RE = /\s*<deerhux_turn_mode\s+mode="(ask|plan|agent)">[\s\S]*?<\/deerhux_turn_mode>\s*/;

const ASK_PROMPT = `${MODE_PROMPT_START}
Mode: Ask
Help the user understand, analyze, and reason about the project.
- Use read-only tools when useful to gather context.
- Do not modify files, create files, delete files, run shell commands, or perform git operations.
- You may propose code or steps in the chat when helpful, but do not attempt to apply them.
${MODE_PROMPT_END}`;

const PLAN_PROMPT = `${MODE_PROMPT_START}
Mode: Plan
Research first and produce an implementation plan for the user to approve.
- Use read-only tools when useful to inspect the codebase.
- Ask clarifying questions if the requested change is ambiguous.
- Produce a concise Markdown plan with concrete files, risks, and validation steps.
- Do not modify source files, create files, delete files, run shell commands, or perform git operations.
- End by telling the user to click Build when they want you to implement the approved plan.
${MODE_PROMPT_END}`;

const AGENT_PROMPT = `${MODE_PROMPT_START}
Mode: Agent
Complete the user's task using the available tools when needed.
- Prefer the repository's existing patterns.
- Keep changes scoped to the user's request.
- Validate meaningful changes with the appropriate typecheck, lint, or focused tests when practical.
${MODE_PROMPT_END}`;

export const AGENT_MODE_CONFIGS: Record<AgentMode, AgentModeConfig> = {
  ask: {
    id: "ask",
    label: "Ask",
    shortLabel: "Ask",
    description: "只读问答",
    toolNames: READ_ONLY_TOOL_NAMES,
    promptBlock: ASK_PROMPT,
    readOnly: true,
  },
  plan: {
    id: "plan",
    label: "Plan",
    shortLabel: "Plan",
    description: "先研究再 Build",
    toolNames: READ_ONLY_TOOL_NAMES,
    promptBlock: PLAN_PROMPT,
    readOnly: true,
  },
  agent: {
    id: "agent",
    label: "Agent",
    shortLabel: "Agent",
    description: "可修改和执行",
    toolNames: AGENT_TOOL_NAMES,
    promptBlock: AGENT_PROMPT,
    readOnly: false,
  },
};

export function normalizeAgentMode(value: unknown): AgentMode {
  return value === "ask" || value === "plan" || value === "agent" ? value : "agent";
}

export function getAgentModeConfig(mode: unknown): AgentModeConfig {
  return AGENT_MODE_CONFIGS[normalizeAgentMode(mode)];
}

export function isReadOnlyAgentMode(mode: unknown): boolean {
  return getAgentModeConfig(mode).readOnly;
}

export function getToolNamesForAgentMode(mode: unknown): string[] {
  return getAgentModeConfig(mode).toolNames;
}

export function getDefaultModePromptSectionContent(): string {
  return `${MODE_PROMPT_START}
Mode: ${MODE_PROMPT_PLACEHOLDER}
- Ask: 只读问答，只能阅读和分析，不修改文件或执行命令。
- Plan: 先研究并输出计划，等待用户点击 Build 后再实施。
- Agent: 可按任务需要修改文件、运行命令并完成验证。
${MODE_PROMPT_END}`;
}

export function stripModePrompt(prompt: string): string {
  const start = prompt.indexOf(MODE_PROMPT_START);
  if (start === -1) return prompt;
  const end = prompt.indexOf(MODE_PROMPT_END, start);
  if (end === -1) return prompt.slice(0, start).trimEnd();
  return `${prompt.slice(0, start)}${prompt.slice(end + MODE_PROMPT_END.length)}`.trim();
}

export function applyModePrompt(basePrompt: string, mode: AgentMode): string {
  const cleaned = stripModePrompt(basePrompt).trim();
  const block = getAgentModeConfig(mode).promptBlock;
  return cleaned ? `${cleaned}\n\n${block}` : block;
}

export function extractTurnMode(message: string): AgentMode | null {
  const match = message.match(TURN_MODE_RE);
  return match ? normalizeAgentMode(match[1]) : null;
}

export function stripTurnModeContext(message: string): string {
  return message.replace(TURN_MODE_RE, "\n").trim();
}
