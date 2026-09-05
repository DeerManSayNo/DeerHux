import { spawn } from "node:child_process";
import path from "node:path";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_IO_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type GitProcessErrorCode =
  | "GIT_ABORTED"
  | "GIT_EXIT_NONZERO"
  | "GIT_NOT_REPOSITORY"
  | "GIT_REF_NOT_FOUND"
  | "GIT_LOCK_CONFLICT"
  | "GIT_PATCH_CONFLICT"
  | "GIT_OUTPUT_LIMIT"
  | "GIT_READ_TIMEOUT"
  | "GIT_SPAWN_FAILED"
  | "GIT_TIMEOUT"
  | "GIT_WRITE_TIMEOUT";

export interface GitProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface GitProcessLogEvent {
  event: "start" | "finish" | "error";
  argv: string[];
  cwd: string;
  durationMs?: number;
  code?: GitProcessErrorCode;
  exitCode?: number | null;
}

export interface RunGitOptions {
  cwd: string;
  args: readonly string[];
  stdin?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: Partial<NodeJS.ProcessEnv>;
  logger?: (event: GitProcessLogEvent) => void;
}

interface GitProcessErrorDetails {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}

export class GitProcessError extends Error {
  readonly code: GitProcessErrorCode;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(code: GitProcessErrorCode, message: string, details: GitProcessErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "GitProcessError";
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

const SECRET_OPTION = /^(?:https?(?:\..+)?\.extraheader|credential\..*|core\.askpass)$/i;

function redactUrl(value: string): string {
  return value.replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1<redacted>@");
}

/** Return an argv-shaped safe copy. The original argv is always passed unchanged to Git. */
export function redactGitArgv(args: readonly string[]): string[] {
  const redacted = ["git"];
  let hideNext = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (hideNext) {
      redacted.push("<redacted>");
      hideNext = false;
      continue;
    }
    if ((arg === "-c" || arg === "--config-env") && index + 1 < args.length) {
      redacted.push(arg);
      const assignment = args[index + 1];
      const separator = assignment.indexOf("=");
      const key = separator < 0 ? assignment : assignment.slice(0, separator);
      if (SECRET_OPTION.test(key)) hideNext = true;
      continue;
    }
    const separator = arg.indexOf("=");
    const key = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? "" : arg.slice(separator + 1);
    redacted.push(SECRET_OPTION.test(key)
      ? `${key}=<redacted>`
      : separator >= 0 && path.isAbsolute(value)
        ? `${key}=<path>`
        : path.isAbsolute(arg) ? "<path>" : redactUrl(arg));
  }
  return redacted;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "Git command aborted";
}

function emitLog(logger: RunGitOptions["logger"], event: GitProcessLogEvent): void {
  try { logger?.(event); } catch { /* logging must not affect command lifecycle */ }
}

async function terminateProcessTree(child: ReturnType<typeof spawn>, graceMs = 250): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let killer: ReturnType<typeof spawn>;
      try {
        killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        child.kill("SIGKILL");
        resolve();
        return;
      }
      killer.once("error", () => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }

  const kill = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  };
  kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ]);
  kill("SIGKILL");
}

export function classifyGitError(stderr: string): GitProcessErrorCode {
  return /not a git repository/i.test(stderr)
    ? "GIT_NOT_REPOSITORY"
    : /unknown revision|bad revision|ambiguous argument|not a valid object name|needed a single revision/i.test(stderr)
      ? "GIT_REF_NOT_FOUND"
      : /index\.lock|another git process/i.test(stderr)
        ? "GIT_LOCK_CONFLICT"
        : /patch failed|patch does not apply|does not match index/i.test(stderr)
          ? "GIT_PATCH_CONFLICT"
          : "GIT_EXIT_NONZERO";
}

