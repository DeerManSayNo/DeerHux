/**
 * Worker 子进程只继承这些运行时变量。不是 OS 沙箱：同 UID 进程仍可自行
 * 读取文件/启动程序；模型认证继续留在宿主模型传输层，不放进命令环境。
 * 不接受模型参数扩展此列表，也不读取仓库中的 .env/config。
 */
export const WORKER_PROCESS_ENV_ALLOWLIST = Object.freeze([
  "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  // Windows 系统运行所需；不会继承 COMSPEC 或启动脚本变量。
  "SystemRoot", "WINDIR", "PATHEXT",
] as const);

export function buildWorkerProcessEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = Object.create(null);
  for (const name of WORKER_PROCESS_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string" && !value.includes("\0")) environment[name] = value;
  }
  environment.CI = "true";
  return Object.freeze(environment);
}
