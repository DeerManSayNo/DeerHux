import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchIndex } from "./search";

export function createCodeSearchTool(cwd: string) {
  return defineTool({
    name: "code_search",
    label: "Code Search",
    description: "Search a potentially stale index by literal keywords, not semantic similarity. Returns ranked paths, line ranges and one snippet per file. Empty results do not prove absence; use rg for current or exhaustive matches.",
    promptSnippet: "code_search: Prefer indexed keyword search for relevant files and implementations.",
    parameters: Type.Object({
      query: Type.String({ description: "Literal code keywords; translate natural-language intent into likely identifiers or terms" }),
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
        ? results.map((result) => `${result.path}:${result.startLine}-${result.endLine} (score ${result.score})\n${result.snippet}`).join("\n\n")
        : `No indexed results for: ${params.query}`;
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}
