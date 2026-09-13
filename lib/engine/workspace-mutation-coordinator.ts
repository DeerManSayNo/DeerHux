import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { resolveChangedFilePath } from "../changed-file-path.ts";
import type { FileChange } from "../file-changes.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export interface WorkspaceFileSignature {
  status: string;
  fingerprint: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileSignature>;

interface WorkspaceQueueState {
  tail: Promise<void>;
  pending: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "Aborted", "AbortError");
}

function waitWithAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function normalizeWorkspacePath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function resolveWorkspaceKey(cwd: string, signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      signal,
    });
    return normalizeWorkspacePath(stdout.trim());
  } catch {
    return normalizeWorkspacePath(cwd);
  }
}

/**
 * 进程内、按工作区隔离的 FIFO 修改队列。所有 DeerLoopEngine 实例共享同一单例，
 * 所以同一项目的多个 Chat Session 不会把可写工具交叉执行。
 */
export class WorkspaceMutationCoordinator {
  private readonly queues = new Map<string, WorkspaceQueueState>();

  async runExclusive<T>(cwd: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return this.runExclusiveWorkspaces([cwd], signal, operation);
  }

  /** 外部目标属于另一项目时也持有其项目锁，防止被该项目的 Git 快照认领。 */
  async runExclusiveWorkspaces<T>(directories: string[], signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const keys = [...new Set(await Promise.all([...new Set(directories)]
      .map((directory) => resolveWorkspaceKey(directory, signal))))].sort();
    const enter = (index: number): Promise<T> => index === keys.length
      ? operation()
      : this.runExclusiveKey(keys[index], signal, () => enter(index + 1));
    return enter(0);
  }

  /** 跨项目访问同一显式文件也互斥；排序获取锁以避免多文件操作死锁。 */
  async runExclusiveFiles<T>(files: string[], signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(files.map((file) => `file:${canonicalMutationPath(file)}`))].sort();
    const enter = (index: number): Promise<T> => index === keys.length
      ? operation()
      : this.runExclusiveKey(keys[index], signal, () => enter(index + 1));
    return enter(0);
  }

  private async runExclusiveKey<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let state = this.queues.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 };
      this.queues.set(key, state);
    }

    const predecessor = state.tail.catch(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.tail = predecessor.then(() => gate);
    state.pending += 1;

    try {
      await waitWithAbort(predecessor, signal);
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
      state.pending -= 1;
      if (state.pending === 0 && this.queues.get(key) === state) this.queues.delete(key);
    }
  }
}

// 对尚未创建的文件也解析已存在的父目录，避免符号链接别名绕过文件锁。
function canonicalMutationPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    const parent = path.dirname(filePath);
    return parent === filePath ? filePath : path.join(canonicalMutationPath(parent), path.basename(filePath));
  }
}

