import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-process.ts";

export type WorktreeEnvironmentMode = "none" | "hook" | "isolated-install";
export interface WorktreeEnvironmentConfig {
  mode: WorktreeEnvironmentMode;
  script?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  envAllowlist?: string[];
}
export interface SyntheticPathIdentity { path: string; kind: "file" | "directory"; dev: number; ino: number }
export interface PreparedWorktreeEnvironment {
  mode: "none" | "hook";
  syntheticPaths: string[];
  syntheticIdentities: SyntheticPathIdentity[];
}
export type WorktreeEnvironmentErrorCode =
  | "ENV_CONFIG_INVALID" | "ENV_CONFIG_UNAVAILABLE" | "ENV_MODE_UNSUPPORTED"
  | "ENV_REPOSITORY_MISMATCH" | "ENV_HOOK_INVALID" | "ENV_HOOK_NOT_TRACKED"
  | "ENV_HOOK_CHANGED" | "ENV_HOOK_FAILED" | "ENV_HOOK_TIMEOUT" | "ENV_HOOK_OUTPUT_LIMIT"
  | "ENV_ABORTED" | "ENV_OUTPUT_INVALID" | "ENV_SYNTHETIC_INVALID" | "ENV_INTERNAL";
export class WorktreeEnvironmentError extends Error {
  readonly code: WorktreeEnvironmentErrorCode;
  constructor(code: WorktreeEnvironmentErrorCode) {
    super(code);
    this.name = "WorktreeEnvironmentError";
    this.code = code;
  }
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
const CONFIG_KEYS = new Set(["mode", "script", "timeoutMs", "maxOutputBytes", "envAllowlist"]);
const SENSITIVE_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|KEY|BEARER|SESSION|COOKIE|CERT|SSH|GPG|AWS|AZURE|GOOGLE|OPENAI|ANTHROPIC|DATABASE_URL|DB_URL|REDIS_URL|MONGO.*URI|POSTGRES.*URL|CONNECTION_STRING|DSN|NETRC|KUBECONFIG/i;
const INJECTION_ENV = /^(?:NODE_|LD_|DYLD_|GIT_|NPM_|YARN_|PNPM_|PYTHON|RUBY|PERL)|^(?:PATH|HOME|USERPROFILE|SHELL|ENV|BASH_ENV|IFS|COMSPEC|PATHEXT|SYSTEMROOT|WINDIR)$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorktreeEnvironmentError("ENV_ABORTED");
}
function relativePath(value: unknown, code: WorktreeEnvironmentErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value !== value.trim()
    || /[\0-\x1f\x7f\\:]/.test(value) || path.posix.isAbsolute(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || /^\.git$/i.test(segment))) {
    throw new WorktreeEnvironmentError(code);
  }
  return value;
}
function configFrom(value: unknown): WorktreeEnvironmentConfig {
  if (!record(value) || Object.keys(value).some((key) => !CONFIG_KEYS.has(key))
    || !["none", "hook", "isolated-install"].includes(String(value.mode))) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
  if (value.mode === "isolated-install") throw new WorktreeEnvironmentError("ENV_MODE_UNSUPPORTED");
  if (value.mode === "none") {
    if (Object.keys(value).some((key) => key !== "mode")) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
    return { mode: "none" };
  }
  const script = relativePath(value.script, "ENV_CONFIG_INVALID");
  if (!/\.(?:cjs|mjs|js)$/.test(script)) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
  const timeoutMs = value.timeoutMs ?? 30_000;
  const maxOutputBytes = value.maxOutputBytes ?? 64 * 1024;
  const envAllowlist = value.envAllowlist ?? [];
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 300_000
    || !Number.isSafeInteger(maxOutputBytes) || Number(maxOutputBytes) < 1 || Number(maxOutputBytes) > MAX_HOOK_OUTPUT_BYTES
    || !Array.isArray(envAllowlist) || envAllowlist.length > 32 || new Set(envAllowlist).size !== envAllowlist.length
    || envAllowlist.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || SENSITIVE_ENV.test(name) || INJECTION_ENV.test(name))) {
    throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
  }
  return { mode: "hook", script, timeoutMs: Number(timeoutMs), maxOutputBytes: Number(maxOutputBytes), envAllowlist: [...envAllowlist] as string[] };
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function boundedRead(filePath: string, maximum: number, code: WorktreeEnvironmentErrorCode): Promise<Buffer> {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum || before.size < 0
      || (typeof process.getuid === "function" && before.uid !== process.getuid()) || (before.mode & 0o022) !== 0) throw new WorktreeEnvironmentError(code);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (read.bytesRead <= 0) throw new WorktreeEnvironmentError(code);
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new WorktreeEnvironmentError(code);
    return bytes;
  } finally { await handle.close(); }
}