/** Execute Git without a shell and return a bounded, structured result. */
export function runGit(options: RunGitOptions): Promise<GitProcessResult> {
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.reject(new GitProcessError("GIT_ABORTED", abortMessage(signal), { cause: signal.reason }));
  }

  const startedAt = Date.now();
  const safeArgv = redactGitArgv(options.args);
  const safeCwd = "<repo>";
  emitLog(options.logger, { event: "start", argv: safeArgv, cwd: safeCwd });

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, LC_ALL: "C", LANG: "C" },
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutLimit = positiveInteger(options.maxStdoutBytes, DEFAULT_GIT_MAX_OUTPUT_BYTES);
    const stderrLimit = positiveInteger(options.maxStderrBytes, DEFAULT_GIT_MAX_OUTPUT_BYTES);
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_GIT_TIMEOUT_MS);
    const readTimeoutMs = positiveInteger(options.readTimeoutMs, DEFAULT_GIT_IO_TIMEOUT_MS);
    const writeTimeoutMs = positiveInteger(options.writeTimeoutMs, DEFAULT_GIT_IO_TIMEOUT_MS);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: GitProcessError | null = null;
    let closed = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let writeTimer: ReturnType<typeof setTimeout> | undefined;

    const output = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
    const fail = (error: GitProcessError): void => {
      if (terminalError || closed) return;
      terminalError = error;
      void terminateProcessTree(child);
    };
    const resetReadTimer = (): void => {
      if (readTimer) clearTimeout(readTimer);
      readTimer = setTimeout(() => {
        const data = output();
        fail(new GitProcessError("GIT_READ_TIMEOUT", `Git output was idle for ${readTimeoutMs}ms`, data));
      }, readTimeoutMs);
      readTimer.unref?.();
    };
    const collect = (channel: "stdout" | "stderr", chunk: Buffer): void => {
      if (terminalError || closed) return;
      const nextBytes = (channel === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      const limit = channel === "stdout" ? stdoutLimit : stderrLimit;
      if (nextBytes > limit) {
        const remaining = Math.max(0, limit - (channel === "stdout" ? stdoutBytes : stderrBytes));
        if (remaining) (channel === "stdout" ? stdoutChunks : stderrChunks).push(chunk.subarray(0, remaining));
        const data = output();
        fail(new GitProcessError("GIT_OUTPUT_LIMIT", `Git ${channel} exceeded ${limit} bytes`, data));
        return;
      }
      if (channel === "stdout") stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
      (channel === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
      resetReadTimer();
    };
    const onAbort = (): void => fail(new GitProcessError(
      "GIT_ABORTED",
      signal ? abortMessage(signal) : "Git command aborted",
      { ...output(), cause: signal?.reason },
    ));
    const overallTimer = setTimeout(() => {
      fail(new GitProcessError("GIT_TIMEOUT", `Git command exceeded ${timeoutMs}ms`, output()));
    }, timeoutMs);
    overallTimer.unref?.();
    resetReadTimer();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (cause) => {
      fail(new GitProcessError("GIT_SPAWN_FAILED", "Unable to start Git", { ...output(), cause }));
    });

    if (options.stdin !== undefined && child.stdin) {
      writeTimer = setTimeout(() => {
        fail(new GitProcessError("GIT_WRITE_TIMEOUT", `Git stdin was blocked for ${writeTimeoutMs}ms`, output()));
      }, writeTimeoutMs);
      writeTimer.unref?.();
      child.stdin.end(options.stdin, () => {
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = undefined;
      });
      child.stdin.on("error", (cause) => {
        if (!terminalError) fail(new GitProcessError("GIT_SPAWN_FAILED", "Unable to write Git stdin", { ...output(), cause }));
      });
    }

    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      clearTimeout(overallTimer);
      if (readTimer) clearTimeout(readTimer);
      if (writeTimer) clearTimeout(writeTimer);
      signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startedAt;
      const data = output();
      if (!terminalError && exitCode !== 0) {
        const code = classifyGitError(data.stderr);
        terminalError = new GitProcessError(code, `Git exited with status ${exitCode ?? "unknown"}`, {
          ...data,
          exitCode,
          signal: exitSignal,
        });
      }
      if (terminalError) {
        emitLog(options.logger, { event: "error", argv: safeArgv, cwd: safeCwd, durationMs, code: terminalError.code, exitCode });
        reject(terminalError);
        return;
      }
      emitLog(options.logger, { event: "finish", argv: safeArgv, cwd: safeCwd, durationMs, exitCode });
      resolve({ ...data, exitCode: exitCode as number, signal: exitSignal, durationMs });
    });
  });
}

export const execGit = runGit;
