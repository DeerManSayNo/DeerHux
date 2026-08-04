/**
 * Dynamic Context Discovery —— 会话上下文归档。
 *
 * 压缩时把被摘要的完整历史写成可检索 markdown；长工具输出落盘后只把预览
 * 放进 LLM context。Agent 可按需用 grep/read/bash 取回细节。
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 内联预览：超过此字节数则 spill（约 12KB）。 */
export const SPILL_PREVIEW_MAX_BYTES = 12_000;
/** 内联预览：超过此行数则 spill。 */
export const SPILL_PREVIEW_MAX_LINES = 200;
/** 单条 history 消息写入的硬上限，防止极端体积拖垮归档文件。 */
const HISTORY_MESSAGE_MAX_CHARS = 200_000;

export interface ContextManifestEntry {
  kind: "history" | "tool-output";
  path: string;
  createdAt: string;
  compactionId?: string;
  fromEntryId?: string;
  toEntryId?: string;
  toolCallId?: string;
  toolName?: string;
  bytes?: number;
}

export interface ContextManifest {
  version: 1;
  sessionId: string;
  entries: ContextManifestEntry[];
}

export interface SpillResult {
  preview: string;
  spilled: boolean;
  path?: string;
}

export interface WriteHistoryTranscriptOptions {
  sessionId: string;
  compactionId: string;
  messages: unknown[];
  fromEntryId?: string;
  toEntryId?: string;
}

export interface WriteToolOutputOptions {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  content: string;
}

function safeSessionSegment(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "unknown-session";
}

export function getContextRootDir(): string {
  return path.join(getAgentDir(), "context");
}

export function getContextDir(sessionId: string): string {
  return path.join(getContextRootDir(), safeSessionSegment(sessionId));
}

export function ensureContextDir(sessionId: string): string {
  const dir = getContextDir(sessionId);
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tool-outputs"), { recursive: true });
  return dir;
}

function manifestPath(sessionId: string): string {
  return path.join(getContextDir(sessionId), "manifest.json");
}