/** User-owned opt-in only; repositories cannot enable hooks using a checked-in file. */
export async function loadWorktreeEnvironmentConfig(repoRoot: string, options: {
  agentDir?: string; configPath?: string; config?: WorktreeEnvironmentConfig;
} = {}): Promise<WorktreeEnvironmentConfig> {
  if (options.config !== undefined) return configFrom(options.config);
  try {
    const root = await fsp.realpath(repoRoot);
    const agentDir = options.agentDir ?? (await import("@earendil-works/pi-coding-agent")).getAgentDir();
    const configPath = path.resolve(options.configPath ?? path.join(agentDir, "worktree-environments.json"));
    // A configured agent directory inside this repository is not a trusted opt-in source.
    if (within(root, configPath)) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
    let bytes: Buffer;
    try { bytes = await boundedRead(configPath, MAX_CONFIG_BYTES, "ENV_CONFIG_INVALID"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "none" };
      throw error;
    }
    if (within(root, await fsp.realpath(configPath))) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
    const document: unknown = JSON.parse(bytes.toString("utf8"));
    if (!record(document) || document.version !== 1 || !record(document.repositories)
      || Object.keys(document).some((key) => key !== "version" && key !== "repositories")
      || Object.keys(document.repositories).length > 128) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
    return Object.hasOwn(document.repositories, root) ? configFrom(document.repositories[root]) : { mode: "none" };
  } catch (error) {
    if (error instanceof WorktreeEnvironmentError) throw error;
    throw new WorktreeEnvironmentError(error instanceof SyntaxError ? "ENV_CONFIG_INVALID" : "ENV_CONFIG_UNAVAILABLE");
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal, stdin?: Buffer): Promise<string> {
  aborted(signal);
  return (await runGit({ cwd, args, signal, stdin, timeoutMs: 10_000, maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 64 * 1024 })).stdout;
}

async function safeNode(root: string, relative: string, code: WorktreeEnvironmentErrorCode, allowMissing = false): Promise<fs.Stats | null> {
  let current = root;
  for (const segment of relative.split("/")) {
    const parent = current;
    current = path.join(parent, segment);
    let stat: fs.Stats;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WorktreeEnvironmentError(code);
    }
    // Case-insensitive/normalizing filesystems may resolve an alias that Git's
    // literal path filtering does not exclude. Require the directory's actual spelling.
    let exactEntry = false;
    try {
      for await (const entry of await fsp.opendir(parent)) {
        if (entry.name === segment) { exactEntry = true; break; }
      }
    } catch { throw new WorktreeEnvironmentError(code); }
    if (!exactEntry) throw new WorktreeEnvironmentError(code);
    if (stat.isSymbolicLink() || !stat.isDirectory() && current !== path.join(root, relative)) throw new WorktreeEnvironmentError(code);
    if (current === path.join(root, relative)) return stat;
  }
  throw new WorktreeEnvironmentError(code);
}

