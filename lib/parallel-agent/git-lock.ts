import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_LOCK_DIRECTORY_NAME = "deerhux-operation.lock";
export const DEFAULT_GIT_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_LOCK_STALE_MS = 120_000;

export interface GitLockMetadata {
  ownerToken: string;
  instanceId: string;
  pid: number;
  startMarker: string;
  processIdentity: string;
  createdAt: string;
  operation: string;
}

export type GitLockErrorCode = "GIT_LOCK_ABORTED" | "GIT_LOCK_IO" | "GIT_LOCK_STALE" | "GIT_LOCK_TIMEOUT";

export class GitLockError extends Error {
  readonly code: GitLockErrorCode;

  constructor(code: GitLockErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitLockError";
    this.code = code;
  }
}

export interface AcquireGitLockOptions {
  commonDir: string;
  operation: string;
  signal?: AbortSignal;
  instanceId?: string;
  timeoutMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
}

export interface GitLockHandle {
  readonly lockPath: string;
  readonly metadata: GitLockMetadata;
  release(): Promise<boolean>;
}

interface QueueState {
  tail: Promise<void>;
  pending: number;
}

const PROCESS_START_MARKER = `${process.pid}-${Date.now()}-${randomUUID()}`;
const PROCESS_MARKER_PATH = path.join(os.tmpdir(), `deerhux-git-${process.pid}.start`);
let markerReady: Promise<void> | undefined;
const queueSymbol = Symbol.for("deerhux.git-common-dir-queues");
const globalState = globalThis as typeof globalThis & Record<symbol, unknown>;
const queues = (globalState[queueSymbol] as Map<string, QueueState> | undefined) ?? new Map<string, QueueState>();
globalState[queueSymbol] = queues;

process.once("exit", () => {
  try { rmSync(PROCESS_MARKER_PATH, { force: true }); } catch { /* best-effort process cleanup */ }
});

function ensureProcessMarker(): Promise<void> {
  markerReady ??= fs.writeFile(PROCESS_MARKER_PATH, PROCESS_START_MARKER, { encoding: "utf8", mode: 0o600 });
  return markerReady;
}

function abortError(signal: AbortSignal): GitLockError {
  const message = signal.reason instanceof Error ? signal.reason.message : "Git lock acquisition aborted";
  return new GitLockError("GIT_LOCK_ABORTED", message, { cause: signal.reason });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isMetadata(value: unknown): value is GitLockMetadata {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<GitLockMetadata>;
  return typeof data.instanceId === "string"
    && typeof data.ownerToken === "string"
    && Number.isSafeInteger(data.pid) && (data.pid as number) > 0
    && typeof data.startMarker === "string"
    && typeof data.processIdentity === "string"
    && typeof data.createdAt === "string" && Number.isFinite(Date.parse(data.createdAt))
    && typeof data.operation === "string";
}

function sameOwner(left: GitLockMetadata, right: GitLockMetadata): boolean {
  return left.ownerToken === right.ownerToken
    && left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.startMarker === right.startMarker
    && left.createdAt === right.createdAt
    && left.operation === right.operation;
}

async function readMetadata(lockPath: string): Promise<GitLockMetadata | null> {
  try {
    const ownerFile = (await fs.readdir(lockPath)).find((name) => /^owner-[a-f0-9-]+\.json$/.test(name));
    if (!ownerFile) return null;
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(lockPath, ownerFile), "utf8"));
    return isMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function markerMatches(metadata: GitLockMetadata): Promise<boolean> {
  if (metadata.processIdentity.startsWith("marker:")) {
    try {
      const marker = await fs.readFile(path.join(os.tmpdir(), `deerhux-git-${metadata.pid}.start`), "utf8");
      return `marker:${marker}` === metadata.processIdentity;
    } catch {
      return false;
    }
  }
  const identity = await getProcessIdentity(metadata.pid);
  return identity === null ? processExists(metadata.pid) : identity === metadata.processIdentity;
}

export function parseLinuxProcessStartTime(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(") ");
  if (commandEnd < 0) return null;
  const fieldsFromState = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fieldsFromState[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

async function getProcessIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const startTime = parseLinuxProcessStartTime(stat);
      return startTime ? `linux:${startTime}` : null;
    }
    if (process.platform !== "win32") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      return stdout.trim() ? `${process.platform}:${stdout.trim()}` : null;
    }
  } catch { /* unavailable identity is handled conservatively */ }
  return null;
}

