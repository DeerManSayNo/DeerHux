import fs from "fs";
import path from "path";
import { CodeGraphCliError, runCodeGraph, runCodeGraphJson } from "./cli";

function reportFailure(action: string, cwd: string, error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return;
  console.warn(`[codegraph] ${action} failed (${cwd}):`,
    error instanceof Error ? error.message : String(error),
    error instanceof CodeGraphCliError ? (error.stderr ?? "").slice(0, 2000) : "");
}

export interface CodeGraphStatus {
  initialized: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  lastIndexed?: number | null;
  pendingChanges?: unknown;
  [key: string]: unknown;
}

export function hasCodeGraphDir(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, ".codegraph"));
}

export async function ensureCodeGraphInitialized(cwd: string, signal?: AbortSignal): Promise<CodeGraphStatus | null> {
  try {
    // A broken existing index/runtime must not silently trigger reinitialization.
    const existing = hasCodeGraphDir(cwd) ? await readStatus(cwd, signal) : null;
    if (existing?.initialized) return existing;

    await runCodeGraph(["init", "--index", cwd], {
      cwd,
      signal,
      timeoutMs: 120_000,
    });

    return await getCodeGraphStatus(cwd, signal);
  } catch (error) {
    reportFailure("tool initialization", cwd, error, signal);
    return null;
  }
}

export async function getCodeGraphStatus(cwd: string, signal?: AbortSignal): Promise<CodeGraphStatus | null> {
  if (!hasCodeGraphDir(cwd)) return null;
  try {
    return await readStatus(cwd, signal);
  } catch (error) {
    reportFailure("status", cwd, error, signal);
    return null;
  }
}

async function readStatus(cwd: string, signal?: AbortSignal): Promise<CodeGraphStatus | null> {
  const status = await runCodeGraphJson<CodeGraphStatus>(["status", "--json"], { cwd, signal, timeoutMs: 10_000 });
  return status.initialized ? status : null;
}

export async function isCodeGraphAvailable(cwd: string): Promise<boolean> {
  const status = await getCodeGraphStatus(cwd);
  return Boolean(status?.initialized);
}
