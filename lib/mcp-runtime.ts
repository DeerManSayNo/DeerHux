import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { homedir } from "os";
import { getAgentDir, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { McpServerConfig, McpTransport } from "./mcp-config";

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc?: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
interface McpTool { name: string; description?: string; inputSchema?: unknown }
interface RuntimeImage { type: "image"; data: string; mimeType: string }
interface RuntimeMcpTool { server: LoadedMcpServer; client: StdioMcpClient; tool: McpTool }

interface LoadedMcpServer extends McpServerConfig {
  sourcePath: string;
  priority: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeTransport(value: unknown): McpTransport {
  return value === "sse" || value === "http" ? value : "stdio";
}

function sanitizeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "") || "server";
}

function normalizeServer(raw: Record<string, unknown>, fallbackId: string, sourcePath: string, priority: number): LoadedMcpServer | null {
  const name = asString(raw.name) || fallbackId;
  if (!name.trim()) return null;
  return {
    id: asString(raw.id) || sanitizeName(fallbackId),
    name: name.trim(),
    enabled: raw.enabled !== false,
    transport: normalizeTransport(raw.transport),
    command: asString(raw.command) ?? "",
    args: asStringArray(raw.args),
    url: asString(raw.url) ?? "",
    env: isRecord(raw.env) ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === "string")) as Record<string, string> : {},
    description: asString(raw.description) ?? "",
    createdAt: asString(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(raw.updatedAt) ?? new Date().toISOString(),
    sourcePath,
    priority,
  };
}

function readServersFromFile(filePath: string, priority: number): LoadedMcpServer[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) return [];
    const result: LoadedMcpServer[] = [];

    if (Array.isArray(parsed.servers)) {
      parsed.servers.forEach((item, index) => {
        if (!isRecord(item)) return;
        const normalized = normalizeServer(item, asString(item.name) || `server_${index + 1}`, filePath, priority);
        if (normalized) result.push(normalized);
      });
    }

    if (isRecord(parsed.mcpServers)) {
      for (const [id, item] of Object.entries(parsed.mcpServers)) {
        if (!isRecord(item)) continue;
        const normalized = normalizeServer({ id, name: id, enabled: true, transport: "stdio", ...item }, id, filePath, priority);
        if (normalized) result.push(normalized);
      }
    }

    return result;
  } catch {
    return [];
  }
}

export function loadEnabledMcpServers(cwd: string): LoadedMcpServer[] {
  const files = [
    { filePath: path.join(homedir(), ".pi", "agent", "mcp.json"), priority: 1 },
    { filePath: path.join(getAgentDir(), "mcp.json"), priority: 2 },
    { filePath: path.join(cwd, ".pi", "mcp.json"), priority: 3 },
    { filePath: path.join(cwd, ".deerhux", "mcp.json"), priority: 4 },
  ];
  const byId = new Map<string, LoadedMcpServer>();
  for (const source of files) {
    for (const server of readServersFromFile(source.filePath, source.priority)) {
      const existing = byId.get(server.id);
      if (!existing || existing.priority <= server.priority) byId.set(server.id, server);
    }
  }
  return [...byId.values()].filter((server) => server.enabled);
}

export function normalizeMcpServersForRuntime(servers: Partial<McpServerConfig>[], sourcePath = "<inline>"): LoadedMcpServer[] {
  return servers
    .map((server, index) => normalizeServer(
      server as Record<string, unknown>,
      asString(server.id) || asString(server.name) || `server_${index + 1}`,
      sourcePath,
      99,
    ))
    .filter((server): server is LoadedMcpServer => Boolean(server))
    .filter((server) => server.enabled);
}

