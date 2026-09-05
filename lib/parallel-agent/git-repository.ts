import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runGit, type GitProcessResult, type RunGitOptions } from "./git-process.ts";
import { runInGitQueue, withGitLock, type AcquireGitLockOptions } from "./git-lock.ts";

export interface GitRepositoryIdentity {
  /** Canonical root for the selected worktree. */
  root: string;
  /** Canonical common Git directory, shared by all linked worktrees. */
  commonDir: string;
  /** Canonical directory from which repository discovery was requested. */
  sourcePath: string;
  /** POSIX-style path from root to sourcePath; empty at the root. */
  sourceRelativePath: string;
  /** Full object ID of HEAD at discovery time. */
  baseCommit: string;
}

export interface GitRepositoryRunOptions extends Omit<RunGitOptions, "args" | "cwd"> {
  cwd?: string;
}

export interface GitRepositoryWriteOptions extends GitRepositoryRunOptions {
  operation: string;
  instanceId?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  pollIntervalMs?: number;
}

async function canonicalDirectory(source: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(source));
  const stat = await fs.stat(resolved);
  return stat.isDirectory() ? resolved : path.dirname(resolved);
}

async function query(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const result = await runGit({
    cwd,
    args,
    signal,
    timeoutMs: 10_000,
    readTimeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  return result.stdout.trim();
}

/** Resolve identity from Git itself, then canonicalize paths to collapse symlinks. */
export async function resolveGitRepository(cwd: string, signal?: AbortSignal): Promise<GitRepositoryIdentity> {
  const sourcePath = await canonicalDirectory(cwd);
  const queries = await Promise.allSettled([
    query(sourcePath, ["rev-parse", "--show-toplevel"], signal),
    query(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
    query(sourcePath, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
  ]);
  const failed = queries.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  const [rootOutput, commonOutput, baseCommit] = queries.map((result) => (result as PromiseFulfilledResult<string>).value);
  const root = await fs.realpath(path.resolve(sourcePath, rootOutput));
  const commonDir = await fs.realpath(path.resolve(sourcePath, commonOutput));
  const nativeRelative = path.relative(root, sourcePath);
  if (nativeRelative === ".." || nativeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(nativeRelative)) {
    throw new Error(`Git source path is outside its worktree root: ${sourcePath}`);
  }
  return {
    root,
    commonDir,
    sourcePath,
    sourceRelativePath: nativeRelative.split(path.sep).join("/"),
    baseCommit,
  };
}

export const discoverGitRepository = resolveGitRepository;

/** Repository-scoped facade. Writes are serialized both in-process and across processes. */
export class GitRepository {
  readonly identity: GitRepositoryIdentity;
  readonly instanceId: string;

  private constructor(identity: GitRepositoryIdentity, instanceId?: string) {
    this.identity = identity;
    this.instanceId = instanceId ?? randomUUID();
  }

  static async open(cwd: string, options: { signal?: AbortSignal; instanceId?: string } = {}): Promise<GitRepository> {
    return new GitRepository(await resolveGitRepository(cwd, options.signal), options.instanceId);
  }

  get root(): string { return this.identity.root; }
  get commonDir(): string { return this.identity.commonDir; }
  get sourcePath(): string { return this.identity.sourcePath; }
  get sourceRelativePath(): string { return this.identity.sourceRelativePath; }
  get baseCommit(): string { return this.identity.baseCommit; }

  run(args: readonly string[], options: GitRepositoryRunOptions = {}): Promise<GitProcessResult> {
    return runGit({ ...options, cwd: options.cwd ?? this.sourcePath, args });
  }

  runQueued<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return runInGitQueue(this.commonDir, signal, operation);
  }

  runWrite(
    args: readonly string[],
    options: GitRepositoryWriteOptions,
  ): Promise<GitProcessResult> {
    const lockOptions: AcquireGitLockOptions = {
      commonDir: this.commonDir,
      operation: options.operation,
      signal: options.signal,
      instanceId: options.instanceId ?? this.instanceId,
      timeoutMs: options.lockTimeoutMs,
      staleMs: options.staleLockMs,
      pollIntervalMs: options.pollIntervalMs,
    };
    const { operation: _operation, instanceId: _instanceId, lockTimeoutMs: _lockTimeoutMs,
      staleLockMs: _staleLockMs, pollIntervalMs: _pollIntervalMs, ...processOptions } = options;
    return withGitLock(lockOptions, () => this.run(args, processOptions));
  }

  withWriteLock<T>(
    options: Omit<AcquireGitLockOptions, "commonDir" | "instanceId"> & { instanceId?: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return withGitLock({
      ...options,
      commonDir: this.commonDir,
      instanceId: options.instanceId ?? this.instanceId,
    }, operation);
  }
}

export async function openGitRepository(
  cwd: string,
  options: { signal?: AbortSignal; instanceId?: string } = {},
): Promise<GitRepository> {
  return GitRepository.open(cwd, options);
}
