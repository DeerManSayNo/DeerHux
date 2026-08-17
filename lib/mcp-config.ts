import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type McpTransport = "stdio" | "sse" | "http";
export type McpStdioFraming = "auto" | "newline" | "content-length";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  stdioFraming?: McpStdioFraming;
  url?: string;
  env?: Record<string, string>;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface McpConfigFile { version: 1; servers: McpServerConfig[] }

function nowIso(): string { return new Date().toISOString(); }
function uid(): string { return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function mcpConfigPath(): string {
  return path.join(getAgentDir(), "mcp.json");
}

function normalize(raw: Partial<McpServerConfig>): McpServerConfig | null {
  if (!raw.name?.trim()) return null;
  const transport: McpTransport = raw.transport === "sse" || raw.transport === "http" ? raw.transport : "stdio";
  return {
    id: raw.id || uid(),
    name: raw.name.trim(),
    enabled: raw.enabled !== false,
    transport,
    command: raw.command ?? "",
    args: Array.isArray(raw.args) ? raw.args.filter((v): v is string => typeof v === "string") : [],
    stdioFraming: raw.stdioFraming === "newline" || raw.stdioFraming === "content-length"
      ? raw.stdioFraming
      : "auto",
    url: raw.url ?? "",
    env: raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === "string")) : {},
    description: raw.description ?? "",
    createdAt: raw.createdAt ?? nowIso(),
    updatedAt: raw.updatedAt ?? nowIso(),
  };
}

export function readMcpServers(): McpServerConfig[] {
  const file = mcpConfigPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<McpConfigFile>;
    return (parsed.servers ?? []).map(normalize).filter((s): s is McpServerConfig => Boolean(s));
  } catch {
    return [];
  }
}

export function writeMcpServers(servers: Partial<McpServerConfig>[]): McpServerConfig[] {
  const normalized = servers.map(normalize).filter((s): s is McpServerConfig => Boolean(s)).map((s) => ({ ...s, updatedAt: nowIso() }));
  const file = mcpConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, servers: normalized }, null, 2));
  return normalized;
}
