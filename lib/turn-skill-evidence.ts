import type { AgentMessage, TurnSkillContext, UserMessage } from "./types";
import { skillNames } from "./skill-selection";

export function normalizeTurnSkillContext(value: unknown): TurnSkillContext | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as TurnSkillContext).injected)) return undefined;
  return { ...(typeof (value as TurnSkillContext).cwd === "string" ? { cwd: (value as TurnSkillContext).cwd } : {}), injected: (value as TurnSkillContext).injected.filter(item => item && typeof item.name === "string").map(item => ({ name: item.name, ...(typeof item.filePath === "string" ? { filePath: item.filePath } : {}) })) };
}
export interface SkillEvidence { name: string; detail: string }
export interface TurnSkillEvidence {
  selected: SkillEvidence[];
  injected?: SkillEvidence[];
  read: SkillEvidence[];
  invoked: SkillEvidence[];
}

// Only explicit file operations count. Mentions, search results and command prose do not.
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/\.\//g, "/");
export function collectTurnSkillEvidence(user: UserMessage, messages: readonly AgentMessage[]): TurnSkillEvidence {
  const evidence: TurnSkillEvidence = {
    selected: skillNames(user.skill).map(name => ({ name, detail: "用户明确选择" })),
    injected: user.skillContext?.injected.map(item => ({ name: item.name, detail: item.filePath || "内容已加入本轮上下文" })),
    read: [], invoked: [],
  };
  const resolvePath = (value: string) => {
    const path = normalizePath(value);
    return /^(?:\/|[A-Za-z]:\/|~\/)/.test(path) || !user.skillContext?.cwd
      ? path : `${normalizePath(user.skillContext.cwd).replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
  };
  const roots = new Map<string, string>();
  for (const item of user.skillContext?.injected ?? []) {
    if (item.filePath) roots.set(resolvePath(item.filePath).replace(/\/SKILL\.md$/i, ""), item.name);
  }
  const nextUser = messages.findIndex(m => m.role === "user");
  const turnMessages = nextUser < 0 ? messages : messages.slice(0, nextUser);
  const results = new Map(turnMessages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
  const add = (kind: "read" | "invoked", name: string, detail: string) => {
    if (!evidence[kind].some(item => item.name === name && item.detail === detail)) evidence[kind].push({ name, detail });
  };
  for (const message of turnMessages) {
    if (message.role !== "assistant") continue;
    for (const tool of message.content) {
      if (tool.type !== "toolCall") continue;
      const result = results.get(tool.toolCallId);
      if (!result || result.isError) continue;
      const toolName = tool.toolName.toLowerCase();
      const paths: { path: string; kind: "read" | "invoked" }[] = [];
      if (["read", "read_file", "readfile"].includes(toolName)) {
        const value = tool.input.path ?? tool.input.file_path ?? tool.input.filePath;
        if (typeof value === "string") paths.push({ path: value, kind: "read" });
      }
      if (["bash", "exec_command", "shell"].includes(toolName)) {
        const command = tool.input.command ?? tool.input.cmd;
        if (typeof command === "string") {
          // Restrict attribution to a simple command; never treat strings inside scripts as execution.
          const tokens = command.trim().match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(t => t.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
          if (!/[;|&<>`\n#$]/.test(command) && tokens.length) {
            const executable = tokens[0].split("/").pop();
            if (["cat", "head", "tail"].includes(executable ?? "")) {
              for (const token of tokens.slice(1)) if (!token.startsWith("-")) paths.push({ path: token, kind: "read" });
            } else if (["python", "python3", "node", "bun", "bash", "sh"].includes(executable ?? "") && tokens[1] && !tokens[1].startsWith("-")) {
              paths.push({ path: tokens[1], kind: "invoked" });
            } else if (tokens[0].includes("/")) paths.push({ path: tokens[0], kind: "invoked" });
          }
        }
      }
      for (const operation of paths) {
        const filePath = resolvePath(operation.path);
        if (filePath.split("/").includes("..")) continue;
        if (operation.kind === "read" && /\/SKILL\.md$/i.test(filePath)) {
          const root = filePath.replace(/\/SKILL\.md$/i, "");
          const name = roots.get(root) ?? root.split("/").pop()!;
          roots.set(root, name);
          add("read", name, filePath);
          continue;
        }
        const root = [...roots.keys()].sort((a, b) => b.length - a.length).find(root => filePath.startsWith(`${root}/`));
        if (root) add(operation.kind, roots.get(root)!, filePath);
      }
    }
  }
  return evidence;
}
