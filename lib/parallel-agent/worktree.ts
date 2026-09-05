import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import {
  readWorktreeManifest,
  transitionWorktreeManifest,
  worktreeDeletionEligibility,
  writeWorktreeManifestAtomic,
  type WorktreeManifestV1,
} from "./worktree-manifest";
import { runGit } from "./git-process";
import { openGitRepository } from "./git-repository";
import { getGitProcessStartMarker } from "./git-lock";
import { loadWorktreeEnvironmentConfig, prepareWorktreeEnvironment, type WorktreeEnvironmentConfig } from "./worktree-environment";
import { beginWorktreeOperation, hashWorktreeRepository, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";

const RUNS_BASE_DIR = path.join(os.tmpdir(), "deerhux-runs");
export const getIsolatedRunsRoot = (): string => RUNS_BASE_DIR;

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/**
 * Check if a directory is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await runGit({ cwd, args: ["rev-parse", "--is-inside-work-tree"], maxStdoutBytes: 1024, maxStderrBytes: 4096 });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Get the git root directory for a given path.
 */
function getGitRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

/**
 * Ensure the base runs directory exists.
 */
export function getIsolatedRunDir(runId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(runId)) throw new Error("Invalid run ID");
  return path.join(RUNS_BASE_DIR, runId);
}

function ensureRunsDir(runId: string): string {
  fs.mkdirSync(RUNS_BASE_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(RUNS_BASE_DIR).isSymbolicLink()) throw new Error("Runs directory must not be a symbolic link");
  const runDir = getIsolatedRunDir(runId);
  fs.mkdirSync(runDir, { mode: 0o700 });
  return runDir;
}

/*
 * Sanitize a worker name into a filesystem-safe path segment.
 * Parallel mode uses Chinese names like "方案 A/B/C" which all sanitize to
 * the same string, so callers must dedupe via allocateSafeName below.
 */
function sanitizeWorkerName(workerName: string): string {
  return workerName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "worker";
}

/*
 * Allocate a unique safe name within a run directory. Repeated collisions
 * (e.g. parallel mode's "方案 A/B/C" all sanitizing to "_") get a numeric
 * suffix so each worker gets its own worktree path.
 */
function allocateSafeName(workerName: string, runDir: string): string {
  const base = sanitizeWorkerName(workerName);
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(path.join(runDir, candidate))) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

/**
 * Create a git worktree for a worker.
 * Returns the worktree path.
 */
export function createWorktree(cwd: string, workerName: string, runDir: string): string {
  const safeName = allocateSafeName(workerName, runDir);
  const worktreePath = path.join(runDir, safeName);
  const gitRoot = getGitRoot(cwd);
  const headRef = "HEAD";

  execFileSync("git", ["worktree", "add", worktreePath, headRef], { cwd: gitRoot, stdio: "pipe" });

  return worktreePath;
}

/**
 * Create a temp directory copy for non-git projects.
 * Returns the temp directory path.
 */
export function createTempCopy(cwd: string, workerName: string, runDir: string): string {
  const safeName = allocateSafeName(workerName, runDir);
  const destPath = path.join(runDir, safeName);
  fs.cpSync(cwd, destPath, { recursive: true });
  return destPath;
}

/**
 * Remove a git worktree.
 */