export async function validateSyntheticPaths(options: {
  worktreePath: string; baseCommit: string; paths: readonly string[];
  expectedIdentities?: readonly SyntheticPathIdentity[]; allowMissing?: boolean; signal?: AbortSignal;
}): Promise<SyntheticPathIdentity[]> {
  try {
    aborted(options.signal);
    if (!Array.isArray(options.paths) || options.paths.length > 128 || new Set(options.paths).size !== options.paths.length
      || !/^[a-f0-9]{40,64}$/.test(options.baseCommit)) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
    const paths = options.paths.map((entry) => relativePath(entry, "ENV_SYNTHETIC_INVALID"));
    if (paths.some((entry, index) => paths.some((other, otherIndex) => otherIndex !== index && entry.startsWith(`${other}/`)))) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
    const rootStat = await fsp.lstat(options.worktreePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
    const root = await fsp.realpath(options.worktreePath);
    const tracked = new Set((await Promise.all([
      git(root, ["ls-tree", "-r", "--name-only", "-z", options.baseCommit], options.signal),
      git(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"], options.signal),
      git(root, ["ls-files", "--cached", "-z"], options.signal),
    ])).flatMap((output) => output.split("\0").filter(Boolean)));
    const expected = options.expectedIdentities ? new Map(options.expectedIdentities.map((entry) => [entry.path, entry])) : null;
    if (expected && (expected.size !== paths.length || paths.some((entry) => !expected.has(entry)))) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
    const identities: SyntheticPathIdentity[] = [];
    for (const entry of paths) {
      aborted(options.signal);
      if ([...tracked].some((file) => file === entry || file.startsWith(`${entry}/`) || entry.startsWith(`${file}/`))) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
      const stat = await safeNode(root, entry, "ENV_SYNTHETIC_INVALID", options.allowMissing);
      if (!stat) continue;
      if (!stat.isFile() && !stat.isDirectory()) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
      const identity: SyntheticPathIdentity = { path: entry, kind: stat.isFile() ? "file" : "directory", dev: stat.dev, ino: stat.ino };
      const previous = expected?.get(entry);
      if (previous && (previous.kind !== identity.kind || previous.dev !== identity.dev || previous.ino !== identity.ino)) throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
      identities.push(identity);
    }
    return identities;
  } catch (error) {
    if (options.signal?.aborted) throw new WorktreeEnvironmentError("ENV_ABORTED");
    if (error instanceof WorktreeEnvironmentError) throw error;
    throw new WorktreeEnvironmentError("ENV_SYNTHETIC_INVALID");
  }
}

function hookEnvironment(config: WorktreeEnvironmentConfig, worktreePath: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: [path.dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter),
    LANG: "C", LC_ALL: "C", CI: "1", HOME: worktreePath, USERPROFILE: worktreePath,
  };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const name of config.envAllowlist ?? []) {
    const value = process.env[name];
    if (value !== undefined) {
      if (value.length > 8192 || value.includes("\0")) throw new WorktreeEnvironmentError("ENV_CONFIG_INVALID");
      env[name] = value;
    }
  }
  return env;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* exited or group unavailable */ }
  } else {
    const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill.exe";
    const killer = spawn(executable, ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
    killer.once("error", () => { try { child.kill("SIGKILL"); } catch { /* exited */ } });
    killer.unref();
    return;
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

async function runHook(scriptPath: string, input: Record<string, string>, config: WorktreeEnvironmentConfig, signal?: AbortSignal): Promise<string> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: input.agentCwd,
      // Next augments ProcessEnv with required NODE_ENV, but Node spawn accepts
      // an environment without it. Do not manufacture a project execution mode.
      env: hookEnvironment(config, input.worktreePath) as NodeJS.ProcessEnv, shell: false,
      detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: WorktreeEnvironmentErrorCode | null = null;
    let outputBytes = 0;
    const output: Buffer[] = [];
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      // A hook is a finite preparation step, never a service host. Parent close can
      // precede a detached-stdio grandchild; do not cancel the hard kill and leave it alive.
      killTree(child, "SIGKILL");
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(new WorktreeEnvironmentError(failure));
      else resolve(Buffer.concat(output).toString("utf8"));
    };
    const stop = (code: WorktreeEnvironmentErrorCode) => {
      if (failure || done) return;
      failure = code;
      killTree(child, "SIGTERM");
      forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 150);
      settleTimer = setTimeout(() => {
        killTree(child, "SIGKILL");
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        finish();
      }, 1000);
    };
    const timer = setTimeout(() => stop("ENV_HOOK_TIMEOUT"), config.timeoutMs);
    const abort = () => stop("ENV_ABORTED");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (done || failure) return;
      outputBytes += chunk.length;
      if (outputBytes > config.maxOutputBytes!) stop("ENV_HOOK_OUTPUT_LIMIT");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (done || failure) return;
      outputBytes += chunk.length;
      if (outputBytes > config.maxOutputBytes!) stop("ENV_HOOK_OUTPUT_LIMIT");
    });
    child.stdin.on("error", () => stop("ENV_HOOK_FAILED"));
    child.once("error", () => { failure ??= "ENV_HOOK_FAILED"; finish(); });
    child.once("close", (code) => { if (code !== 0) failure ??= "ENV_HOOK_FAILED"; finish(); });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

