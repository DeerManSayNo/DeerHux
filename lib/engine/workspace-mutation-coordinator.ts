import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";

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
    signal.throwIfAborted();
    const key = await resolveWorkspaceKey(cwd, signal);
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

const globalForCoordinator = globalThis as unknown as {
  __deerhuxWorkspaceMutationCoordinator?: WorkspaceMutationCoordinator;
};

export const workspaceMutationCoordinator = globalForCoordinator.__deerhuxWorkspaceMutationCoordinator
  ?? (globalForCoordinator.__deerhuxWorkspaceMutationCoordinator = new WorkspaceMutationCoordinator());

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
  operation: () => Promise<T>;
}): Promise<{ value: T; changedFiles: string[] }> {
  return workspaceMutationCoordinator.runExclusive(options.cwd, options.signal, async () => {
    const before = await readWorkspaceSnapshot(options.cwd);
    const value = await options.operation();
    const after = await readWorkspaceSnapshot(options.cwd);
    return { value, changedFiles: diffWorkspaceSnapshots(before, after) };
  });
}