function existingParentDirectory(filePath: string): string {
  let directory = path.dirname(filePath);
  while (true) {
    try {
      if (fs.statSync(directory).isDirectory()) return directory;
    } catch { /* 新建文件的父目录也可能尚不存在，继续向上找所属项目。 */ }
    const parent = path.dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
}

/** 只跟踪工具明确声明的目标，不从 shell 文本猜测路径或扫描项目外目录。 */
export function getToolMutationPaths(toolName: string, args: unknown, cwd: string): string[] {
  if (!args || typeof args !== "object") return [];
  const params = args as Record<string, unknown>;
  let candidates: unknown[] = [];
  if (toolName === "write" || toolName === "edit") {
    const value = [params.filePath, params.file_path, params.path]
      .find((candidate) => typeof candidate === "string" && candidate.trim());
    candidates = typeof value === "string" ? [value.trim()] : [];
  } else if (toolName === "bash" && Array.isArray(params.affectedFiles)) {
    candidates = params.affectedFiles;
  }
  return [...new Set(candidates.flatMap((candidate) => {
    const resolved = typeof candidate === "string" ? resolveChangedFilePath(candidate, cwd) : null;
    return resolved ? [resolved] : [];
  }))];
}

async function readExplicitFileSnapshot(files: string[]): Promise<Map<string, string | null>> {
  return new Map(await Promise.all(files.map(async (filePath) => {
    const fingerprint = await fingerprintPath(filePath);
    // 目录和读取失败不是文件修改证据。ENOENT 则用于识别新增/删除。
    if (fingerprint.startsWith("node:") || (fingerprint.startsWith("unavailable:") && fingerprint !== "unavailable:ENOENT")) {
      return [filePath, null] as const;
    }
    // write/edit 会跟随链接写入目标，同时记录链接本身的变化。
    const target = fingerprint.startsWith("symlink:") ? canonicalMutationPath(filePath) : filePath;
    const content = target !== filePath ? await fingerprintPath(target) : fingerprint;
    if (content.startsWith("node:") || (content.startsWith("unavailable:") && content !== "unavailable:ENOENT")) {
      return [filePath, null] as const;
    }
    return [filePath, `${fingerprint}|${content}`] as const;
  })));
}

const globalForCoordinator = globalThis as unknown as {
  __deerhuxWorkspaceMutationCoordinator?: WorkspaceMutationCoordinator;
};

// 开发热更新可能保留旧版实例；只有缺少新增锁能力时才替换，后续热更新保留队列。
const existingCoordinator = globalForCoordinator.__deerhuxWorkspaceMutationCoordinator;
export const workspaceMutationCoordinator = existingCoordinator
  && typeof existingCoordinator.runExclusiveWorkspaces === "function"
  ? existingCoordinator
  : (globalForCoordinator.__deerhuxWorkspaceMutationCoordinator = new WorkspaceMutationCoordinator());

function resolveWorkspacePath(cwd: string, candidate: string): string | null {
  if (!candidate || candidate.includes("\0") || path.isAbsolute(candidate)) return null;
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return absolute;
}

async function fingerprintPath(filePath: string): Promise<string> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink()) return `symlink:${await fs.promises.readlink(filePath)}`;
    if (!stat.isFile()) return `node:${stat.mode}:${stat.size}:${stat.mtimeMs}`;

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return `file:${hash.digest("hex")}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
    return `unavailable:${code}`;
  }
}

/**
 * 读取当前 cwd 下所有 Git 脏文件并生成内容签名。Git 不可用时返回 null，调用方
 * 必须降级到工具显式 changedFiles，不能阻断工具执行。
 */
export async function readWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | null> {
  try {
    const deadline = Date.now() + GIT_TIMEOUT_MS;
    const remaining = () => Math.max(1, deadline - Date.now());
    const { stdout: prefixOutput } = await execFileAsync("git", ["rev-parse", "--show-prefix"], {
      cwd,
      encoding: "utf8",
      timeout: remaining(),
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    const cwdPrefix = prefixOutput.trim().replace(/\\/g, "/");
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."],
      { cwd, encoding: "buffer", timeout: remaining(), maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
    );

    const entries: Array<{ absolutePath: string; status: string }> = [];
    for (const entry of Buffer.from(stdout).toString("utf8").split("\0")) {
      if (entry.length < 4 || entry[2] !== " ") continue;
      const rootRelativePath = entry.slice(3);
      const cwdRelativePath = cwdPrefix && rootRelativePath.startsWith(cwdPrefix)
        ? rootRelativePath.slice(cwdPrefix.length)
        : rootRelativePath;
      const absolutePath = resolveWorkspacePath(cwd, cwdRelativePath);
      if (absolutePath) entries.push({ absolutePath, status: entry.slice(0, 2) });
    }

    const snapshot: WorkspaceSnapshot = new Map();
    for (const entry of entries) {
      snapshot.set(entry.absolutePath, {
        status: entry.status,
        fingerprint: await fingerprintPath(entry.absolutePath),
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** 工具锁内使用对称差分；恢复脏文件、再次修改已脏文件也属于本工具改动。 */
export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot | null,
  after: WorkspaceSnapshot | null,
): string[] {
  if (!before || !after) return [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const filePath of paths) {
    const left = before.get(filePath);
    const right = after.get(filePath);
    if (!left || !right || left.status !== right.status || left.fingerprint !== right.fingerprint) {
      changed.push(filePath);
    }
  }
  return changed;
}

function workspaceFileChanges(before: WorkspaceSnapshot | null, after: WorkspaceSnapshot | null): FileChange[] {
  return diffWorkspaceSnapshots(before, after).map((filePath) => {
    const left = before?.get(filePath);
    const right = after?.get(filePath);
    const exists = (entry: WorkspaceFileSignature) => entry.fingerprint !== "unavailable:ENOENT";
    const added = (entry: WorkspaceFileSignature) => entry.status === "??" || entry.status.includes("A");
    return {
      filePath,
      beforeExists: left ? exists(left) : right ? !added(right) : true,
      afterExists: right ? exists(right) : left ? !added(left) : true,
    };
  });
}

const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "code_search",
  "subagent",
]);

/** 未知工具默认可能写；CodeGraph 当前全部是查询类工具。 */
export function mayMutateWorkspace(toolName: string): boolean {
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
  if (toolName === "codegraph" || toolName.startsWith("codegraph_")) return false;
  return true;
}

export async function runTrackedWorkspaceMutation<T>(options: {
  cwd: string;
  signal: AbortSignal;
  filePaths?: string[];
  operation: () => Promise<T>;
}): Promise<{ value: T; changedFiles: string[]; fileChanges: FileChange[] }> {
  const files = options.filePaths ?? [];
  const directories = [options.cwd, ...files.flatMap((file) => [
    existingParentDirectory(file), existingParentDirectory(canonicalMutationPath(file)),
  ])];
  return workspaceMutationCoordinator.runExclusiveWorkspaces(directories, options.signal, () =>
    workspaceMutationCoordinator.runExclusiveFiles(files, options.signal, async () => {
      const before = await readWorkspaceSnapshot(options.cwd);
      const explicitBefore = await readExplicitFileSnapshot(files);
      const value = await options.operation();
      const explicitAfter = await readExplicitFileSnapshot(files);
      const after = await readWorkspaceSnapshot(options.cwd);
      const explicitChanged = files.filter((file) => {
        const left = explicitBefore.get(file);
        const right = explicitAfter.get(file);
        return left != null && right != null && left !== right;
      });
      const fileChanges = new Map(workspaceFileChanges(before, after).map((change) => [change.filePath, change]));
      for (const filePath of explicitChanged) {
        fileChanges.set(filePath, {
          filePath,
          beforeExists: !explicitBefore.get(filePath)!.startsWith("unavailable:ENOENT|"),
          afterExists: !explicitAfter.get(filePath)!.startsWith("unavailable:ENOENT|"),
        });
      }
      return { value, changedFiles: [...fileChanges.keys()], fileChanges: [...fileChanges.values()] };
    }));
}
