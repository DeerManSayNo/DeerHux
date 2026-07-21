import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const RUNS_BASE_DIR = path.join(os.tmpdir(), "deerhux-runs");

/**
 * Check if a directory is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory for a given path.
 */
function getGitRoot(cwd: string): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8" }).trim();
}

/**
 * Ensure the base runs directory exists.
 */
function ensureRunsDir(): string {
  const runDir = path.join(RUNS_BASE_DIR, `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
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

  execSync(`git worktree add "${worktreePath}" ${headRef}`, { cwd: gitRoot, stdio: "pipe" });

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
export function removeWorktree(worktreePath: string, gitRoot: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: gitRoot, stdio: "pipe" });
  } catch {
    // Clean up manually if worktree remove fails
    try {
      const lockFile = path.join(gitRoot, ".git", "worktrees", path.basename(worktreePath), "locked");
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: gitRoot, stdio: "pipe" });
    } catch {
      // Best effort cleanup
    }
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

/**
 * Generate a diff for a worker's worktree against the main cwd.
 */
export function generateDiff(worktreePath: string): { diff: string; stats: string } {
  try {
    const diff = execSync("git diff HEAD", { cwd: worktreePath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const stats = execSync("git diff --stat HEAD", { cwd: worktreePath, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { diff, stats };
  } catch {
    return { diff: "", stats: "" };
  }
}

/**
 * Apply a patch from a worktree to the main cwd.
 * Returns { success, conflict }.
 */
/**
 * Validate externally-supplied file pathspecs before passing to git.
 * Rejects: NUL bytes, absolute paths (POSIX & Windows), parent traversal,
 * option-like ("-…") and pathspec-magic (":…") prefixes, empty segments.
 * Returns sanitized relative paths safe to use after git's "--" separator.
 */
function validatePatchFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined; // preserve full-diff behavior
  const result: string[] = [];
  for (const raw of files) {
    if (typeof raw !== "string") {
      throw new Error("Invalid file entry: not a string");
    }
    const f = raw; // intentionally NOT trimmed — preserve spaces in filenames
    if (f.length === 0 || /^\s*$/.test(f)) continue;
    if (f.includes("\0")) {
      throw new Error("Invalid file path: contains NUL byte");
    }
    // POSIX absolute
    if (f.startsWith("/")) {
      throw new Error(`Invalid file path: absolute path not allowed: ${JSON.stringify(raw)}`);
    }
    // Windows absolute: drive letter or UNC
    if (/^[a-zA-Z]:[\\/]/.test(f) || f.startsWith("\\\\")) {
      throw new Error(`Invalid file path: absolute path not allowed: ${JSON.stringify(raw)}`);
    }
    // Reject option-like and pathspec-magic prefixes
    if (f.startsWith("-")) {
      throw new Error(`Invalid file path: looks like a git option: ${JSON.stringify(raw)}`);
    }
    if (f.startsWith(":")) {
      throw new Error(`Invalid file path: looks like git pathspec magic: ${JSON.stringify(raw)}`);
    }
    // Reject parent traversal on any segment
    const segments = f.replace(/\\/g, "/").split("/");
    if (segments.includes("..") || segments.includes(".")) {
      throw new Error(`Invalid file path: parent/current reference not allowed: ${JSON.stringify(raw)}`);
    }
    result.push(f);
  }
  return result;
}

export function applyPatch(mainCwd: string, worktreePath: string, files?: string[]): { success: boolean; error?: string } {
  try {
    // Validate externally-supplied pathspecs to prevent option injection / traversal
    const pathspecs = validatePatchFiles(files);
    if (files !== undefined && pathspecs !== undefined && pathspecs.length === 0) {
      return { success: false, error: "Empty file selection: no valid paths to apply" };
    }
    const diff = execFileSync("git", ["diff", "HEAD", "--", ...(pathspecs ?? [])], {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!diff.trim()) {
      return { success: true };
    }

    // Check working tree is clean
    const status = execSync("git status --porcelain", { cwd: mainCwd, encoding: "utf8" });
    if (status.trim()) {
      // Try to apply anyway but warn about potential conflicts
      execSync("git apply", { cwd: mainCwd, input: diff, stdio: "pipe" });
    } else {
      execSync("git apply", { cwd: mainCwd, input: diff, stdio: "pipe" });
    }

    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Check if it's a merge conflict
    if (errMsg.includes("patch does not apply") || errMsg.includes("conflict")) {
      return { success: false, error: `Patch conflict: ${errMsg.split("\n")[0]}` };
    }

    return { success: false, error: errMsg.split("\n")[0] };
  }
}

/**
 * Create worktree setup for all workers in a run.
 * Returns { runDir, gitRoot, isGit }
 */
export function setupIsolatedWorkspace(
  cwd: string,
  workerNames: string[],
): { runDir: string; gitRoot: string | null; isGit: boolean; worktrees: Map<string, string> } {
  const git = isGitRepo(cwd);
  const runDir = ensureRunsDir();
  const gitRoot = git ? getGitRoot(cwd) : null;
  const worktrees = new Map<string, string>();

  for (const name of workerNames) {
    if (git) {
      const wPath = createWorktree(cwd, name, runDir);
      worktrees.set(name, wPath);
    } else {
      const wPath = createTempCopy(cwd, name, runDir);
      worktrees.set(name, wPath);
    }
  }

  return { runDir, gitRoot, isGit: git, worktrees };
}

/**
 * Clean up all worktrees for a run.
 */
export function cleanupWorkspace(runDir: string, gitRoot: string | null, isGit: boolean): void {
  if (isGit && gitRoot) {
    // Remove worktrees
    const entries = fs.readdirSync(runDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        removeWorktree(path.join(runDir, entry.name), gitRoot);
      }
    }
  }

  // Remove run directory
  removeTempCopy(runDir);
}

/**
 * Get the main repo's current status (for conflict detection before apply).
 */
export function getRepoStatus(cwd: string): { clean: boolean; files: string[] } {
  const status = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();
  if (!status) return { clean: true, files: [] };
  const files = status.split("\n").map(l => l.slice(3).trim()).filter(Boolean);
  return { clean: false, files };
}

/**
 * 启动期孤儿清理：扫描 /tmp/deerhux-runs/ 下所有 run 目录并删除，同时跑
 * `git worktree prune` 清理 .git/worktrees 里指向已删除目录的注册。
 *
 * 背景上一次进程崩溃 / 被杀时，正常终态回收未执行的 run 会残留 worktree 目录
 * 和 git worktree 注册（实测积攒 38 个）。本函数在进程启动时（内存 Map 为空、
 * 无并发 run）调用一次，把这些孤儿全部清掉。
 *
 * Best-effort：任何子步骤失败都静默，不影响启动。
 */
export function cleanupOrphanedRuns(): { removedDirs: number; pruned: boolean } {
  let removedDirs = 0;
  try {
    if (fs.existsSync(RUNS_BASE_DIR)) {
      const entries = fs.readdirSync(RUNS_BASE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          fs.rmSync(path.join(RUNS_BASE_DIR, entry.name), { recursive: true, force: true });
          removedDirs += 1;
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }

  // git worktree prune 清理 .git/worktrees 里指向不存在目录的注册。它自带安全机制：
  // 只删无法解析的，不会误删正在用的。对每个已知仓库跑一次太重，这里只在当前
  // 进程 cwd 若是 git 仓库时跑（instrumentation 场景下 cwd 通常是项目根）。
  let pruned = false;
  try {
    if (isGitRepo(process.cwd())) {
      execSync("git worktree prune", { stdio: "pipe" });
      pruned = true;
    }
  } catch {
    /* best effort */
  }
  return { removedDirs, pruned };
}