import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { homedir } from "os";
import { getAgentDir, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { McpServerConfig, McpStdioFraming, McpTransport } from "./mcp-config";
import { detectMcpResponseFraming, encodeMcpMessage, selectFramingAttempts, type McpWireFraming } from "./mcp/stdio-framing";
import { registerShutdownCleanup } from "./process-shutdown";

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc?: "2.0"; id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }

class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

class McpRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "McpRpcError";
  }
}
interface McpTool { name: string; description?: string; inputSchema?: unknown }
interface RuntimeImage { type: "image"; data: string; mimeType: string }
interface RuntimeMcpTool { server: LoadedMcpServer; client: StdioMcpClient; tool: McpTool }

interface LoadedMcpServer extends McpServerConfig {
  sourcePath: string;
  priority: number;
}

type WireFraming = McpWireFraming;

export interface McpProcessDiagnostics {
  activeProcesses: number;
  startedTotal: number;
  exitedTotal: number;
  abnormalExits: number;
  initializeFallbacks: number;
  forcedKills: number;
  requestTimeouts: number;
  cachedFramingDecisions: number;
  runtimeCacheEntries: number;
  runtimeReferences: number;
}

type MutableMcpProcessDiagnostics = Omit<McpProcessDiagnostics, "cachedFramingDecisions" | "runtimeCacheEntries" | "runtimeReferences">;

declare global {
  var __deerhuxMcpProcessDiagnostics: MutableMcpProcessDiagnostics | undefined;
  var __deerhuxMcpFramingCache: Map<string, WireFraming> | undefined;
}

function processMetrics(): MutableMcpProcessDiagnostics {
  return globalThis.__deerhuxMcpProcessDiagnostics ??= {
    activeProcesses: 0,
    startedTotal: 0,
    exitedTotal: 0,
    abnormalExits: 0,
    initializeFallbacks: 0,
    forcedKills: 0,
    requestTimeouts: 0,
  };
}

