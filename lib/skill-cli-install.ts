import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cliInstallCommand } from "./skill-cli-installers";
import { hasCli } from "./skill-cli";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 300_000;

export async function findNpmCli(): Promise<string> {
  const nodeDir = path.dirname(process.execPath);
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir));
  if (process.platform !== "win32") dirs.push("/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin"));
  const candidates = [
    path.join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    path.join(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const dir of dirs) {
    if (process.platform === "win32") {
      candidates.push(path.join(dir, "node_modules/npm/bin/npm-cli.js"));
    } else {
      try {
        const resolved = await realpath(path.join(dir, "npm"));
        if (path.basename(resolved) === "npm-cli.js") candidates.push(resolved);
      } catch { /* Try the next Node installation. */ }
    }
  }
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Continue. */ }
  }
  throw new Error("未找到 npm。请先安装 Node.js，重启 DeerHux 后重试。");
}

async function executeInstaller(command: string): Promise<string> {
  const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH ?? process.env.Path ?? ""].join(path.delimiter), FORCE_COLOR: "0" };
  const options = { cwd: homedir(), env, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 };
  if (command === "webcmd") {
    const npmCli = await findNpmCli();
    const result = await execFileAsync(process.execPath, [npmCli, "install", "--global", "@agentrhq/webcmd"], options);
    return result.stdout + result.stderr;
  }
  if (command === "tvly") {
    const directory = await mkdtemp(path.join(tmpdir(), "deerhux-tavily-install-"));
    try {
      const response = await fetch("https://cli.tavily.com/install.sh", { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`下载安装脚本失败：HTTP ${response.status}`);
      const script = path.join(directory, "install.sh");
      await writeFile(script, await response.text(), { mode: 0o600 });
      // Same official installer as curl | bash, with no interpolated shell commands.
      const result = await execFileAsync("/bin/bash", [script], options);
      return result.stdout + result.stderr;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  throw new Error("此 CLI 尚未配置自动安装方式");
}

export interface CliInstallResult { available: boolean; output: string }
export function createCliInstaller(
  execute: (command: string) => Promise<string> = executeInstaller,
  detect: (command: string) => Promise<boolean> = hasCli,
) {
  const pending = new Map<string, Promise<CliInstallResult>>();
  return (command: string): Promise<CliInstallResult> => {
    if (!cliInstallCommand(command)) return Promise.reject(new Error("此 CLI 不支持自动安装"));
    const existing = pending.get(command);
    if (existing) return existing;
    const job = (async () => {
      if (await detect(command)) return { available: true, output: "CLI 已安装" };
      const output = await execute(command);
      return { available: await detect(command), output: output.slice(-12_000) };
    })().finally(() => pending.delete(command));
    pending.set(command, job);
    return job;
  };
}

// Preserve in-flight installs across development reloads and multiple requests.
const globals = globalThis as typeof globalThis & { deerhuxCliInstaller?: ReturnType<typeof createCliInstaller> };
export const installSkillCli = globals.deerhuxCliInstaller ??= createCliInstaller();
