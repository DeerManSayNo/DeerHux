import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnyToolDefinition } from "./tool-registry.ts";
import { ensureContextDir, getContextDir, previewForExistingSpill, spillLargeText } from "./context-archive.ts";

export const STANDARD_CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface CreateStandardCodingToolsOptions {
  /** 当前 session id；用于长输出 spill 与 context 目录白名单。 */
  sessionId?: string;
}

const MAX_TEXT_BYTES = 200_000;
/** 进程输出内存硬上限；超过后截断。LLM 侧由 spill（~12KB）控制上下文体积。 */
const MAX_PROCESS_OUTPUT_BYTES = 2_000_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_FIND_LIMIT = 200;
const SKIPPED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  changedFiles?: string[];
};

function textResult(text: string, details: unknown = undefined, changedFiles?: string[]): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
    ...(changedFiles?.length ? { changedFiles } : {}),
  };
}

function activeSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

/** 与 pi-agent 一致：终止整个进程树，而不是只终止 shell 进程。 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } catch {
      // Process may already have exited.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already have exited.
    }
  }
}

function valueAsString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringParam(params: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = valueAsString(params[name]);
    if (value !== null) return value;
  }
  return null;
}

function rawStringParam(params: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = params[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function numberParam(params: Record<string, unknown>, names: string[], fallback: number): number {
  for (const name of names) {
    const value = params[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function booleanParam(params: Record<string, unknown>, names: string[], fallback = false): boolean {
  for (const name of names) {
    const value = params[name];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(true|1|yes)$/i.test(value)) return true;
      if (/^(false|0|no)$/i.test(value)) return false;
    }
  }
  return fallback;
}

function truncateText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n\n...[truncated ${bytes - maxBytes} bytes]`;
}

function normalizeRoot(root: string): string {
  try {
    return fs.realpathSync.native(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

function isInsideRoot(candidateParent: string, root: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidateParent === root || candidateParent.startsWith(rootWithSep);
}

/**
 * 解析路径：必须落在 cwd 或 extraRoots（当前 session 的 context archive）内。
 * 写操作应只传 cwd，避免 Agent 改写归档目录。
 */
function resolveAllowedPath(
  cwd: string,
  input: string | null,
  label = "path",
  extraRoots: string[] = [],
): string {
  if (!input) throw new Error(`${label} is required`);
  const roots = [normalizeRoot(cwd), ...extraRoots.map(normalizeRoot)];
  const primary = roots[0];
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(primary, input);
  const parent = fs.existsSync(candidate) ? candidate : path.dirname(candidate);
  const realParent = fs.existsSync(parent) ? fs.realpathSync.native(parent) : path.resolve(parent);
  if (roots.some((root) => isInsideRoot(realParent, root))) return candidate;
  throw new Error(`${label} must be inside cwd or session context archive`);
}

function lineSlice(content: string, offset: number, limit: number): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, offset > 0 ? offset - 1 : 0);
  const end = Math.min(lines.length, start + Math.max(1, limit));
  return lines.slice(start, end).map((line, index) => `${start + index + 1}|${line}`).join("\n");
}

function globToRegExp(pattern: string): RegExp {
  const hasOptionalDeepPrefix = pattern.startsWith("**/");
  const body = hasOptionalDeepPrefix ? pattern.slice(3) : pattern;
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0/g, ".*");
  return new RegExp(`^${hasOptionalDeepPrefix ? "(?:.*/)?" : ""}${escaped}$`);
}

async function walkFiles(root: string, current: string, out: string[], options: { maxDepth: number; limit: number; pattern?: RegExp; depth?: number }): Promise<void> {
  if (out.length >= options.limit) return;
  const depth = options.depth ?? 0;
  if (depth > options.maxDepth) return;

  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= options.limit) return;
    if (entry.name.startsWith(".") && entry.name !== ".cursor" && entry.name !== ".deerhux") continue;
    const abs = path.join(current, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      await walkFiles(root, abs, out, { ...options, depth: depth + 1 });
    } else if (entry.isFile() && (!options.pattern || options.pattern.test(rel) || options.pattern.test(entry.name))) {
      out.push(rel);
    }
  }
}

type ProcessRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 超过内存上限时全文落盘路径（stdout+stderr 合并文件）；未溢出则为 undefined。 */
  fullOutputPath?: string;
};

/**
 * 运行子进程。若提供 spillDir 且输出超过 MAX_PROCESS_OUTPUT_BYTES，
 * 改为把完整输出写入 spill 文件，内存只保留预览头——避免旧逻辑 truncate 丢尾。
 */
