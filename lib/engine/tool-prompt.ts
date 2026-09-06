import type { ToolInfo } from "./port";

/** Prioritize discovery tools without enabling tools the user has disabled. */
export function orderToolNames(names: readonly string[]): string[] {
  const unique = [...new Set(names)];
  const preferred = ["code_search", "codegraph"];
  return [...preferred.filter(name => unique.includes(name)), ...unique.filter(name => !preferred.includes(name))];
}

/** Keep the live directory concise; the tool schema retains invocation details. */
export function buildLiveToolsSection(allTools: ToolInfo[], activeToolNames: string[], cwd?: string): string | null {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const available = orderToolNames(activeToolNames).filter(name => byName.has(name));
  const lines = available.flatMap((name) => {
    const tool = byName.get(name);
    if (!tool) return [];
    const snippet = tool.promptSnippet?.trim();
    const description = snippet || tool.description?.trim() || "Available tool";
    const prefix = `${name}:`;
    const summary = snippet && description.startsWith(prefix)
      ? description.slice(prefix.length).trim()
      : description;
    return [`- ${name}: ${summary}`];
  });
  if (!lines.length) return null;
  return [
    "Available tools:",
    ...lines,
    ...(activeToolNames.includes("bash") && ["read", "edit", "write"].some(name => activeToolNames.includes(name))
      ? ["Prefer the available read/edit/write tools over shell commands for file operations."]
      : []),
    ...(cwd ? [
      // The role prompt decomposer ends this section at a blank line.
      `Workspace (cwd): ${JSON.stringify(cwd)}`,
      "Resolve relative tool-result paths against this cwd when citing files; do not invent absolute path prefixes.",
      "For read-only questions, expand the search only to resolve missing or conflicting evidence.",
    ] : []),
  ].join("\n");
}