export function removeWorktree(worktreePath: string, gitRoot: string): boolean {
  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd: gitRoot, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up a temp directory.
 */
export function removeTempCopy(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

export function applyPatch(_mainCwd: string, _worktreePath: string, _files?: string[]): { success: false; error: string } {
  return { success: false, error: "Legacy patch apply is disabled; atomic artifact apply is required" };
}

/**
 * Create worktree setup for all workers in a run.
 * Returns { runDir, gitRoot, isGit }
 */
export async function setupIsolatedWorkspace(...args: Parameters<typeof setupIsolatedWorkspaceInternal>): ReturnType<typeof setupIsolatedWorkspaceInternal> {
  const operation = beginWorktreeOperation("setup", { runId: args[1], repoHash: hashWorktreeRepository(args[0]) });
  try {
    const result = await setupIsolatedWorkspaceInternal(...args);
    operation.finish("completed");
    return result;
  } catch (error) {
    let preservedCount = 0;
    try {
      const latest = readWorktreeManifest(path.join(getIsolatedRunDir(args[1]), "worktree-manifest.json"));
      if (latest.kind === "ok") preservedCount = latest.manifest.workers.filter((worker) => worker.state === "preserved" || worker.state === "cleanup_error").length;
    } catch { /* Diagnostics must never replace the setup failure. */ }
    operation.finish(args[4]?.signal?.aborted ? "aborted" : "failed", { reason: worktreeDiagnosticReason(error), preservedCount });
    throw error;
  }
}

async function setupIsolatedWorkspaceInternal(
  cwd: string,
  runId: string,
  instanceId: string,
  workers: Array<{ workerId: string; displayName: string }>,
  options: {
    signal?: AbortSignal;
    /** Trusted host/test injection only; never accepted from tool request payloads. */
    environmentConfig?: WorktreeEnvironmentConfig;
    environmentAgentDir?: string;
    onStep?: (step: "before_add" | "after_branch_command" | "after_add" | "after_verify" | "before_worktree_query" | "before_branch_query" | "before_branch_remove" | "before_run_dir_remove", workerIndex: number) => void;
    onManifestWrite?: (writeIndex: number) => void;
  } = {},
): Promise<{ runDir: string; gitRoot: string; isGit: true; worktrees: Map<string, string>; agentCwds: Map<string, string>; manifestPath: string; baseCommit: string }> {
  if (workers.length < 1 || workers.length > 5) throw new Error("Worker count must be between 1 and 5");
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) throw new Error("Worker IDs must be unique");
  for (const worker of workers) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(worker.workerId)) throw new Error("Worker ID is invalid");
    if (!worker.displayName.trim() || worker.displayName.length > 120) throw new Error("Worker display name is invalid");
  }
  const repository = await openGitRepository(cwd, { instanceId, signal: options.signal });
  const environmentConfig = await loadWorktreeEnvironmentConfig(repository.root, { agentDir: options.environmentAgentDir, config: options.environmentConfig });
  return repository.withWriteLock({ operation: "worktree_setup", signal: options.signal }, async () => {
  const gitRoot = repository.root;
  const gitCommonDir = repository.commonDir;
  fs.mkdirSync(RUNS_BASE_DIR, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(RUNS_BASE_DIR).isSymbolicLink()) throw new Error("Runs directory must not be a symbolic link");
  const runsRoot = fs.realpathSync(RUNS_BASE_DIR);
  const runsRootStat = fs.statSync(runsRoot);
  if (typeof process.getuid === "function" && runsRootStat.uid !== process.getuid()) throw new Error("Runs directory has a different owner");
  if (pathsOverlap(gitRoot, runsRoot) || pathsOverlap(runsRoot, gitRoot)
    || pathsOverlap(gitCommonDir, runsRoot) || pathsOverlap(runsRoot, gitCommonDir)) {
    throw new Error("Isolated runs directory overlaps repository metadata");
  }
  const lockedStatus = (await repository.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    maxStdoutBytes: 4 * 1024 * 1024,
  })).stdout;
  if (lockedStatus) throw new Error(`GIT_DIRTY_WORKTREE: source repository has ${lockedStatus.split("\0").filter(Boolean).length} changed file(s)`);
  const sourceCwdRelative = repository.sourceRelativePath || ".";
  const baseCommit = repository.baseCommit;
  const runDir = ensureRunsDir(runId);
  const canonicalRunDir = fs.realpathSync(runDir);
  if (canonicalRunDir !== path.join(runsRoot, runId)) throw new Error("Run directory escaped the isolated runs root");
  const runDirIdentity = fs.lstatSync(runDir);
  const removeOwnedRunDir = (): void => {
    const current = fs.lstatSync(runDir);
    if (current.isSymbolicLink() || current.dev !== runDirIdentity.dev || current.ino !== runDirIdentity.ino) {
      throw new Error("Run directory identity changed during setup");
    }
    fs.rmSync(runDir, { recursive: true });
  };
  const worktrees = new Map<string, string>();
  const agentCwds = new Map<string, string>();
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  const now = new Date().toISOString();
  let manifest: WorktreeManifestV1 = {
    version: 1,
    implementationVersion: 2,
    runId,
    instanceId,
    ownerPid: process.pid,
    processStartIdentity: getGitProcessStartMarker(),
    heartbeatAt: now,
    activeOperation: "setup",
    repoRoot: gitRoot,
    gitCommonDir,
    sourceCwdRelative,
    baseCommit,
    state: "planning",
    workers: workers.map((worker, index) => ({
      workerId: worker.workerId,
      displayName: worker.displayName,
      index,
      worktreePath: path.join(runDir, `${index + 1}-${worker.workerId}`),
      agentCwd: path.join(runDir, `${index + 1}-${worker.workerId}`, sourceCwdRelative === "." ? "" : sourceCwdRelative),
      branch: `deerhux/${runId}/${index + 1}-${worker.workerId}`,
      provider: "inherited",
      state: "planned",
      capture: null,
      cleanup: null,
    })),
    apply: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
  let manifestWriteIndex = 0;
  const persistManifest = (): void => {
    const writeIndex = manifestWriteIndex;
    manifestWriteIndex += 1;
    options.onManifestWrite?.(writeIndex);
    writeWorktreeManifestAtomic(manifestPath, manifest);
  };
  const createdWorkers: typeof manifest.workers = [];
  const ownedBranches = new Set<string>();
  const hookAttemptedWorkers = new Set<string>();
  let addAttempted = false;
  let attemptedWorker: (typeof manifest.workers)[number] | undefined;
  try {
    persistManifest();
    manifest = transitionWorktreeManifest(manifest, "setting_up", { caller: "setup", now: new Date().toISOString() });
    persistManifest();
    for (const worker of manifest.workers) {
      options.signal?.throwIfAborted();
      worker.state = "creating";
      manifest.updatedAt = new Date().toISOString();
      persistManifest();
      await repository.run(["check-ref-format", "--branch", worker.branch], { maxStdoutBytes: 4096, maxStderrBytes: 4096 });
      options.onStep?.("before_add", worker.index);
      const refName = `refs/heads/${worker.branch}`;
      addAttempted = true;
      attemptedWorker = worker;
      await repository.run(["update-ref", refName, baseCommit, "0".repeat(40)]);
      options.onStep?.("after_branch_command", worker.index);
      ownedBranches.add(worker.workerId);
      await repository.run(["worktree", "add", worker.worktreePath, worker.branch], { timeoutMs: 60_000 });
      createdWorkers.push(worker);
      attemptedWorker = undefined;
      options.onStep?.("after_add", worker.index);
      const actualHead = (await repository.run(["rev-parse", "HEAD"], { cwd: worker.worktreePath, maxStdoutBytes: 4096 })).stdout.trim();
      if (actualHead !== baseCommit) throw new Error("Created worktree HEAD does not match persisted base commit");
      const workerCommonDir = fs.realpathSync((await repository.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: worker.worktreePath,
        maxStdoutBytes: 4096,
      })).stdout.trim());
      if (workerCommonDir !== gitCommonDir) throw new Error("Created worktree has a different Git common directory");
      options.onStep?.("after_verify", worker.index);
      const worktreeRoot = fs.realpathSync(worker.worktreePath);
      const agentCwd = fs.realpathSync(worker.agentCwd);
      if (!fs.statSync(agentCwd).isDirectory() || !pathsOverlap(worktreeRoot, agentCwd)) {
        throw new Error("Worker source cwd is outside the created worktree");
      }
      worker.worktreePath = worktreeRoot;
      worker.agentCwd = agentCwd;
      if (environmentConfig.mode === "hook") hookAttemptedWorkers.add(worker.workerId);
      worker.environment = await prepareWorktreeEnvironment({
        repoRoot: gitRoot, worktreePath: worker.worktreePath, agentCwd: worker.agentCwd,
        baseCommit, workerId: worker.workerId, config: environmentConfig, signal: options.signal,
      });
      options.signal?.throwIfAborted();
      worker.state = "running";
      worktrees.set(worker.workerId, worker.worktreePath);
      agentCwds.set(worker.workerId, worker.agentCwd);
      manifest.updatedAt = new Date().toISOString();
      persistManifest();
    }
    manifest = transitionWorktreeManifest(manifest, "running", { caller: "setup", now: new Date().toISOString() });
    manifest.heartbeatAt = manifest.updatedAt;
    manifest.activeOperation = "running";
    persistManifest();
  } catch (error) {
    let rollbackComplete = true;
    const rollbackWorkers = [...createdWorkers];
    if (attemptedWorker && !rollbackWorkers.includes(attemptedWorker)) rollbackWorkers.push(attemptedWorker);
    for (const worker of rollbackWorkers.reverse()) {
      const checkedAt = new Date().toISOString();
      worker.cleanup = {
        intent: "setup_rollback",
        eligibility: "eligible",
        checkedAt,
        worktreeRemoved: false,
        branchRemoved: false,
        reason: "setup_failed",
      };
      try { persistManifest(); } catch { rollbackComplete = false; break; }
      let registered = true;
      try {
        options.onStep?.("before_worktree_query", worker.index);
        const registrations = (await repository.run(["worktree", "list", "--porcelain"], { maxStdoutBytes: 1024 * 1024 })).stdout;
        registered = registrations.split("\n").some((line) => line === `worktree ${worker.worktreePath}`);
      } catch (queryError) {
        rollbackComplete = false;
        worker.state = "cleanup_error";
        worker.cleanup.reason = `worktree_query_failed:${queryError instanceof Error ? queryError.name : "unknown"}`;
        try { persistManifest(); } catch { /* keep processing other workers */ }
        continue;
      }
      if (hookAttemptedWorkers.has(worker.workerId)) {
        // A trusted hook can leave ignored files, commits, or background writers.
        // No writer freeze is available here: preserve even a momentarily clean
        // directory instead of authorizing a destructive force-removal.
        rollbackComplete = false;
        worker.state = "preserved";
        worker.cleanup.eligibility = "manual_review";
        worker.cleanup.reason = "environment_hook_retained";
        try { persistManifest(); } catch { /* keep processing other workers */ }
        continue;
      }
      if (!registered && !fs.existsSync(worker.worktreePath)) worker.cleanup.worktreeRemoved = true;
      else try {
          await repository.run(["worktree", "remove", worker.worktreePath, "--force"], { timeoutMs: 60_000 });
          worker.cleanup.worktreeRemoved = true;
        } catch (removeError) {
          rollbackComplete = false;
          worker.state = "cleanup_error";
          worker.cleanup.reason = `worktree_remove_failed:${removeError instanceof Error ? removeError.name : "unknown"}`;
        }
      if (worker.cleanup.worktreeRemoved) {
        const refName = `refs/heads/${worker.branch}`;
        let branchOid: string;
        try {
          options.onStep?.("before_branch_query", worker.index);
          branchOid = (await repository.run(["for-each-ref", "--format=%(objectname)", refName], { maxStdoutBytes: 4096 })).stdout.trim();
        } catch (queryError) {
          rollbackComplete = false;
          worker.state = "cleanup_error";
          worker.cleanup.reason = `branch_query_failed:${queryError instanceof Error ? queryError.name : "unknown"}`;
          try { persistManifest(); } catch { /* keep processing other workers */ }
          continue;
        }
        if (!branchOid) worker.cleanup.branchRemoved = true;
        else if (!ownedBranches.has(worker.workerId)) {
          rollbackComplete = false;
          worker.state = "cleanup_error";
          worker.cleanup.reason = "branch_ownership_uncertain";
        }
        else if (branchOid !== baseCommit) {
          rollbackComplete = false;
          worker.state = "cleanup_error";
          worker.cleanup.reason = "branch_oid_changed";
        } else {
        try {
          options.onStep?.("before_branch_remove", worker.index);
          await repository.run(["update-ref", "-d", refName, baseCommit]);
          worker.cleanup.branchRemoved = true;
        } catch (branchError) {
          rollbackComplete = false;
          worker.state = "cleanup_error";
          worker.cleanup.reason = `branch_remove_failed:${branchError instanceof Error ? branchError.name : "unknown"}`;
        }
        }
      }
      if (worker.cleanup.worktreeRemoved && worker.cleanup.branchRemoved) worker.state = "removed";
      try { persistManifest(); } catch { rollbackComplete = false; break; }
    }
    try {
      if (rollbackComplete && rollbackWorkers.length > 0) {
        for (const worker of manifest.workers) {
          if (worker.cleanup) continue;
          const branchRef = (await repository.run(["for-each-ref", "--format=%(refname)", `refs/heads/${worker.branch}`], {
            maxStdoutBytes: 4096,
          })).stdout.trim();
          if (branchRef || fs.existsSync(worker.worktreePath)) {
            rollbackComplete = false;
            worker.state = "cleanup_error";
            continue;
          }
          worker.state = "removed";
          worker.cleanup = {
            intent: "setup_rollback",
            eligibility: "eligible",
            checkedAt: new Date().toISOString(),
            worktreeRemoved: true,
            branchRemoved: true,
            reason: "resource_not_created",
          };
        }
        const registrations = (await repository.run(["worktree", "list", "--porcelain"], { maxStdoutBytes: 1024 * 1024 })).stdout;
        if (manifest.workers.some((worker) => registrations.split("\n").includes(`worktree ${worker.worktreePath}`))) rollbackComplete = false;
        if (rollbackComplete) {
          manifest = transitionWorktreeManifest(manifest, "discarded", { caller: "cleanup", now: new Date().toISOString() });
          persistManifest();
          options.onStep?.("before_run_dir_remove", -1);
          removeOwnedRunDir();
        } else {
          manifest = transitionWorktreeManifest(manifest, "cleanup_error", { caller: "setup", now: new Date().toISOString() });
          persistManifest();
        }
      } else if (!addAttempted) {
        options.onStep?.("before_run_dir_remove", -1);
        removeOwnedRunDir();
      } else {
        manifest = transitionWorktreeManifest(manifest, "cleanup_error", { caller: "setup", now: new Date().toISOString() });
        persistManifest();
      }
    } catch { /* retain the latest durable manifest and original setup error */ }
    throw error;
  }

  return { runDir, gitRoot, isGit: true as const, worktrees, agentCwds, manifestPath, baseCommit };
  });
}

