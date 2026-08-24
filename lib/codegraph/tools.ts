import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCodeGraphJson } from "./cli";
import { ensureCodeGraphInitialized } from "./detect";

export const CODEGRAPH_TOOL_NAME = "codegraph";
export const LEGACY_CODEGRAPH_TOOL_NAMES = [
  "codegraph_status",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
] as const;

const legacyCodeGraphToolNames = new Set<string>(LEGACY_CODEGRAPH_TOOL_NAMES);

/** 将旧版五个 CodeGraph 工具白名单折叠为新的单一 dispatcher。 */
export function normalizeCodeGraphToolNames(toolNames: readonly string[]): string[] {
  const normalized: string[] = [];
  let addedCodeGraph = false;
  for (const name of toolNames) {
    const next = legacyCodeGraphToolNames.has(name) ? CODEGRAPH_TOOL_NAME : name;
    if (next === CODEGRAPH_TOOL_NAME) {
      if (addedCodeGraph) continue;
      addedCodeGraph = true;
    }
    if (!normalized.includes(next)) normalized.push(next);
  }
  return normalized;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function limit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value as number), max));
}

function required(value: unknown, name: "query" | "symbol", action: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`codegraph ${action} requires \`${name}\``);
}

export interface CodeGraphToolInput {
  action: "status" | "search" | "callers" | "callees" | "impact";
  query?: string;
  symbol?: string;
  kind?: string;
  limit?: number;
  depth?: number;
}

export function buildCodeGraphArgs(params: CodeGraphToolInput): string[] {
  switch (params.action) {
    case "status":
      return ["status", "--json"];
    case "search": {
      const query = required(params.query, "query", params.action);
      const args = ["query", query, "--json", "--limit", String(limit(params.limit, 10, 50))];
      if (params.kind) args.push("--kind", params.kind);
      return args;
    }
    case "callers":
    case "callees":
      return [
        params.action,
        required(params.symbol, "symbol", params.action),
        "--json",
        "--limit",
        String(limit(params.limit, 20, 100)),
      ];
    case "impact":
      return [
        "impact",
        required(params.symbol, "symbol", params.action),
        "--json",
        "--depth",
        String(limit(params.depth, 2, 5)),
      ];
    default:
      throw new Error(`Unsupported codegraph action: ${String(params.action)}`);
  }
}

export async function createCodeGraphTools(cwd: string): Promise<ToolDefinition[]> {
  const status = await ensureCodeGraphInitialized(cwd);
  if (!status?.initialized) return [];

  return [defineTool({
    name: CODEGRAPH_TOOL_NAME,
    label: "CodeGraph",
    description: "Query the semantic code graph: inspect index status, search symbols, trace callers/callees, or analyze change impact. Prefer this for code symbols and call relationships.",
    promptSnippet: "codegraph: Search symbols, trace callers/callees, inspect index status, or analyze change impact.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("search"),
        Type.Literal("callers"),
        Type.Literal("callees"),
        Type.Literal("impact"),
      ], { description: "CodeGraph operation to run" }),
      query: Type.Optional(Type.String({ description: "Search query; required for action=search" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name; required for callers, callees, and impact" })),
      kind: Type.Optional(Type.String({ description: "Optional search kind, e.g. function, class, method, interface, component" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results for search/callers/callees" })),
      depth: Type.Optional(Type.Number({ description: "Impact traversal depth, default 2, max 5" })),
    }),
    executionMode: "parallel" as const,
    execute: async (_toolCallId, params, signal) => {
      const args = buildCodeGraphArgs(params);
      const result = await runCodeGraphJson(args, {
        cwd,
        signal,
        ...(params.action === "status" ? { timeoutMs: 10_000 } : {}),
      });
      return { content: [{ type: "text" as const, text: pretty(result) }], details: result };
    },
  })];
}