/** Acquire one cross-process lock for all repositories sharing a Git common directory. */
export async function acquireGitLock(options: AcquireGitLockOptions): Promise<GitLockHandle> {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  await ensureProcessMarker();
  const commonDir = await fs.realpath(options.commonDir);
  const lockPath = path.join(commonDir, GIT_LOCK_DIRECTORY_NAME);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_GIT_LOCK_STALE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const metadata: GitLockMetadata = {
    ownerToken: randomUUID(),
    instanceId: options.instanceId ?? randomUUID(),
    pid: process.pid,
    startMarker: PROCESS_START_MARKER,
    processIdentity: await getProcessIdentity(process.pid) ?? `marker:${PROCESS_START_MARKER}`,
    createdAt: new Date().toISOString(),
    operation: options.operation,
  };

  while (true) {
    if (signal?.aborted) throw abortError(signal);
    const pendingPath = `${lockPath}.${metadata.ownerToken}.pending`;
    try {
      await fs.mkdir(pendingPath, { mode: 0o700 });
      try {
        if (signal?.aborted) throw abortError(signal);
        await fs.writeFile(path.join(pendingPath, `owner-${metadata.ownerToken}.json`), `${JSON.stringify(metadata)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        if (signal?.aborted) {
          await fs.rm(pendingPath, { recursive: true, force: true });
          throw abortError(signal);
        }
        await fs.rename(pendingPath, lockPath);
      } catch (error) {
        await fs.rm(pendingPath, { recursive: true, force: true });
        if (error instanceof GitLockError) throw error;
        throw error;
      }
      let released = false;
      return {
        lockPath,
        metadata,
        async release(): Promise<boolean> {
          if (released) return false;
          released = true;
          const current = await readMetadata(lockPath);
          if (!current || !sameOwner(current, metadata)) return false;
          const tombstone = `${lockPath}.release-${metadata.ownerToken}`;
          try {
            await fs.rename(lockPath, tombstone);
            const moved = await readMetadata(tombstone);
            if (!moved || !sameOwner(moved, metadata)) {
              await fs.rename(tombstone, lockPath).catch(() => {});
              return false;
            }
            await fs.rm(tombstone, { recursive: true });
          } catch {
            return false;
          }
          return true;
        },
      };
    } catch (error) {
      if (error instanceof GitLockError) throw error;
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) {
        throw new GitLockError("GIT_LOCK_IO", `Unable to acquire Git lock at ${lockPath}`, { cause: error });
      }
    }

    const staleOwner = await readMetadata(lockPath);
    if (staleOwner && Date.now() - Date.parse(staleOwner.createdAt) >= staleMs
      && (!processExists(staleOwner.pid) || !(await markerMatches(staleOwner)))) {
      const claimToken = randomUUID();
      const reclaimPath = path.join(lockPath, `reclaim-${claimToken}.json`);
      try {
        const claimMetadata: GitLockMetadata = { ...metadata, ownerToken: claimToken, operation: "stale_reclaim" };
        writeFileSync(reclaimPath, JSON.stringify(claimMetadata), { flag: "wx", mode: 0o600 });
        const activeClaims: string[] = [];
        for (const name of await fs.readdir(lockPath)) {
          if (!/^reclaim-[a-f0-9-]+\.json$/.test(name)) continue;
          const claimPath = path.join(lockPath, name);
          try {
            const claim = JSON.parse(await fs.readFile(claimPath, "utf8")) as unknown;
            if (!isMetadata(claim)) continue;
            const staleClaim = Date.now() - Date.parse(claim.createdAt) >= staleMs
              && (!processExists(claim.pid) || !(await markerMatches(claim)));
            if (staleClaim) await fs.unlink(claimPath).catch(() => {});
            else activeClaims.push(claim.ownerToken);
          } catch { /* malformed claims remain fail-closed */ }
        }
        if (activeClaims.sort()[0] !== claimToken) continue;
        const currentOwner = await readMetadata(lockPath);
        if (currentOwner && sameOwner(currentOwner, staleOwner)) {
          const tombstone = `${lockPath}.stale-${staleOwner.ownerToken}`;
          renameSync(lockPath, tombstone);
          const moved = await readMetadata(tombstone);
          if (!moved || !sameOwner(moved, staleOwner)) {
            renameSync(tombstone, lockPath);
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!new Set(["ENOENT", "EEXIST", "ENOTEMPTY"]).has(code)) {
          throw new GitLockError("GIT_LOCK_STALE", `Git lock requires recovery coordination at ${lockPath}`, { cause: error });
        }
      } finally {
        try { unlinkSync(reclaimPath); } catch { /* claim moved with the stale directory or was already removed */ }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new GitLockError("GIT_LOCK_TIMEOUT", `Timed out waiting for Git lock at ${lockPath}`);
    }
    await delay(Math.min(Math.max(1, pollIntervalMs), Math.max(1, deadline - Date.now())), signal);
  }
}

/** FIFO serialization inside this Node process, keyed by canonical common-dir path. */
export async function runInGitQueue<T>(
  commonDir: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortError(signal);
  const key = realpathSync(commonDir);
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), pending: 0 };
    queues.set(key, state);
  }
  const predecessor = state.tail.catch(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.tail = predecessor.then(() => gate);
  state.pending += 1;

  try {
    if (signal) await Promise.race([
      predecessor,
      new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        predecessor.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
      }),
    ]);
    else await predecessor;
    if (signal?.aborted) throw abortError(signal);
    return await operation();
  } finally {
    release();
    state.pending -= 1;
    if (state.pending === 0 && queues.get(key) === state) queues.delete(key);
  }
}

export async function withGitLock<T>(
  options: AcquireGitLockOptions,
  operation: (lock: GitLockHandle) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_LOCK_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  try {
  return await runInGitQueue(options.commonDir, signal, async () => {
    const lock = await acquireGitLock({ ...options, signal });
    try {
      return await operation(lock);
    } finally {
      if (!(await lock.release())) throw new GitLockError("GIT_LOCK_IO", "Git operation completed but its lock could not be released");
    }
  });
  } catch (error) {
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new GitLockError("GIT_LOCK_TIMEOUT", `Timed out waiting for Git lock at ${options.commonDir}`, { cause: error });
    }
    throw error;
  }
}

export const getGitProcessStartMarker = (): string => PROCESS_START_MARKER;

/** Validate both PID liveness and DeerHux's per-process marker to avoid PID reuse. */
export async function isGitProcessOwnerAlive(pid: number, startMarker: string): Promise<boolean> {
  if (!processExists(pid)) return false;
  try {
    const marker = await fs.readFile(path.join(os.tmpdir(), `deerhux-git-${pid}.start`), "utf8");
    return marker === startMarker;
  } catch {
    // A live process without readable identity is treated conservatively as active.
    return true;
  }
}