/** Trusted hook execution is not an OS sandbox against malicious same-UID writers. */
export async function prepareWorktreeEnvironment(options: {
  repoRoot: string; worktreePath: string; agentCwd: string; baseCommit: string; workerId: string;
  config: WorktreeEnvironmentConfig; signal?: AbortSignal;
}): Promise<PreparedWorktreeEnvironment> {
  let temporaryScript: { path: string; dev: number; ino: number } | null = null;
  try {
    aborted(options.signal);
    const config = configFrom(options.config);
    if (config.mode === "none") return { mode: "none", syntheticPaths: [], syntheticIdentities: [] };
    const repoRoot = await fsp.realpath(options.repoRoot);
    const worktreePath = await fsp.realpath(options.worktreePath);
    const agentCwd = await fsp.realpath(options.agentCwd);
    if (!within(worktreePath, agentCwd) || !/^[a-f0-9]{40,64}$/.test(options.baseCommit)
      || !options.workerId || options.workerId.length > 200 || /[\0\r\n]/.test(options.workerId)) throw new WorktreeEnvironmentError("ENV_REPOSITORY_MISMATCH");
    const [actualRoot, mainCommon, workerCommon, workerHead] = await Promise.all([
      git(worktreePath, ["rev-parse", "--show-toplevel"], options.signal),
      git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options.signal),
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options.signal),
      git(worktreePath, ["rev-parse", "HEAD"], options.signal),
    ]);
    if (await fsp.realpath(actualRoot.trim()) !== worktreePath || await fsp.realpath(mainCommon.trim()) !== await fsp.realpath(workerCommon.trim())
      || workerHead.trim() !== options.baseCommit) throw new WorktreeEnvironmentError("ENV_REPOSITORY_MISMATCH");
    const script = config.script!;
    const stat = await safeNode(worktreePath, script, "ENV_HOOK_INVALID");
    if (!stat?.isFile()) throw new WorktreeEnvironmentError("ENV_HOOK_INVALID");
    const tree = await git(worktreePath, ["ls-tree", "-z", options.baseCommit, "--", script], options.signal);
    const entry = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
    if (!entry || entry[3] !== script) throw new WorktreeEnvironmentError("ENV_HOOK_NOT_TRACKED");
    const source = await boundedRead(path.join(worktreePath, script), MAX_SCRIPT_BYTES, "ENV_HOOK_INVALID");
    if ((await git(worktreePath, ["hash-object", "--stdin"], options.signal, source)).trim() !== entry[2]) throw new WorktreeEnvironmentError("ENV_HOOK_CHANGED");
    aborted(options.signal);
    const executable = path.join(worktreePath, path.dirname(script), `.deerhux-environment-${randomUUID()}${path.extname(script)}`);
    const handle = await fsp.open(executable, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const identity = await handle.stat();
      temporaryScript = { path: executable, dev: identity.dev, ino: identity.ino };
      await handle.writeFile(source);
    } finally { await handle.close(); }
    const identity = await fsp.lstat(executable);
    if (!identity.isFile() || identity.dev !== temporaryScript.dev || identity.ino !== temporaryScript.ino) throw new WorktreeEnvironmentError("ENV_HOOK_CHANGED");
    const stdout = await runHook(executable, { repoRoot, worktreePath, agentCwd, baseCommit: options.baseCommit, workerId: options.workerId }, config, options.signal);
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { throw new WorktreeEnvironmentError("ENV_OUTPUT_INVALID"); }
    if (!record(value) || Object.keys(value).some((key) => key !== "syntheticPaths") || !Array.isArray(value.syntheticPaths)
      || value.syntheticPaths.some((entry) => typeof entry !== "string" || entry === path.relative(worktreePath, executable).split(path.sep).join("/"))) throw new WorktreeEnvironmentError("ENV_OUTPUT_INVALID");
    const syntheticIdentities = await validateSyntheticPaths({ worktreePath, baseCommit: options.baseCommit, paths: value.syntheticPaths as string[], signal: options.signal });
    return { mode: "hook", syntheticPaths: syntheticIdentities.map((entry) => entry.path), syntheticIdentities };
  } catch (error) {
    if (options.signal?.aborted) throw new WorktreeEnvironmentError("ENV_ABORTED");
    if (error instanceof WorktreeEnvironmentError) throw error;
    throw new WorktreeEnvironmentError("ENV_INTERNAL");
  } finally {
    if (temporaryScript) {
      try {
        const current = await fsp.lstat(temporaryScript.path);
        if (!current.isFile() || current.dev !== temporaryScript.dev || current.ino !== temporaryScript.ino) throw new WorktreeEnvironmentError("ENV_HOOK_CHANGED");
        await fsp.unlink(temporaryScript.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof WorktreeEnvironmentError ? error : new WorktreeEnvironmentError("ENV_INTERNAL");
      }
    }
  }
}
