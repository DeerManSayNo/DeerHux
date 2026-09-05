import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { WorktreeFileChange } from "./worktree-file-metadata.ts";
import { getIsolatedRunDir, getIsolatedRunsRoot } from "./worktree";
import { MAX_WORKTREE_PATCH_BYTES, readWorktreeManifest, type WorktreeCaptureV1 } from "./worktree-manifest";

export const MAX_INLINE_DIFF_BYTES = 1024 * 1024;

export type DiffFileSummary = Partial<Omit<WorktreeFileChange, "binary">> & {
  path: string;
  type: "text" | "binary";
  /** New-side Git blob bytes; null for deletion, non-blob or historical unknown. */
  bytes: number | null;
};

export type WorktreeDiffSummary = {
  runId: string;
  workerId: string;
  changed: boolean;
  capturedAt: string | null;
  files: DiffFileSummary[];
  artifact: {
    available: boolean;
    bytes: number;
    sha256: string;
    inlineAvailable: boolean;
    containsBinary: boolean;
  } | null;
};

export class WorktreeDiffError extends Error {
  constructor(
    readonly code:
      | "DIFF_INVALID_REQUEST"
      | "DIFF_RUN_NOT_FOUND"
      | "DIFF_WORKER_NOT_FOUND"
      | "DIFF_NOT_CAPTURED"
      | "DIFF_ARTIFACT_REJECTED"
      | "DIFF_TOO_LARGE",
    readonly status: number,
  ) {
    super(code);
    this.name = "WorktreeDiffError";
  }
}

type VerifiedDiff = {
  summary: WorktreeDiffSummary;
  artifactPath: string | null;
  handle: FileHandle | null;
};

function rejectArtifact(): never {
  throw new WorktreeDiffError("DIFF_ARTIFACT_REJECTED", 409);
}

function assertSafeId(value: string): void {
  if (!value || value.length > 200 || value !== value.trim() || /[\0\r\n]/.test(value)) {
    throw new WorktreeDiffError("DIFF_INVALID_REQUEST", 400);
  }
}

function assertOwned(stat: fs.Stats): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) rejectArtifact();
}

function assertSecureNode(target: string, kind: "file" | "directory", permissions: number | null): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    rejectArtifact();
  }
  if (stat.isSymbolicLink()) rejectArtifact();
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) rejectArtifact();
  assertOwned(stat);
  if (permissions === null ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== permissions) rejectArtifact();
  return stat;
}

function assertDirectChild(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes(path.sep)) rejectArtifact();
}

async function hashHandle(handle: FileHandle, bytes: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (bytesRead <= 0) rejectArtifact();
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function emptySummary(runId: string, workerId: string, capture: WorktreeCaptureV1): WorktreeDiffSummary {
  const binary = new Set(capture.binaryFiles);
  const metadata = new Map(capture.fileChanges?.map((file) => [file.path, file]));
  return {
    runId,
    workerId,
    changed: capture.changed,
    capturedAt: capture.capturedAt,
    files: capture.changedFiles.map((filePath) => ({
      ...(metadata.has(filePath) ? { changeKind: metadata.get(filePath)!.changeKind, previousPath: metadata.get(filePath)!.previousPath,
        oldBytes: metadata.get(filePath)!.oldBytes, newBytes: metadata.get(filePath)!.newBytes,
        addedLines: metadata.get(filePath)!.addedLines, deletedLines: metadata.get(filePath)!.deletedLines } : {}),
      path: filePath,
      type: binary.has(filePath) ? "binary" : "text",
      bytes: metadata.get(filePath)?.newBytes ?? null,
    })),
    artifact: null,
  };
}

/**
 * Resolve and verify a captured patch without trusting paths from the run snapshot.
 * The returned descriptor names the same inode that was hashed and must be closed by the caller.
 */
export async function verifyWorktreeDiff(runId: string, workerId: string, keepOpen = false): Promise<VerifiedDiff> {
  assertSafeId(runId);
  assertSafeId(workerId);

  let runDir: string;
  try {
    runDir = getIsolatedRunDir(runId);
  } catch {
    throw new WorktreeDiffError("DIFF_INVALID_REQUEST", 400);
  }
  const runsRoot = getIsolatedRunsRoot();
  const manifestPath = path.join(runDir, "worktree-manifest.json");
  try {
    fs.lstatSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorktreeDiffError("DIFF_RUN_NOT_FOUND", 404);
    }
    rejectArtifact();
  }
  try {
    // The shared runs parent may predate private-mode enforcement, but it must never be writable by another uid.
    assertSecureNode(runsRoot, "directory", null);
    assertSecureNode(runDir, "directory", 0o700);
    assertDirectChild(runsRoot, runDir);
    assertSecureNode(manifestPath, "file", 0o600);
    assertDirectChild(fs.realpathSync.native(runsRoot), fs.realpathSync.native(runDir));
  } catch (error) {
    if (error instanceof WorktreeDiffError) throw error;
    rejectArtifact();
  }

  const result = readWorktreeManifest(manifestPath);
  if (result.kind === "missing") throw new WorktreeDiffError("DIFF_RUN_NOT_FOUND", 404);
  if (result.kind !== "ok" || result.manifest.runId !== runId) rejectArtifact();
  const worker = result.manifest.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker) throw new WorktreeDiffError("DIFF_WORKER_NOT_FOUND", 404);
  const capture = worker.capture;
  if (!capture) throw new WorktreeDiffError("DIFF_NOT_CAPTURED", 409);
  const summary = emptySummary(runId, workerId, capture);
  if (!capture.patchPath || !capture.patchSha256 || capture.patchBytes === null) return { summary, artifactPath: null, handle: null };
  if (capture.patchBytes > MAX_WORKTREE_PATCH_BYTES) throw new WorktreeDiffError("DIFF_TOO_LARGE", 413);

  const artifactRoot = path.join(runDir, "artifacts");
  assertSecureNode(artifactRoot, "directory", 0o700);
  assertDirectChild(fs.realpathSync.native(runDir), fs.realpathSync.native(artifactRoot));
  const artifactPath = path.resolve(capture.patchPath);
  assertDirectChild(artifactRoot, artifactPath);
  if (!path.basename(artifactPath).endsWith(`-${capture.patchSha256}.patch`)) rejectArtifact();
  assertSecureNode(artifactPath, "file", 0o600);
  assertDirectChild(fs.realpathSync.native(artifactRoot), fs.realpathSync.native(artifactPath));

  const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(artifactPath, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== capture.patchBytes) rejectArtifact();
    if (opened.size > MAX_WORKTREE_PATCH_BYTES) throw new WorktreeDiffError("DIFF_TOO_LARGE", 413);
    assertOwned(opened);
    if ((opened.mode & 0o777) !== 0o600) rejectArtifact();
    if (await hashHandle(handle, opened.size) !== capture.patchSha256) rejectArtifact();
    summary.artifact = {
      available: true,
      bytes: opened.size,
      sha256: capture.patchSha256,
      inlineAvailable: opened.size <= MAX_INLINE_DIFF_BYTES,
      containsBinary: capture.binaryFiles.length > 0,
    };
    if (!keepOpen) {
      await handle.close();
      handle = null;
    }
    return { summary, artifactPath, handle };
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (error instanceof WorktreeDiffError) throw error;
    rejectArtifact();
  }
}
