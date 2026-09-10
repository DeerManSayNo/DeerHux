import { spawn } from "child_process";
import path from "path";
import fs from "fs";

export class CodeGraphCliError extends Error {
  constructor(message: string, readonly code?: number | null, readonly stderr?: string) {
    super(message);
    this.name = "CodeGraphCliError";
  }
}

export interface CodeGraphRunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDIO_BYTES = 2 * 1024 * 1024;

// Use the application's bundled runtime, never a workspace executable or a
// global installation. Direct execution also makes abort/timeout kill the CLI
// itself rather than only the npm shim's parent process.
export function resolveCodeGraphRuntime(appRoot = process.cwd()) {
  const bundle = path.join(appRoot, "node_modules", "@colbymchenry", `codegraph-${process.platform}-${process.arch}`);
  // Packaged builds share the host's verified Node binary. Development installs
  // retain the upstream self-contained runtime. Never resolve node via PATH.
  const command = fs.existsSync(path.join(bundle, "deerhux-shared-node"))
    ? process.execPath
    : path.join(bundle, process.platform === "win32" ? "node.exe" : "node");
  const entry = path.join(bundle, "lib", "dist", "bin", "codegraph.js");
  if (!fs.existsSync(command) || !fs.existsSync(entry)) {
    throw new CodeGraphCliError(`CodeGraph runtime missing for ${process.platform}-${process.arch}: ${bundle}. Rebuild the application with its CodeGraph platform dependency.`);
  }
  return { command, entry };
}

export function runCodeGraph(args: string[], options: CodeGraphRunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("CodeGraph command aborted", "AbortError"));
      return;
    }
    const runtime = resolveCodeGraphRuntime();
    const child = spawn(runtime.command, ["--liftoff-only", runtime.entry, ...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new CodeGraphCliError(`codegraph ${args.join(" ")} timed out`, null, stderr)));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new DOMException("CodeGraph command aborted", "AbortError")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STDIO_BYTES) child.kill("SIGTERM");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_STDIO_BYTES) child.kill("SIGTERM");
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout.trim());
        else reject(new CodeGraphCliError(`codegraph ${args.join(" ")} failed with exit code ${code}`, code, stderr.trim()));
      });
    });
  });
}

export async function runCodeGraphJson<T = unknown>(args: string[], options: CodeGraphRunOptions): Promise<T> {
  const output = await runCodeGraph(args, options);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new CodeGraphCliError(
      `codegraph ${args.join(" ")} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
      null,
      output.slice(0, 1000),
    );
  }
}