function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    signal: AbortSignal;
    timeoutMs?: number;
    shell?: boolean;
    spillDir?: string;
    spillId?: string;
  },
): Promise<ProcessRunResult> {
  if (opts.signal.aborted) {
    return Promise.reject(new DOMException("Process aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS, 1_000), MAX_PROCESS_TIMEOUT_MS);
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let combinedFile: string | undefined;
    let settled = false;
    let terminationError: Error | null = null;
    let postExitTimer: ReturnType<typeof setTimeout> | null = null;

    const ensureSpillFile = (): string => {
      if (combinedFile) return combinedFile;
      if (!opts.spillDir) throw new Error("spillDir required to create spill file");
      fs.mkdirSync(opts.spillDir, { recursive: true });
      const id = (opts.spillId ?? `proc-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      combinedFile = path.join(opts.spillDir, `${id}.full.txt`);
      // 首次溢出：把已有内存缓冲完整写入；后续 chunk 带 channel 标记 append。
      fs.writeFileSync(
        combinedFile,
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
        "utf8",
      );
      return combinedFile;
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (postExitTimer) clearTimeout(postExitTimer);
      opts.signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      fn();
    };
    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      if (combinedFile) {
        fs.appendFileSync(combinedFile, `\n--- ${target} continued ---\n${text}`, "utf8");
        if (target === "stdout") stdout = truncateText(stdout + text, MAX_PROCESS_OUTPUT_BYTES);
        else stderr = truncateText(stderr + text, MAX_PROCESS_OUTPUT_BYTES);
        return;
      }
      const nextStdout = target === "stdout" ? stdout + text : stdout;
      const nextStderr = target === "stderr" ? stderr + text : stderr;
      const totalBytes = Buffer.byteLength(nextStdout, "utf8") + Buffer.byteLength(nextStderr, "utf8");
      if (totalBytes <= MAX_PROCESS_OUTPUT_BYTES) {
        stdout = nextStdout;
        stderr = nextStderr;
        return;
      }
      // 超内存上限：有 spillDir 则落盘保全文，否则退回旧 truncate（丢尾）。
      if (opts.spillDir) {
        stdout = nextStdout;
        stderr = nextStderr;
        ensureSpillFile();
        stdout = truncateText(stdout, MAX_PROCESS_OUTPUT_BYTES);
        stderr = truncateText(stderr, MAX_PROCESS_OUTPUT_BYTES);
        return;
      }
      if (target === "stdout") stdout = truncateText(nextStdout, MAX_PROCESS_OUTPUT_BYTES);
      else stderr = truncateText(nextStderr, MAX_PROCESS_OUTPUT_BYTES);
    };
    const onAbort = () => {
      terminationError = new DOMException("Process aborted", "AbortError");
      if (child.pid) killProcessTree(child.pid);
    };
    const timer = setTimeout(() => {
      terminationError = new Error(`Process timed out after ${timeoutMs}ms`);
      if (child.pid) killProcessTree(child.pid);
    }, timeoutMs);

    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      postExitTimer = setTimeout(() => {
        finish(() => terminationError
          ? reject(terminationError)
          : resolve({ stdout, stderr, code, signal, fullOutputPath: combinedFile }));
      }, 100);
    });
    child.on("close", (code, signal) => finish(() => terminationError
      ? reject(terminationError)
      : resolve({ stdout, stderr, code, signal, fullOutputPath: combinedFile })));
  });
}

export function createStandardCodingTools(
  cwd: string,
  options?: CreateStandardCodingToolsOptions,
): AnyToolDefinition[] {
  const sessionId = options?.sessionId;
  const contextDir = sessionId ? getContextDir(sessionId) : null;
  // 读/搜允许访问本 session 的 context archive；写/编辑仍仅限 cwd。
  const readRoots = contextDir ? [contextDir] : [];
  const resolveReadPath = (input: string | null, label = "path") =>
    resolveAllowedPath(cwd, input, label, readRoots);
  const resolveWritePath = (input: string | null, label = "path") =>
    resolveAllowedPath(cwd, input, label, []);

  const contextHint = contextDir
    ? ` Also readable: session context archive at ${contextDir} (compacted history + spilled tool outputs).`
    : "";

  return [
    defineTool({
      name: "read",
      label: "Read File",
      description: `Read a text file under the current workspace${contextHint ? " or this session's context archive" : ""}. Supports optional 1-based offset and line limit.`,
      promptSnippet: `read: Read a text file by path (cwd${contextDir ? " or context archive" : ""}). Use filePath/path, optional offset and limit.`,
      parameters: Type.Object({
        filePath: Type.Optional(Type.String({ description: "File path to read, relative to cwd or absolute under cwd/context archive" })),
        path: Type.Optional(Type.String({ description: "Alias for filePath" })),
        offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, raw) => {
        const params = raw as Record<string, unknown>;
        const filePath = resolveReadPath(stringParam(params, ["filePath", "file_path", "path"]), "filePath");
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
        if (stat.size > MAX_TEXT_BYTES * 4) throw new Error(`File is too large to read: ${stat.size} bytes`);
        const content = await fs.promises.readFile(filePath, "utf8");
        const offset = numberParam(params, ["offset", "lineOffset", "startLine"], 1);
        const limit = numberParam(params, ["limit", "lineLimit"], 400);
        return textResult(lineSlice(content, offset, limit), { filePath, size: stat.size });
      },
    }),

    defineTool({
      name: "write",
      label: "Write File",
      description: "Create or overwrite a text file under the current workspace.",
      promptSnippet: "write: Create or overwrite a file. Use filePath/path and content.",
      parameters: Type.Object({
        filePath: Type.Optional(Type.String({ description: "File path to write, relative to cwd or absolute under cwd" })),
        path: Type.Optional(Type.String({ description: "Alias for filePath" })),
        content: Type.String({ description: "Complete file content" }),
      }),
      executionMode: "sequential" as const,
      execute: async (_toolCallId, raw) => {
        const params = raw as Record<string, unknown>;
        const filePath = resolveWritePath(stringParam(params, ["filePath", "file_path", "path"]), "filePath");
        const content = typeof params.content === "string" ? params.content : "";
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, content, "utf8");
        return textResult(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path.relative(cwd, filePath) || filePath}`, { filePath }, [filePath]);
      },
    }),

    defineTool({
      name: "edit",
      label: "Edit File",
      description: "Replace text in a file under the current workspace.",
      promptSnippet: "edit: Replace text in a file. Use filePath/path, oldString, newString, optional replaceAll.",
      parameters: Type.Object({
        filePath: Type.Optional(Type.String({ description: "File path to edit, relative to cwd or absolute under cwd" })),
        path: Type.Optional(Type.String({ description: "Alias for filePath" })),
        oldString: Type.Optional(Type.String({ description: "Text to replace" })),
        newString: Type.Optional(Type.String({ description: "Replacement text" })),
        replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences instead of requiring a unique match" })),
      }),
      executionMode: "sequential" as const,
      execute: async (_toolCallId, raw) => {
        const params = raw as Record<string, unknown>;
        const filePath = resolveWritePath(stringParam(params, ["filePath", "file_path", "path"]), "filePath");
        const oldString = rawStringParam(params, ["oldString", "old_string", "old"]);
        if (oldString === null || oldString.length === 0) throw new Error("oldString is required");
        const newString = rawStringParam(params, ["newString", "new_string", "new"]) ?? "";
        const replaceAll = booleanParam(params, ["replaceAll", "replace_all"], false);
        const content = await fs.promises.readFile(filePath, "utf8");
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) throw new Error("oldString not found");
        if (!replaceAll && occurrences > 1) throw new Error(`oldString appears ${occurrences} times; pass replaceAll=true or provide more context`);
        const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
        await fs.promises.writeFile(filePath, next, "utf8");
        return textResult(`Edited ${path.relative(cwd, filePath) || filePath} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"})`, { filePath, replacements: replaceAll ? occurrences : 1 }, [filePath]);
      },
    }),

    defineTool({
      name: "bash",
      label: "Run Shell Command",
      description: `Run a shell command in the current workspace and return stdout, stderr, and exit code. Long output may be truncated in-context with a Full output path under the session context archive — use read/grep/tail to recover details.${contextHint}`,
      promptSnippet: "bash: Run a shell command in cwd. Use command, optional timeoutMs. Long output spills to context archive.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run" }),
        timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
      }),
      executionMode: "sequential" as const,
      execute: async (toolCallId, raw, signal) => {
        const params = raw as Record<string, unknown>;
        const command = stringParam(params, ["command", "cmd"]);
        if (!command) throw new Error("command is required");
        const timeoutMs = numberParam(params, ["timeoutMs", "timeout"], DEFAULT_PROCESS_TIMEOUT_MS);
        const spillDir = sessionId
          ? path.join(ensureContextDir(sessionId), "tool-outputs")
          : undefined;
        const result = await runProcess(command, [], {
          cwd,
          signal: activeSignal(signal),
          timeoutMs,
          shell: true,
          spillDir,
          spillId: toolCallId,
        });
        const text = [
          `exit_code: ${result.code ?? "null"}${result.signal ? ` signal: ${result.signal}` : ""}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ].filter(Boolean).join("\n\n") || "Command completed with no output";

        // 进程已因超内存上限落盘：引用该文件，但 LLM 只收 ~12KB 预览（勿把 2MB 缓冲塞进 context）。
        if (result.fullOutputPath) {
          const preview = previewForExistingSpill(text, result.fullOutputPath);
          return textResult(preview, {
            command,
            ...result,
            spilled: true,
            fullOutputPath: result.fullOutputPath,
          });
        }

        if (sessionId) {
          try {
            const spilled = spillLargeText(text, {
              sessionId,
              toolCallId,
              toolName: "bash",
            });
            return textResult(spilled.preview, {
              command,
              ...result,
              spilled: spilled.spilled,
              fullOutputPath: spilled.path,
            });
          } catch (error) {
            console.warn("bash: spillLargeText failed", error);
          }
        }
        return textResult(text, { command, ...result });
      },
    }),

    defineTool({
      name: "grep",
      label: "Search Text",
      description: `Search file contents under the current workspace${contextDir ? " or this session's context archive" : ""} using ripgrep.`,
      promptSnippet: `grep: Search text with ripgrep (cwd${contextDir ? " or context archive" : ""}). Use pattern, optional path/glob/limit/ignoreCase.`,
      parameters: Type.Object({
        pattern: Type.String({ description: "Regex or text pattern to search for" }),
        path: Type.Optional(Type.String({ description: "Directory or file under cwd or context archive" })),
        glob: Type.Optional(Type.String({ description: "Optional glob filter" })),
        limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
        ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, raw, signal) => {
        const params = raw as Record<string, unknown>;
        const pattern = stringParam(params, ["pattern", "query"]);
        if (!pattern) throw new Error("pattern is required");
        const target = stringParam(params, ["path", "filePath", "file_path"]);
        const targetPath = target ? resolveReadPath(target, "path") : cwd;
        const args = ["--line-number", "--no-heading", "--color", "never"];
        if (booleanParam(params, ["ignoreCase", "ignore_case", "i"], false)) args.push("--ignore-case");
        const glob = stringParam(params, ["glob", "include"]);
        if (glob) args.push("--glob", glob);
        const limit = numberParam(params, ["limit", "maxResults"], 100);
        args.push("--max-count", String(Math.max(1, limit)), pattern, targetPath);
        const result = await runProcess("rg", args, { cwd, signal: activeSignal(signal), timeoutMs: 60_000 });
        if (result.code === 1 && !result.stdout) return textResult(`No matches for: ${pattern}`, { pattern, path: targetPath });
        return textResult(result.stdout || result.stderr || "No output", { pattern, path: targetPath, exitCode: result.code });
      },
    }),

    defineTool({
      name: "find",
      label: "Find Files",
      description: "Find files by name or glob under the current workspace.",
      promptSnippet: "find: Find files. Use optional path, pattern, maxDepth, limit.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory under cwd" })),
        pattern: Type.Optional(Type.String({ description: "File name or glob pattern, e.g. *.ts or **/*.tsx" })),
        maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth" })),
        limit: Type.Optional(Type.Number({ description: "Maximum files to return" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, raw) => {
        const params = raw as Record<string, unknown>;
        const root = resolveWritePath(stringParam(params, ["path", "dir", "directory"]) ?? ".", "path");
        const stat = await fs.promises.stat(root);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
        const pattern = stringParam(params, ["pattern", "name", "glob"]);
        const matcher = pattern ? globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`) : undefined;
        const limit = Math.max(1, numberParam(params, ["limit", "maxResults"], DEFAULT_FIND_LIMIT));
        const maxDepth = Math.max(0, numberParam(params, ["maxDepth", "depth"], 8));
        const files: string[] = [];
        await walkFiles(root, root, files, { maxDepth, limit, pattern: matcher });
        return textResult(files.length ? files.join("\n") : "No files found", { root, pattern, count: files.length });
      },
    }),

    defineTool({
      name: "ls",
      label: "List Directory",
      description: `List directory entries under the current workspace${contextDir ? " or this session's context archive" : ""}.`,
      promptSnippet: `ls: List a directory (cwd${contextDir ? " or context archive" : ""}). Use optional path.`,
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory under cwd or context archive" })),
      }),
      executionMode: "parallel" as const,
      execute: async (_toolCallId, raw) => {
        const params = raw as Record<string, unknown>;
        const dir = resolveReadPath(stringParam(params, ["path", "dir", "directory"]) ?? ".", "path");
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
          .join("\n");
        return textResult(lines || "(empty directory)", { path: dir, count: entries.length });
      },
    }),
  ];
}