function buildMcpEnv(serverEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const pathParts = [
    process.env.PATH ?? "",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  return {
    ...process.env,
    PATH: [...new Set(pathParts.flatMap((part) => part.split(path.delimiter)).filter(Boolean))].join(path.delimiter),
    ...(serverEnv ?? {}),
  };
}

export class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private stderr = "";
  /** Detected transport format: "line" (newline-delimited JSON, MCP 2024-11-05+) or "cl" (Content-Length prefix, legacy). */
  private transportFormat: "line" | "cl" | null = null;

  constructor(private readonly server: LoadedMcpServer, private readonly cwd: string) {}

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.server.command?.trim()) throw new Error(`MCP server ${this.server.name} missing command`);
    this.proc = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.cwd,
      env: buildMcpEnv(this.server.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.proc.on("error", (err) => {
      const error = new Error(`MCP server ${this.server.name} failed to start: ${err.message}${this.stderr ? `: ${this.stderr}` : ""}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(error);
      }
      this.pending.clear();
      this.proc = null;
    });
    this.proc.on("exit", (code, signal) => {
      const error = new Error(`MCP server ${this.server.name} exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr}` : ""}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(error);
      }
      this.pending.clear();
      this.proc = null;
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "DeerHux", version: "0.6.12" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) return [];
    return result.tools.filter(isRecord).map((tool) => ({
      name: asString(tool.name) || "",
      description: asString(tool.description) || "",
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : Type.Object({}),
    })).filter((tool) => tool.name);
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: isRecord(args) ? args : {} }, 5 * 60_000, signal);
  }

  close(): void {
    const proc = this.proc;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error(`MCP server ${this.server.name} closed`));
    }
    this.pending.clear();
    proc?.kill();
  }

  private writeMessage(message: JsonRpcRequest): void {
    const proc = this.proc;
    if (!proc) return;
    // Use newline-delimited JSON format (MCP 2024-11-05+ stdio standard).
    // Also prepend Content-Length frame for backward compat with legacy servers.
    const json = JSON.stringify(message);
    // Include the trailing newline in Content-Length so servers that parse
    // Content-Length headers read exactly what we send.
    const body = Buffer.from(json + "\n", "utf8");
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n${json}\n`);
  }

  private request(method: string, params?: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<unknown> {
    if (!this.proc) throw new Error(`MCP server ${this.server.name} is not running`);
    signal?.throwIfAborted();
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.writeMessage(message);
    return new Promise((resolve, reject) => {
      const cancelRequest = (reason: string, error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        this.notify("notifications/cancelled", { requestId: id, reason });
        reject(error);
      };
      const timer = setTimeout(() => {
        cancelRequest(
          `Request timed out after ${timeoutMs}ms`,
          new Error(`MCP request timed out: ${this.server.name}/${method}`),
        );
      }, timeoutMs);
      const onAbort = () => cancelRequest(
        "Parent agent turn aborted",
        new DOMException(`MCP request aborted: ${this.server.name}/${method}`, "AbortError"),
      );
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // Auto-detect transport format from first received data.
    if (this.transportFormat === null) {
      this.transportFormat = this.buffer.startsWith("Content-Length:") || this.buffer.startsWith("content-length:")
        ? "cl" : "line";
    }

    if (this.transportFormat === "line") {
      this.parseLineDelimited();
    } else {
      this.parseContentLengthDelimited();
    }
  }

  private parseLineDelimited(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx < 0) return;
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      this.onMessage(line);
    }
  }

  private parseContentLengthDelimited(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + length) return;
      const body = this.buffer.slice(messageStart, messageStart + length);
      this.buffer = this.buffer.slice(messageStart + length);
      this.onMessage(body);
    }
  }

  private onMessage(body: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(body) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP error ${message.error.code ?? "unknown"}`));
    } else {
      pending.resolve(message.result);
    }
  }
}

function mcpContentToText(result: unknown): string {
  if (!isRecord(result)) return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (Array.isArray(result.content)) {
    return result.content.map((item) => {
      if (!isRecord(item)) return JSON.stringify(item);
      if (typeof item.text === "string") return item.text;
      if (typeof item.data === "string") return item.data;
      return JSON.stringify(item);
    }).join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
}

function hasProperty(properties: Record<string, unknown>, names: string[]): string | null {
  const lower = new Map(Object.keys(properties).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const found = lower.get(name.toLowerCase());
    if (found) return found;
  }
  return null;
}

function looksLikeVisionTool(item: RuntimeMcpTool): boolean {
  const haystack = [
    item.server.id,
    item.server.name,
    item.server.description ?? "",
    item.tool.name,
    item.tool.description ?? "",
  ].join(" ").toLowerCase();
  if (/(vision|image|picture|photo|screenshot|ocr|视觉|图片|图像|截图|识别|看图)/i.test(haystack)) return true;
  const props = Object.keys(schemaProperties(item.tool.inputSchema)).join(" ").toLowerCase();
  return /(image|base64|mime|url|图片|图像)/i.test(props);
}

function buildVisionToolArgs(tool: McpTool, image: RuntimeImage, userPrompt: string, useDataUrlForGenericImage = false): Record<string, unknown> {
  const props = schemaProperties(tool.inputSchema);
  const args: Record<string, unknown> = {};
  const dataUrl = `data:${image.mimeType};base64,${image.data}`;

  const base64Key = hasProperty(props, ["image_base64", "imageBase64", "base64", "data", "imageData", "image_data"]);
  if (base64Key) args[base64Key] = image.data;

  const imageKey = hasProperty(props, ["image", "img", "picture", "file"]);
  if (imageKey && !(imageKey in args)) args[imageKey] = useDataUrlForGenericImage ? dataUrl : image.data;

  const sourceKey = hasProperty(props, ["image_source", "imageSource", "source", "src"]);
  if (sourceKey) args[sourceKey] = dataUrl;

  const urlKey = hasProperty(props, ["image_url", "imageUrl", "url", "uri"]);
  if (urlKey) args[urlKey] = dataUrl;

  const mimeKey = hasProperty(props, ["mimeType", "mime_type", "media_type", "mediaType", "type"]);
  if (mimeKey) args[mimeKey] = image.mimeType;

  const promptKey = hasProperty(props, ["prompt", "question", "query", "instruction", "instructions", "text"]);
  if (promptKey) args[promptKey] = userPrompt || "请详细描述这张图片中的内容，包含文字、界面布局和关键信息。";

  if (Object.keys(args).length === 0) {
    args.image = image.data;
    args.mimeType = image.mimeType;
    args.prompt = userPrompt || "请详细描述这张图片中的内容，包含文字、界面布局和关键信息。";
  }

  return args;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransport;
  status: "connected" | "error" | "unsupported";
  toolCount: number;
  errorMessage?: string;
  sourcePath?: string;
}

export interface McpRuntime {
  tools: ToolDefinition[];
  toolNames: string[];
  serverStatuses: McpServerStatus[];
  describeImages(images: RuntimeImage[], userPrompt?: string): Promise<string[]>;
  close(): void;
}

export interface McpRuntimeLease {
  runtime: McpRuntime;
  release(): void;
}

type CachedMcpRuntime = {
  runtime?: McpRuntime;
  promise?: Promise<McpRuntime>;
  refs: number;
  lastUsedAt: number;
};

declare global {
  var __deerhuxMcpRuntimeCache: Map<string, CachedMcpRuntime> | undefined;
}

function getMcpRuntimeCache(): Map<string, CachedMcpRuntime> {
  if (!globalThis.__deerhuxMcpRuntimeCache) {
    globalThis.__deerhuxMcpRuntimeCache = new Map();
    const cleanup = () => {
      for (const entry of globalThis.__deerhuxMcpRuntimeCache?.values() ?? []) {
        entry.runtime?.close();
      }
      globalThis.__deerhuxMcpRuntimeCache?.clear();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__deerhuxMcpRuntimeCache;
}

export async function createMcpRuntime(cwd: string, serverList = loadEnabledMcpServers(cwd)): Promise<McpRuntime> {
  const clients: StdioMcpClient[] = [];
  const runtimeTools: RuntimeMcpTool[] = [];
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();
  const serverStatuses: McpServerStatus[] = [];

  for (const server of serverList) {
    if (server.transport !== "stdio") {
      serverStatuses.push({
        id: server.id,
        name: server.name,
        transport: server.transport,
        status: "unsupported",
        toolCount: 0,
        errorMessage: `${server.transport} MCP transport is configured but not implemented yet`,
        sourcePath: server.sourcePath,
      });
      continue;
    }
    const client = new StdioMcpClient(server, cwd);
    try {
      await client.start();
      const serverTools = await client.listTools();
      clients.push(client);
      serverStatuses.push({
        id: server.id,
        name: server.name,
        transport: server.transport,
        status: "connected",
        toolCount: serverTools.length,
        sourcePath: server.sourcePath,
      });
      for (const mcpTool of serverTools) {
        runtimeTools.push({ server, client, tool: mcpTool });
        const baseName = `mcp__${sanitizeName(server.id)}__${sanitizeName(mcpTool.name)}`;
        let name = baseName;
        let i = 2;
        while (usedNames.has(name)) name = `${baseName}_${i++}`;
        usedNames.add(name);
        const toolName = mcpTool.name;
        tools.push(defineTool({
          name,
          label: `MCP: ${server.name} / ${toolName}`,
          description: mcpTool.description || `Call MCP tool ${toolName} from ${server.name}`,
          promptSnippet: `${name}: MCP tool ${toolName} from ${server.name}.`,
          parameters: (isRecord(mcpTool.inputSchema) ? mcpTool.inputSchema : Type.Object({})) as TSchema,
          executionMode: "sequential" as const,
          execute: async (_toolCallId, params, signal) => {
            const result = await client.callTool(toolName, params, signal);
            const isError = isRecord(result) && result.isError === true;
            return {
              content: [{ type: "text" as const, text: mcpContentToText(result) }],
              details: { server: server.name, tool: toolName, raw: result, isError },
            };
          },
        }) as ToolDefinition);
      }
    } catch (error) {
      client.close();
      serverStatuses.push({
        id: server.id,
        name: server.name,
        transport: server.transport,
        status: "error",
        toolCount: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        sourcePath: server.sourcePath,
      });
      // Keep session startup resilient: a broken MCP server should not block chat.
      console.warn(`[mcp] failed to load ${server.name}:`, error);
    }
  }

  return {
    tools,
    toolNames: tools.map((tool) => tool.name),
    serverStatuses,
    describeImages: async (images, userPrompt) => {
      const visionTool = runtimeTools.find(looksLikeVisionTool);
      if (!visionTool) return [];
      const descriptions: string[] = [];
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        let result: unknown;
        try {
          result = await visionTool.client.callTool(visionTool.tool.name, buildVisionToolArgs(visionTool.tool, image, userPrompt ?? ""));
        } catch {
          // Some MCP image tools expect a data URL for a generic `image` field.
          // Retry once with data URL before surfacing the failure text.
          try {
            result = await visionTool.client.callTool(visionTool.tool.name, buildVisionToolArgs(visionTool.tool, image, userPrompt ?? "", true));
          } catch (retryError) {
            descriptions.push(`图片 ${index + 1} 识别失败：${retryError instanceof Error ? retryError.message : String(retryError)}`);
            continue;
          }
        }
        descriptions.push(mcpContentToText(result));
      }
      return descriptions;
    },
    close: () => clients.forEach((client) => client.close()),
  };
}

export async function acquireMcpRuntime(cwd: string): Promise<McpRuntimeLease> {
  const key = path.resolve(cwd);
  const cache = getMcpRuntimeCache();
  let entry = cache.get(key);
  if (!entry) {
    entry = { refs: 0, lastUsedAt: Date.now() };
    cache.set(key, entry);
  }

  entry.refs += 1;
  entry.lastUsedAt = Date.now();

  try {
    if (!entry.runtime) {
      entry.promise ??= createMcpRuntime(cwd).then((runtime) => {
        entry!.runtime = runtime;
        entry!.promise = undefined;
        entry!.lastUsedAt = Date.now();
        return runtime;
      }).catch((error) => {
        entry!.promise = undefined;
        throw error;
      });
      await entry.promise;
    }

    const runtime = entry.runtime;
    if (!runtime) throw new Error("MCP runtime failed to initialize");

    return {
      runtime,
      release: () => {
        const current = cache.get(key);
        if (!current) return;
        current.refs = Math.max(0, current.refs - 1);
        current.lastUsedAt = Date.now();
        if (current.refs === 0) {
          current.runtime?.close();
          cache.delete(key);
        }
      },
    };
  } catch (error) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.runtime) cache.delete(key);
    throw error;
  }
}

export async function createMcpRuntimeFromServers(cwd: string, servers: Partial<McpServerConfig>[]): Promise<McpRuntime> {
  return createMcpRuntime(cwd, normalizeMcpServersForRuntime(servers));
}