export function manifestAllowsWorkspaceCleanup(manifestPath: string): boolean {
  const result = readWorktreeManifest(manifestPath);
  if (result.kind !== "ok") return false;
  return result.manifest.workers.every((worker) => worktreeDeletionEligibility(result, worker.workerId).eligible);
}

/**
 * Clean up all worktrees for a run.
 */
export async function cleanupWorkspace(runDir: string, gitRoot: string | null, isGit: boolean): Promise<void> {
  if (isGit && gitRoot) {
    const repository = await openGitRepository(gitRoot);
    await repository.withWriteLock({ operation: "worktree_cleanup" }, async () => {
      const entries = fs.readdirSync(runDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await repository.run(["worktree", "remove", path.join(runDir, entry.name), "--force"], { timeoutMs: 60_000 });
        }
      }
    });
  }

  fs.rmSync(runDir, { recursive: true, force: true });
}

/**
 * Get the main repo's current status (for conflict detection before apply).
 */
export async function getRepoStatus(cwd: string): Promise<{ clean: boolean; files: string[] }> {
  const status = (await runGit({
    cwd,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    maxStdoutBytes: 4 * 1024 * 1024,
  })).stdout;
  if (!status) return { clean: true, files: [] };
  const files = status.split("\0").filter(Boolean).map((entry) => entry.slice(3));
  return { clean: false, files };
}

/** 启动时只统计待恢复目录。缺少持久化所有权事实时不得删除或 prune。 */
export function inspectOrphanedRuns(): { pendingDirs: number } {
  let pendingDirs = 0;
  try {
    if (fs.existsSync(RUNS_BASE_DIR)) {
      const entries = fs.readdirSync(RUNS_BASE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        pendingDirs += 1;
      }
    }
  } catch {
    /* best effort */
  }
  return { pendingDirs };
}
