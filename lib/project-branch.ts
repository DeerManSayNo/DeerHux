import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function listProjectBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"], {
    cwd, timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  return stdout.split("\n").filter(Boolean);
}

export async function switchProjectBranch(cwd: string, branch: string): Promise<string | null> {
  if (!(await listProjectBranches(cwd)).includes(branch)) {
    throw new Error("分支不存在，请刷新分支列表后重试");
  }
  // No force, stash, reset or remote guessing: Git protects conflicting edits.
  await execFileAsync("git", ["switch", "--no-guess", "--", branch], {
    cwd, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8",
  });
  return readProjectBranch(cwd);
}

/** Also handles worktrees and unborn branches; detached HEAD has no branch. */
export async function readProjectBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      timeout: 3000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