function readManifest(sessionId: string): ContextManifest {
  const file = manifestPath(sessionId);
  if (!fs.existsSync(file)) {
    return { version: 1, sessionId, entries: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ContextManifest;
    if (raw?.version === 1 && Array.isArray(raw.entries)) return raw;
  } catch {
    // ignore corrupt manifest
  }
  return { version: 1, sessionId, entries: [] };
}

function writeManifest(sessionId: string, manifest: ContextManifest): void {
  ensureContextDir(sessionId);
  const file = manifestPath(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function appendManifestEntry(sessionId: string, entry: ContextManifestEntry): void {
  const manifest = readManifest(sessionId);
  manifest.entries.push(entry);
  writeManifest(sessionId, manifest);
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return content.map((block) => {
    if (!block || typeof block !== "object") return String(block);
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") return b.text;
    if (b.type === "thinking" && typeof b.thinking === "string") return `[thinking]\n${b.thinking}`;
    if (b.type === "toolCall") {
      const name = typeof b.toolName === "string" ? b.toolName : "tool";
      const id = typeof b.toolCallId === "string" ? b.toolCallId : "";
      let args = "";
      try {
        args = JSON.stringify(b.input ?? b.arguments ?? {}, null, 2);
      } catch {
        args = "[unserializable args]";
      }
      return `[toolCall ${name}${id ? ` id=${id}` : ""}]\n${args}`;
    }
    if (b.type === "image") return "[image]";
    try {
      return JSON.stringify(b, null, 2);
    } catch {
      return "[unserializable block]";
    }
  }).join("\n\n");
}

function formatHistoryMessage(message: unknown, index: number): string {
  const m = message && typeof message === "object" ? message as Record<string, unknown> : null;
  const role = m && typeof m.role === "string" ? m.role : "unknown";
  let body = m ? messageContentToText(m.content) : String(message);
  if (role === "toolResult") {
    const toolCallId = m && typeof m.toolCallId === "string" ? m.toolCallId : "";
    const toolName = m && typeof m.toolName === "string" ? m.toolName : "";
    const header = [toolName && `tool=${toolName}`, toolCallId && `callId=${toolCallId}`].filter(Boolean).join(" ");
    if (header) body = `${header}\n${body}`;
  }
  if (body.length > HISTORY_MESSAGE_MAX_CHARS) {
    const omitted = body.length - HISTORY_MESSAGE_MAX_CHARS;
    body = `${body.slice(0, HISTORY_MESSAGE_MAX_CHARS)}\n\n[... truncated ${omitted} chars for archive size ...]`;
  }
  return `### [${index + 1}] ${role}\n\n${body}\n`;
}

const HISTORY_ARCHIVE_FOOTER_RE = /\n---\n\[DeerHux History Archive\][\s\S]*$/;

/** 列出本 session 已有的 history 归档（按文件名排序）。 */
export function listHistoryArchives(sessionId: string): string[] {
  const historyDir = path.join(getContextDir(sessionId), "history");
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter((name) => name.startsWith("comp-") && name.endsWith(".md"))
    .sort()
    .map((name) => path.join(historyDir, name));
}

export function buildHistoryArchiveFooter(historyFiles: string | string[]): string {
  const files = (Array.isArray(historyFiles) ? historyFiles : [historyFiles])
    .filter(Boolean);
  const unique = [...new Set(files)];
  const lines = unique.length === 1
    ? [`Full transcript of compacted messages: ${unique[0]}`]
    : [
        "Compacted transcripts (oldest → newest). Search with grep/read if the summary lacks detail:",
        ...unique.map((file) => `- ${file}`),
      ];
  return [
    "",
    "---",
    "[DeerHux History Archive]",
    ...lines,
    "Long tool outputs may also live in sibling tool-outputs/. Use grep/read/bash (e.g. tail) to recover details.",
  ].join("\n");
}

/**
 * 将归档指针写入摘要尾部。多次压缩时重写 footer，列出本 session 全部 history 文件，
 * 避免滚动摘要丢掉更早的 archive 路径（LLM context 只保留最新一条 compaction summary）。
 */
export function appendHistoryArchiveFooter(
  summary: string,
  historyFile: string,
  sessionId?: string,
): string {
  const stripped = summary.replace(HISTORY_ARCHIVE_FOOTER_RE, "").trimEnd();
  const archives = sessionId ? listHistoryArchives(sessionId) : [];
  if (historyFile && !archives.includes(historyFile)) archives.push(historyFile);
  if (!archives.length && historyFile) archives.push(historyFile);
  return `${stripped}\n${buildHistoryArchiveFooter(archives)}\n`;
}

export function writeHistoryTranscript(options: WriteHistoryTranscriptOptions): string {
  const { sessionId, compactionId, messages, fromEntryId, toEntryId } = options;
  const dir = ensureContextDir(sessionId);
  const filePath = path.join(dir, "history", `comp-${compactionId}.md`);
  const header = [
    `# DeerHux Compacted History`,
    "",
    `- sessionId: ${sessionId}`,
    `- compactionId: ${compactionId}`,
    `- fromEntryId: ${fromEntryId ?? ""}`,
    `- toEntryId: ${toEntryId ?? ""}`,
    `- createdAt: ${new Date().toISOString()}`,
    `- messageCount: ${messages.length}`,
    "",
    "Use grep/read against this file when the compaction summary lacks detail.",
    "",
    "---",
    "",
  ].join("\n");
  const body = messages.map((message, index) => formatHistoryMessage(message, index)).join("\n");
  fs.writeFileSync(filePath, header + body, "utf8");
  appendManifestEntry(sessionId, {
    kind: "history",
    path: filePath,
    createdAt: new Date().toISOString(),
    compactionId,
    fromEntryId,
    toEntryId,
    bytes: Buffer.byteLength(header + body, "utf8"),
  });
  return filePath;
}

export function writeToolOutput(options: WriteToolOutputOptions): string {
  const { sessionId, toolCallId, toolName, content } = options;
  const dir = ensureContextDir(sessionId);
  const safeId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || randomUUID().slice(0, 8);
  const filePath = path.join(dir, "tool-outputs", `${safeId}.txt`);
  const header = [
    `# Tool output`,
    `toolName: ${toolName}`,
    `toolCallId: ${toolCallId}`,
    `createdAt: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, header + content, "utf8");
  appendManifestEntry(sessionId, {
    kind: "tool-output",
    path: filePath,
    createdAt: new Date().toISOString(),
    toolCallId,
    toolName,
    bytes: Buffer.byteLength(header + content, "utf8"),
  });
  return filePath;
}

export function buildPreview(text: string, maxBytes: number, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const headCount = Math.max(20, Math.floor(maxLines / 2));
  const tailCount = Math.max(20, maxLines - headCount);
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(-tailCount).join("\n");
  let preview = `${head}\n\n...[${lines.length - headCount - tailCount} lines omitted]...\n\n${tail}`;
  if (Buffer.byteLength(preview, "utf8") > maxBytes) {
    const half = Math.floor(maxBytes / 2);
    const headBytes = Buffer.from(text, "utf8").subarray(0, half).toString("utf8");
    const tailBytes = Buffer.from(text, "utf8").subarray(-half).toString("utf8");
    preview = `${headBytes}\n\n...[truncated for preview]...\n\n${tailBytes}`;
  }
  return preview;
}

const SPILL_PATH_RE = /\[Output truncated\. Full output: ([^\]]+)\]/;

/** 若文本已含 spill 标记则不再二次落盘。 */
export function looksAlreadySpilled(text: string): boolean {
  return text.includes("[Output truncated. Full output:") || text.includes("[DeerHux History Archive]");
}

/**
 * 把已带 Full output 路径、但仍过大的正文压成 LLM 预览。
 * bash 进程 spill 会先把最多 2MB 内存缓冲写进文本再挂路径——此处负责真正缩到 ~12KB。
 */
export function shrinkSpilledPreview(
  text: string,
  maxBytes = SPILL_PREVIEW_MAX_BYTES,
  maxLines = SPILL_PREVIEW_MAX_LINES,
): { preview: string; path?: string; shrunk: boolean } {
  const match = text.match(SPILL_PATH_RE);
  const fullPath = match?.[1]?.trim();
  const body = fullPath
    ? text.replace(/\n*\n\[Output truncated\. Full output: [^\]]+\]\s*$/, "")
    : text;
  const bytes = Buffer.byteLength(body, "utf8");
  const lineCount = body.split(/\r?\n/).length;
  if (bytes <= maxBytes && lineCount <= maxLines) {
    return { preview: text, path: fullPath, shrunk: false };
  }
  const previewBody = buildPreview(body, maxBytes, maxLines);
  const preview = fullPath
    ? `${previewBody}\n\n[Output truncated. Full output: ${fullPath}]`
    : previewBody;
  return { preview, path: fullPath, shrunk: true };
}

/**
 * 为已落盘的全文构造 LLM 预览（不二次写盘）。
 */
export function previewForExistingSpill(
  text: string,
  fullPath: string,
  maxBytes = SPILL_PREVIEW_MAX_BYTES,
  maxLines = SPILL_PREVIEW_MAX_LINES,
): string {
  const previewBody = buildPreview(text, maxBytes, maxLines);
  return `${previewBody}\n\n[Output truncated. Full output: ${fullPath}]`;
}

export function spillLargeText(
  text: string,
  options: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    maxBytes?: number;
    maxLines?: number;
  },
): SpillResult {
  const maxBytes = options.maxBytes ?? SPILL_PREVIEW_MAX_BYTES;
  const maxLines = options.maxLines ?? SPILL_PREVIEW_MAX_LINES;
  if (!text) {
    return { preview: text, spilled: false };
  }
  // 已挂 Full output 路径但仍过大（典型：bash 进程 spill 保留了 2MB 缓冲）→ 只缩预览。
  if (looksAlreadySpilled(text)) {
    const shrunk = shrinkSpilledPreview(text, maxBytes, maxLines);
    return {
      preview: shrunk.preview,
      spilled: shrunk.shrunk,
      path: shrunk.path,
    };
  }
  const lineCount = text.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes && lineCount <= maxLines) {
    return { preview: text, spilled: false };
  }
  const fullPath = writeToolOutput({
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    content: text,
  });
  const previewBody = buildPreview(text, maxBytes, maxLines);
  const preview = `${previewBody}\n\n[Output truncated. Full output: ${fullPath}]`;
  return { preview, spilled: true, path: fullPath };
}

/** 删除某个 session 的 context 目录（session 删除时级联）。 */
export function deleteContextArchive(sessionId: string): void {
  const dir = getContextDir(sessionId);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

export function newCompactionArchiveId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