function framingCache(): Map<string, WireFraming> {
  const cache = globalThis.__deerhuxMcpFramingCache ??= new Map();
  for (const [key, value] of cache) {
    if (value !== "line" && value !== "cl") cache.delete(key);
  }
  while (cache.size > 256) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return cache;
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

function maxMcpInboundBytes(): number {
  const configured = Number(process.env.DEERHUX_MCP_MAX_INBOUND_BYTES);
  return Number.isSafeInteger(configured) && configured >= 64 * 1024 ? configured : 16 * 1024 * 1024;
}

function initializeProbeTimeoutMs(): number {
  const configured = Number(process.env.DEERHUX_MCP_FRAMING_PROBE_MS);
  return Number.isSafeInteger(configured) && configured >= 500 ? configured : 8_000;
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
    stdioFraming: raw.stdioFraming === "newline" || raw.stdioFraming === "content-length"
      ? raw.stdioFraming
      : "auto",
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
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private stderr = "";
  /** Server response framing may differ from request framing, so receive side remains auto-detected. */
  private transportFormat: WireFraming | null = null;
  private writeFraming: WireFraming = "line";
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(private readonly server: LoadedMcpServer, private readonly cwd: string) {}

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.server.command?.trim()) throw new Error(`MCP server ${this.server.name} missing command`);
    const framingMode = this.server.stdioFraming ?? "auto";
    const envKey = Object.entries(this.server.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`).join("\0");
    const cacheKey = `${this.cwd}\0${this.server.command}\0${(this.server.args ?? []).join("\0")}\0${envKey}`;
    const cached = framingCache().get(cacheKey);
    const attempts = selectFramingAttempts(framingMode, cached);
    let lastError: unknown;
    for (let index = 0; index < attempts.length; index += 1) {
      this.writeFraming = attempts[index];
      this.spawnProcess();
      try {
        await this.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "DeerHux", version: "0.6.12" },
        }, framingMode === "auto" && index + 1 < attempts.length ? initializeProbeTimeoutMs() : 20_000, undefined, false);
        this.notify("notifications/initialized", {});
        if (framingMode === "auto") {
          const cache = framingCache();
          cache.delete(cacheKey);
          cache.set(cacheKey, this.writeFraming);
        }
        return;
      } catch (error) {
        lastError = error;
        const proc = this.proc;
        if (proc) await this.stopProcessAndWait(proc);
        if (error instanceof McpRpcError || error instanceof McpProtocolError || index + 1 >= attempts.length) break;
        processMetrics().initializeFallbacks += 1;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private spawnProcess(): void {
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.transportFormat = null;
    const proc = spawn(this.server.command!, this.server.args ?? [], {
      cwd: this.cwd,
      env: buildMcpEnv(this.server.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.proc = proc;
    const metrics = processMetrics();
    metrics.activeProcesses += 1;
    metrics.startedTotal += 1;
    let countedExit = false;
    const settleProcess = (abnormal: boolean) => {
      if (countedExit) return;
      countedExit = true;
      metrics.activeProcesses = Math.max(0, metrics.activeProcesses - 1);
      metrics.exitedTotal += 1;
      if (abnormal && !this.expectedExits.has(proc)) metrics.abnormalExits += 1;
      if (this.proc === proc) this.proc = null;
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      if (this.proc === proc) this.onData(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (this.proc === proc) this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    proc.on("error", (err) => {
      if (this.proc === proc) {
        const error = new Error(`MCP server ${this.server.name} failed to start: ${err.message}${this.stderr ? `: ${this.stderr}` : ""}`);
        this.rejectPending(error);
      }
      settleProcess(true);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) {
        const error = new Error(`MCP server ${this.server.name} exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr}` : ""}`);
        this.rejectPending(error);
      }
      settleProcess(code !== 0 || signal !== null);
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get activeFraming(): McpStdioFraming {
    return this.writeFraming === "line" ? "newline" : "content-length";
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
    this.rejectPending(new Error(`MCP server ${this.server.name} closed`));
    if (proc) this.stopProcess(proc);
  }

  private async stopProcessAndWait(proc: ChildProcessWithoutNullStreams): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    this.stopProcess(proc);
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
    ]);
  }

  private stopProcess(proc: ChildProcessWithoutNullStreams): void {
    this.expectedExits.add(proc);
    if (this.proc === proc) this.proc = null;
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
    proc.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        processMetrics().forcedKills += 1;
        proc.kill("SIGKILL");
      }
    }, 3_000);
    forceKill.unref?.();
    proc.once("exit", () => clearTimeout(forceKill));
  }

  private writeMessage(message: JsonRpcRequest): void {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed || !proc.stdin.writable) {
      throw new Error(`MCP server ${this.server.name} is not writable`);
    }
    proc.stdin.write(encodeMcpMessage(message, this.writeFraming));
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = 20_000,
    signal?: AbortSignal,
    countTimeout = true,
  ): Promise<unknown> {
    if (!this.proc) throw new Error(`MCP server ${this.server.name} is not running`);
    signal?.throwIfAborted();
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const cancelRequest = (reason: string, error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
        try { this.notify("notifications/cancelled", { requestId: id, reason }); } catch { /* process already exited */ }
        reject(error);
      };
      const timer = setTimeout(() => {
        if (countTimeout) processMetrics().requestTimeouts += 1;
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
      if (signal?.aborted) {
        onAbort();
      } else {
        try {
          this.writeMessage(message);
        } catch (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            signal?.removeEventListener("abort", onAbort);
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Header 可能被 stdout 拆成任意小 Chunk；前缀仍可能成为 Content-Length 时等待。
    if (this.transportFormat === null) {
      this.transportFormat = detectMcpResponseFraming(this.buffer.subarray(0, 32).toString("ascii"));
      if (this.transportFormat === null) return;
    }

    if (this.transportFormat === "line") this.parseLineDelimited();
    else this.parseContentLengthDelimited();
    // 已完整解析的多帧会从 Buffer 移除；这里只限制最后一条未完成帧。
    if (this.buffer.length > maxMcpInboundBytes() + 8 * 1024) {
      this.failProtocol(`Incomplete MCP response exceeded ${maxMcpInboundBytes()} bytes`);
    }
  }

  private failProtocol(message: string): void {
    const error = new McpProtocolError(`${this.server.name}: ${message}`);
    this.rejectPending(error);
    const proc = this.proc;
    if (proc) this.stopProcess(proc);
  }

  private parseLineDelimited(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf(0x0a);
      if (newlineIdx < 0) return;
      if (newlineIdx > maxMcpInboundBytes()) {
        this.failProtocol(`MCP newline response exceeded ${maxMcpInboundBytes()} bytes`);
        return;
      }
      const line = this.buffer.subarray(0, newlineIdx).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newlineIdx + 1);
      if (!line.trim()) continue;
      this.onMessage(line);
    }
  }

  private parseContentLengthDelimited(): void {
    const separator = Buffer.from("\r\n\r\n");
    while (true) {
      const headerEnd = this.buffer.indexOf(separator);
      if (headerEnd < 0) {
        if (this.buffer.length > 8 * 1024) this.failProtocol("MCP Content-Length header exceeded 8192 bytes");
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + separator.length);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxMcpInboundBytes()) {
        this.failProtocol(`Invalid MCP Content-Length: ${match[1]}`);
        return;
      }
      const messageStart = headerEnd + separator.length;
      if (this.buffer.length < messageStart + length) return;
      const body = this.buffer.subarray(messageStart, messageStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(messageStart + length);
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
      pending.reject(new McpRpcError(message.error.message || `MCP error ${message.error.code ?? "unknown"}`, message.error.code));
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
  stdioFraming?: McpStdioFraming;
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

export function getMcpProcessDiagnostics(): McpProcessDiagnostics {
  const cache = globalThis.__deerhuxMcpRuntimeCache ?? new Map<string, CachedMcpRuntime>();
  return {
    ...processMetrics(),
    cachedFramingDecisions: framingCache().size,
    runtimeCacheEntries: cache.size,
    runtimeReferences: [...cache.values()].reduce((sum, entry) => sum + entry.refs, 0),
  };
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
    registerShutdownCleanup(async () => {
      cleanup();
      // 给忽略 SIGTERM 的 MCP Server 留出 SIGKILL 升级窗口。
      if (processMetrics().activeProcesses > 0) {
        await new Promise((resolve) => setTimeout(resolve, 3_250));
      }
    });
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
        stdioFraming: client.activeFraming,
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
            const text = mcpContentToText(result);
            return {
              content: [{ type: "text" as const, text }],
              // raw 可能包含多 MB Base64/结构化结果；正文已进入 content，事件和 Session
              // 只保留轻量诊断元数据，避免长期双份持有。
              details: { server: server.name, tool: toolName, isError, bytes: Buffer.byteLength(text, "utf8") },
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

function mcpRuntimeCacheKey(cwd: string, servers: LoadedMcpServer[]): string {
  const stableServers = servers.map((server) => ({
    id: server.id,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args ?? [],
    stdioFraming: server.stdioFraming ?? "auto",
    url: server.url ?? "",
    env: Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  }));
  return `${path.resolve(cwd)}\0${JSON.stringify(stableServers)}`;
}

export async function acquireMcpRuntime(cwd: string): Promise<McpRuntimeLease> {
  const servers = loadEnabledMcpServers(cwd);
  const key = mcpRuntimeCacheKey(cwd, servers);
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
      entry.promise ??= createMcpRuntime(cwd, servers).then((runtime) => {
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

    let released = false;
    return {
      runtime,
      release: () => {
        if (released) return;
        released = true;
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
