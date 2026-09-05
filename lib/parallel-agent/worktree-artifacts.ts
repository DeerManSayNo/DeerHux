import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { GitProcessError } from "./git-process.ts";
import { GitRepository } from "./git-repository.ts";
import { validateSyntheticPaths } from "./worktree-environment.ts";
import { beginWorktreeOperation, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";
import { isWorktreeFileChange, type WorktreeFileChange } from "./worktree-file-metadata.ts";
import {
  readWorktreeManifest,
  MAX_WORKTREE_PATCH_BYTES,
  transitionWorktreeManifest,
  writeWorktreeManifestAtomic,
  type WorktreeCaptureV1,
  type WorktreeManifestV1,
} from "./worktree-manifest.ts";

export type ArtifactCaptureErrorCode =
  | "ARTIFACT_BASE_INVALID"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_GIT_FAILED"
  | "ARTIFACT_MANIFEST_INVALID"
  | "ARTIFACT_MANIFEST_WRITE_FAILED"
  | "ARTIFACT_PATCH_APPLY_FAILED"
  | "ARTIFACT_PATCH_WRITE_FAILED"
  | "ARTIFACT_PATCH_TOO_LARGE"
  | "ARTIFACT_REPOSITORY_MISMATCH"
  | "ARTIFACT_SYNTHETIC_INVALID"
  | "ARTIFACT_TREE_MISMATCH"
  | "ARTIFACT_WORKER_NOT_FOUND";

export interface ArtifactFileStats {
  changedFiles: string[];
  binaryFiles: string[];
}

export interface WorktreeArtifactCaptureResult {
  ok: boolean;
  workerId: string;
  workerBranch: string | null;
  workerHead: string | null;
  capture: WorktreeCaptureV1 | null;
  treeDigest: string | null;
  errorCode: ArtifactCaptureErrorCode | null;
  error: string | null;
  manifestStatePersisted: boolean;
}

export interface ArtifactCaptureFaults {
  /** Runs after Git closes the temporary patch and before it is fsynced. */
  afterPatchWrite?: (tempPatchPath: string) => void | Promise<void>;
  beforeDigestVerify?: (tempPatchPath: string) => void | Promise<void>;
  beforeArtifactRename?: (tempPatchPath: string, artifactPath: string) => void | Promise<void>;
  beforeManifestWrite?: () => void | Promise<void>;
  forceDigestMismatch?: boolean;
  forceTreeMismatch?: boolean;
}

export interface CaptureWorktreeArtifactOptions {
  /** Correlation only, supplied by the host; never used as filesystem authority. */
  diagnosticRunId?: string;
  artifactDirectory?: string;
  syntheticPaths?: readonly string[];
  signal?: AbortSignal;
  now?: () => Date;
  faults?: ArtifactCaptureFaults;
}

class ArtifactCaptureError extends Error {
  readonly code: ArtifactCaptureErrorCode;

  constructor(code: ArtifactCaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactCaptureError";
    this.code = code;
  }
}

function publicArtifactError(code: ArtifactCaptureErrorCode): string {
  const messages: Record<ArtifactCaptureErrorCode, string> = {
    ARTIFACT_BASE_INVALID: "Artifact base commit is invalid",
    ARTIFACT_DIGEST_MISMATCH: "Artifact digest verification failed",
    ARTIFACT_GIT_FAILED: "Artifact Git operation failed",
    ARTIFACT_MANIFEST_INVALID: "Artifact manifest is invalid",
    ARTIFACT_MANIFEST_WRITE_FAILED: "Artifact manifest could not be persisted",
    ARTIFACT_PATCH_APPLY_FAILED: "Artifact patch verification failed",
    ARTIFACT_PATCH_WRITE_FAILED: "Artifact patch could not be persisted",
    ARTIFACT_PATCH_TOO_LARGE: "Artifact patch exceeds the maximum supported size",
    ARTIFACT_REPOSITORY_MISMATCH: "Artifact repository identity does not match",
    ARTIFACT_SYNTHETIC_INVALID: "Synthetic environment paths changed or are unsafe; workspace preserved",
    ARTIFACT_TREE_MISMATCH: "Artifact tree verification failed",
    ARTIFACT_WORKER_NOT_FOUND: "Artifact worker was not found",
  };
  return messages[code];
}

function classifyError(error: unknown): ArtifactCaptureErrorCode {
  if (error instanceof ArtifactCaptureError) return error.code;
  if (error instanceof GitProcessError) return "ARTIFACT_GIT_FAILED";
  return "ARTIFACT_PATCH_WRITE_FAILED";
}

function safeWorkerToken(workerId: string): string {
  return Buffer.from(workerId, "utf8").toString("base64url") || "worker";
}

function splitNul(buffer: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error("numstat output is not NUL terminated");
  return fields;
}

/** Parse `git diff --numstat -z`; rename records have an empty inline path and two following paths. */
export function parseNumstatZ(output: Buffer | string): ArtifactFileStats {
  const fields = splitNul(Buffer.isBuffer(output) ? output : Buffer.from(output, "utf8"));
  const changedFiles: string[] = [];
  const binaryFiles: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index];
    if (header.length === 0) continue;
    const firstTab = header.indexOf(9);
    const secondTab = firstTab < 0 ? -1 : header.indexOf(9, firstTab + 1);
    if (firstTab < 1 || secondTab < 0) throw new Error("Malformed numstat record");
    const added = header.subarray(0, firstTab).toString("ascii");
    const deleted = header.subarray(firstTab + 1, secondTab).toString("ascii");
    const inlinePath = header.subarray(secondTab + 1);
    let selectedPath: Buffer;
    if (inlinePath.length === 0) {
      if (index + 2 >= fields.length) throw new Error("Malformed numstat rename record");
      index += 2;
      selectedPath = fields[index];
    } else {
      selectedPath = inlinePath;
    }
    const decoded = selectedPath.toString("utf8");
    changedFiles.push(decoded);
    if (added === "-" || deleted === "-") binaryFiles.push(decoded);
  }
  return { changedFiles, binaryFiles };
}

/** Read structured Git records from the same immutable trees proved by patch verification. */
async function captureFileChanges(repository: GitRepository, cwd: string, base: string, tree: string): Promise<WorktreeFileChange[]> {
  const args = ["--find-renames", "--no-ext-diff", "--no-textconv", base, tree];
  const [raw, numbers] = await Promise.all([
    repository.run(["diff", "--raw", "--no-abbrev", "-z", ...args], { cwd, maxStdoutBytes: 64 * 1024 * 1024 }),
    repository.run(["diff", "--numstat", "-z", ...args], { cwd, maxStdoutBytes: 64 * 1024 * 1024 }),
  ]);
  const records = splitNul(Buffer.from(raw.stdout)).map((field) => field.toString("utf8"));
  const pending: Array<{ file: WorktreeFileChange; oldOid: string; newOid: string }> = [];
  const objects = new Set<string>();
  for (let index = 0; index < records.length;) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDRT])\d*$/.exec(records[index++]);
    if (!header || pending.length >= 20_000) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Invalid or oversized structured file metadata");
    const oldPath = records[index++];
    const nextPath = header[5] === "R" ? records[index++] : oldPath;
    const file: WorktreeFileChange = { path: nextPath, previousPath: header[5] === "R" ? oldPath : null,
      changeKind: ({ A: "new", M: "modified", D: "deleted", R: "renamed", T: "typechange" } as const)[header[5] as "A" | "M" | "D" | "R" | "T"],
      binary: false, oldBytes: null, newBytes: null, addedLines: 0, deletedLines: 0 };
    pending.push({ file, oldOid: header[3], newOid: header[4] });
    if (!/^0+$/.test(header[3]) && header[1] !== "160000") objects.add(header[3]);
    if (!/^0+$/.test(header[4]) && header[2] !== "160000") objects.add(header[4]);
  }
  const lineStats = new Map<string, { added: number | null; deleted: number | null }>();
  const fields = splitNul(Buffer.from(numbers.stdout)).map((field) => field.toString("utf8"));
  for (let index = 0; index < fields.length;) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index++]);
    if (!match || (match[1] === "-") !== (match[2] === "-")) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Invalid numstat metadata");
    let name = match[3];
    if (!name) { index += 1; name = fields[index++]; }
    if (!name || lineStats.has(name)) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Ambiguous numstat metadata");
    lineStats.set(name, { added: match[1] === "-" ? null : Number(match[1]), deleted: match[2] === "-" ? null : Number(match[2]) });
  }
  const sizes = new Map<string, number | null>();
  if (objects.size) {
    const result = await repository.run(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      cwd, stdin: `${[...objects].join("\n")}\n`, maxStdoutBytes: 8 * 1024 * 1024,
    });
    for (const record of result.stdout.trim().split("\n")) {
      const match = /^([a-f0-9]{40,64}) (blob|commit|tree) (\d+)$/.exec(record);
      if (!match || !objects.has(match[1]) || !Number.isSafeInteger(Number(match[3]))) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Invalid object size metadata");
      sizes.set(match[1], match[2] === "blob" ? Number(match[3]) : null);
    }
    if (sizes.size !== objects.size) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Missing object size metadata");
  }
  if (lineStats.size !== pending.length) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "File metadata does not match verified tree");
  return pending.map(({ file, oldOid, newOid }) => {
    const lines = lineStats.get(file.path);
    if (!lines) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Missing file statistics");
    Object.assign(file, { oldBytes: sizes.get(oldOid) ?? null, newBytes: sizes.get(newOid) ?? null,
      addedLines: lines.added, deletedLines: lines.deleted, binary: lines.added === null });
    if (!isWorktreeFileChange(file)) throw new ArtifactCaptureError("ARTIFACT_GIT_FAILED", "Invalid captured file metadata");
    return file;
  });
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return { sha256: hash.digest("hex"), bytes };
}

function fsyncFile(filePath: string): void {
  const descriptor = fs.openSync(filePath, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

async function assertRepositoryIdentity(
  repository: GitRepository,
  manifest: WorktreeManifestV1,
  expectedWorktreePath: string,
): Promise<void> {
  const [actualRoot, expectedRoot, actualCommon, expectedCommon] = await Promise.all([
    fsp.realpath(repository.root),
    fsp.realpath(expectedWorktreePath),
    fsp.realpath(repository.commonDir),
    fsp.realpath(manifest.gitCommonDir),
  ]);
  if (actualRoot !== expectedRoot || actualCommon !== expectedCommon || manifest.repoRoot !== path.resolve(manifest.repoRoot)) {
    throw new ArtifactCaptureError("ARTIFACT_REPOSITORY_MISMATCH", "Worker repository identity does not match manifest");
  }
  try {
    await repository.run(["cat-file", "-e", `${manifest.baseCommit}^{commit}`], { maxStdoutBytes: 1024 });
  } catch (error) {
    throw new ArtifactCaptureError("ARTIFACT_BASE_INVALID", "Manifest baseCommit is not available as a commit", { cause: error });
  }
}

async function readWorkerAudit(repository: GitRepository, cwd: string): Promise<{ branch: string; head: string }> {
  const [branch, head] = await Promise.all([
    repository.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, maxStdoutBytes: 4096 }),
    repository.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd, maxStdoutBytes: 4096 }),
  ]);
  return { branch: branch.stdout.trim(), head: head.stdout.trim() };
}

async function verifyPatchTree(
  repository: GitRepository,
  cwd: string,
  baseCommit: string,
  patchPath: string,
  token: string,
  sourceIndexEnv: Record<string, string> = {},
): Promise<{ stagedTree: string; rebuiltTree: string }> {
  const gitDirResult = await repository.run(["rev-parse", "--absolute-git-dir"], { cwd, maxStdoutBytes: 64 * 1024 });
  const gitDir = gitDirResult.stdout.trim();
  const temporaryIndex = path.join(gitDir, `deerhux-artifact-index-${token}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const staged = await repository.run(["write-tree"], { cwd, env: sourceIndexEnv, maxStdoutBytes: 4096 });
    await repository.run(["read-tree", baseCommit], { cwd, env, maxStdoutBytes: 4096 });
    try {
      await repository.run(["apply", "--cached", "--binary", "--allow-empty", "--whitespace=nowarn", patchPath], {
        cwd,
        env,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 1024 * 1024,
      });
    } catch (error) {
      throw new ArtifactCaptureError("ARTIFACT_PATCH_APPLY_FAILED", "Patch cannot be applied to baseCommit", { cause: error });
    }
    const rebuilt = await repository.run(["write-tree"], { cwd, env, maxStdoutBytes: 4096 });
    return { stagedTree: staged.stdout.trim(), rebuiltTree: rebuilt.stdout.trim() };
  } finally {
    await fsp.rm(temporaryIndex, { force: true });
    await fsp.rm(`${temporaryIndex}.lock`, { force: true });
  }
}

function preservedManifest(
  manifest: WorktreeManifestV1,
  workerId: string,
  now: string,
  errorCode: ArtifactCaptureErrorCode,
): WorktreeManifestV1 {
  const workers = manifest.workers.map((worker) => worker.workerId === workerId
    ? {
        ...worker,
        state: "preserved" as const,
        capture: worker.capture ?? {
          changed: false,
          workerBranch: worker.branch,
          workerHead: manifest.baseCommit,
          patchPath: null,
          patchSha256: null,
          patchBytes: null,
          changedFiles: [],
          binaryFiles: [],
          capturedAt: null,
          captureError: errorCode,
        },
      }
    : worker);
  const next = { ...manifest, workers };
  if (manifest.state === "preserved") return { ...next, updatedAt: now };
  if (["running", "captured", "applying", "cleanup_error", "setting_up", "planning"].includes(manifest.state)) {
    try { return { ...transitionWorktreeManifest(manifest, "preserved", { caller: "capture", now }), workers }; }
    catch { return { ...next, state: "preserved", updatedAt: now }; }
  }
  return next;
}

function successfulManifest(
  manifest: WorktreeManifestV1,
  workerId: string,
  branch: string,
  capture: WorktreeCaptureV1,
  now: string,
): WorktreeManifestV1 {
  const workers = manifest.workers.map((worker) => worker.workerId === workerId
    ? { ...worker, branch, state: "captured" as const, capture }
    : worker);
  const allCaptured = workers.every((worker) => worker.state === "captured" && worker.capture !== null);
  let next: WorktreeManifestV1 = { ...manifest, workers, updatedAt: now };
  if (allCaptured && manifest.state !== "captured") {
    next = { ...transitionWorktreeManifest(manifest, "captured", { caller: "capture", now }), workers };
  } else if (!allCaptured && manifest.state === "captured") {
    next = { ...transitionWorktreeManifest(manifest, "preserved", { caller: "capture", now }), workers };
  }
  return next;
}

async function persistPreservedBestEffort(
  manifestPath: string,
  manifest: WorktreeManifestV1,
  workerId: string,
  now: string,
  errorCode: ArtifactCaptureErrorCode,
): Promise<boolean> {
  try {
    writeWorktreeManifestAtomic(manifestPath, preservedManifest(manifest, workerId, now, errorCode));
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture one worker's complete staged tree relative to the manifest base commit.
 * Patch bytes are produced by Git and hashed from disk; they never enter a JS string or manifest snapshot.
 */
export async function captureWorktreeArtifact(...args: Parameters<typeof captureWorktreeArtifactInternal>): ReturnType<typeof captureWorktreeArtifactInternal> {
  const operation = beginWorktreeOperation("capture", { workerId: args[1], runId: args[2]?.diagnosticRunId });
  try {
    const result = await captureWorktreeArtifactInternal(...args);
    operation.finish(result.ok ? (result.capture?.changed ? "completed" : "empty") : "failed", {
      reason: result.ok ? "none" : worktreeDiagnosticReason(result.errorCode),
      patchBytes: result.ok ? result.capture?.patchBytes ?? 0 : 0,
      fileCount: result.ok ? result.capture?.changedFiles.length ?? 0 : 0,
      binaryFileCount: result.ok ? result.capture?.binaryFiles.length ?? 0 : 0,
      preservedCount: result.ok ? 0 : 1,
    });
    return result;
  } catch (error) {
    operation.finish(args[2]?.signal?.aborted ? "aborted" : "failed", { reason: worktreeDiagnosticReason(error), preservedCount: 1 });
    throw error;
  }
}

async function captureWorktreeArtifactInternal(
  manifestPath: string,
  workerId: string,
  options: CaptureWorktreeArtifactOptions = {},
): Promise<WorktreeArtifactCaptureResult> {
  const read = readWorktreeManifest(manifestPath);
  if (read.kind !== "ok") {
    return {
      ok: false, workerId, workerBranch: null, workerHead: null, capture: null, treeDigest: null,
      errorCode: "ARTIFACT_MANIFEST_INVALID", error: publicArtifactError("ARTIFACT_MANIFEST_INVALID"), manifestStatePersisted: false,
    };
  }
  let manifest = read.manifest;
  let worker = manifest.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker) {
    return {
      ok: false, workerId, workerBranch: null, workerHead: null, capture: null, treeDigest: null,
      errorCode: "ARTIFACT_WORKER_NOT_FOUND", error: publicArtifactError("ARTIFACT_WORKER_NOT_FOUND"), manifestStatePersisted: false,
    };
  }

  let branch: string | null = null;
  let head: string | null = null;
  let tempPatch: string | null = null;
  let publishedPatch: string | null = null;
  let publishedByThisCall = false;
  let captureIndex: string | null = null;
  let now = (options.now ?? (() => new Date()))().toISOString();

  try {
    const initialWorkerPath = worker.worktreePath;
    const repository = await GitRepository.open(initialWorkerPath, { signal: options.signal, instanceId: manifest.instanceId });
    return await repository.withWriteLock({ operation: `capture:${manifest.runId}:${workerId}`, signal: options.signal }, async () => {
      try {
        const lockedRead = readWorktreeManifest(manifestPath);
        if (lockedRead.kind !== "ok") {
          throw new ArtifactCaptureError("ARTIFACT_MANIFEST_INVALID", `Manifest became ${lockedRead.kind} while acquiring capture lock`);
        }
        const lockedWorker = lockedRead.manifest.workers.find((candidate) => candidate.workerId === workerId);
        if (!lockedWorker) throw new ArtifactCaptureError("ARTIFACT_WORKER_NOT_FOUND", `Unknown workerId: ${workerId}`);
        if (path.resolve(lockedWorker.worktreePath) !== path.resolve(initialWorkerPath)) {
          throw new ArtifactCaptureError("ARTIFACT_REPOSITORY_MISMATCH", "Worker path changed while acquiring capture lock");
        }
        manifest = lockedRead.manifest;
        worker = lockedWorker;
        if (Date.parse(now) < Date.parse(manifest.updatedAt)) now = manifest.updatedAt;
        await assertRepositoryIdentity(repository, manifest, worker.worktreePath);
        ({ branch, head } = await readWorkerAudit(repository, worker.worktreePath));
        const token = `${safeWorkerToken(workerId)}-${process.pid}-${randomUUID()}`;
        const syntheticPaths = [...new Set([...(worker.environment?.syntheticPaths ?? []), ...(options.syntheticPaths ?? [])])];
        const verifySynthetic = async () => {
          if (!syntheticPaths.length) return;
          try {
            await validateSyntheticPaths({
              worktreePath: worker!.worktreePath, baseCommit: manifest.baseCommit, paths: syntheticPaths,
              expectedIdentities: worker!.environment?.syntheticIdentities, allowMissing: true, signal: options.signal,
            });
          } catch (error) {
            throw new ArtifactCaptureError("ARTIFACT_SYNTHETIC_INVALID", "Synthetic environment paths are unsafe", { cause: error });
          }
        };
        await verifySynthetic();
        const captureEnv: Record<string, string> = {};
        if (syntheticPaths.length) {
          const gitDir = (await repository.run(["rev-parse", "--absolute-git-dir"], { cwd: worker.worktreePath, maxStdoutBytes: 64 * 1024 })).stdout.trim();
          captureIndex = path.join(gitDir, `deerhux-capture-index-${token}`);
          captureEnv.GIT_INDEX_FILE = captureIndex;
          await repository.run(["read-tree", "HEAD"], { cwd: worker.worktreePath, env: captureEnv, signal: options.signal });
          const candidates = (await repository.run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
            cwd: worker.worktreePath, env: captureEnv, signal: options.signal, maxStdoutBytes: 64 * 1024 * 1024,
          })).stdout.split("\0").filter(Boolean);
          const included = [...new Set(candidates)].filter((candidate) => !syntheticPaths.some((synthetic) => candidate === synthetic || candidate.startsWith(`${synthetic}/`)));
          if (included.length) await repository.run(["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            cwd: worker.worktreePath, env: captureEnv, signal: options.signal, stdin: `${included.join("\0")}\0`,
          });
        } else {
          await repository.run(["add", "-A", "--", "."], { cwd: worker.worktreePath, signal: options.signal });
        }

        const artifactDirectory = path.resolve(options.artifactDirectory ?? path.join(path.dirname(manifestPath), "artifacts"));
        await fsp.mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
        tempPatch = path.join(artifactDirectory, `.${token}.patch.tmp`);
        const patchFd = fs.openSync(tempPatch, "wx", 0o600);
        fs.closeSync(patchFd);
        await repository.run([
          "diff", "--cached", "--binary", "--full-index", "--find-renames", "--no-ext-diff", "--no-textconv", `--output=${tempPatch}`,
          manifest.baseCommit,
        ], {
          cwd: worker.worktreePath,
          env: captureEnv,
          signal: options.signal,
          timeoutMs: 5 * 60_000,
          readTimeoutMs: 60_000,
          maxStdoutBytes: 4096,
          maxStderrBytes: 1024 * 1024,
        });
        await options.faults?.afterPatchWrite?.(tempPatch);
        fs.chmodSync(tempPatch, 0o600);
        const patchStat = await fsp.stat(tempPatch);
        if (!patchStat.isFile() || patchStat.size > MAX_WORKTREE_PATCH_BYTES) {
          throw new ArtifactCaptureError("ARTIFACT_PATCH_TOO_LARGE", "Generated patch exceeds the maximum supported size");
        }
        fsyncFile(tempPatch);

        const firstDigest = await hashFile(tempPatch);
        await options.faults?.beforeDigestVerify?.(tempPatch);
        const secondDigest = await hashFile(tempPatch);
        if (options.faults?.forceDigestMismatch || firstDigest.sha256 !== secondDigest.sha256 || firstDigest.bytes !== secondDigest.bytes) {
          throw new ArtifactCaptureError("ARTIFACT_DIGEST_MISMATCH", "Patch digest changed during verification");
        }

        const trees = await verifyPatchTree(repository, worker.worktreePath, manifest.baseCommit, tempPatch, token, captureEnv);
        if (options.faults?.forceTreeMismatch || trees.stagedTree !== trees.rebuiltTree) {
          throw new ArtifactCaptureError("ARTIFACT_TREE_MISMATCH", "Patch tree does not equal worker staged tree");
        }
        const fileChanges = await captureFileChanges(repository, worker.worktreePath, manifest.baseCommit, trees.stagedTree);

        const artifactName = `${safeWorkerToken(workerId)}-${secondDigest.sha256}.patch`;
        publishedPatch = path.join(artifactDirectory, artifactName);
        let existingMatches = false;
        try {
          const existing = await hashFile(publishedPatch);
          existingMatches = existing.sha256 === secondDigest.sha256 && existing.bytes === secondDigest.bytes;
          if (!existingMatches) throw new ArtifactCaptureError("ARTIFACT_DIGEST_MISMATCH", "Existing content-addressed artifact has different bytes");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (existingMatches) {
          await fsp.rm(tempPatch, { force: true });
          tempPatch = null;
        } else {
          await options.faults?.beforeArtifactRename?.(tempPatch, publishedPatch);
          fs.renameSync(tempPatch, publishedPatch);
          tempPatch = null;
          publishedByThisCall = true;
          fs.chmodSync(publishedPatch, 0o600);
          fsyncDirectory(artifactDirectory);
        }

        const capture: WorktreeCaptureV1 = {
          changed: secondDigest.bytes > 0,
          workerBranch: branch,
          workerHead: head,
          patchPath: publishedPatch,
          patchSha256: secondDigest.sha256,
          patchBytes: secondDigest.bytes,
          changedFiles: fileChanges.map((file) => file.path),
          binaryFiles: fileChanges.filter((file) => file.binary).map((file) => file.path),
          fileChanges,
          capturedAt: now,
          captureError: null,
        };
        const next = successfulManifest(manifest, workerId, branch, capture, now);
        await verifySynthetic();
        try {
          await options.faults?.beforeManifestWrite?.();
          writeWorktreeManifestAtomic(manifestPath, next);
        } catch (error) {
          throw new ArtifactCaptureError("ARTIFACT_MANIFEST_WRITE_FAILED", "Unable to persist artifact capture", { cause: error });
        }
        return {
          ok: true, workerId, workerBranch: branch, workerHead: head, capture,
          treeDigest: trees.stagedTree, errorCode: null, error: null, manifestStatePersisted: true,
        };
      } catch (error) {
        const code = classifyError(error);
        if (tempPatch) await fsp.rm(tempPatch, { force: true });
        if (publishedByThisCall && publishedPatch) {
          await fsp.rm(publishedPatch, { force: true });
          try { fsyncDirectory(path.dirname(publishedPatch)); } catch { /* preserve primary error */ }
        }
        const manifestStatePersisted = await persistPreservedBestEffort(manifestPath, manifest, workerId, now, code);
        return {
          ok: false, workerId, workerBranch: branch, workerHead: head, capture: worker?.capture ?? null,
          treeDigest: null, errorCode: code, error: publicArtifactError(code), manifestStatePersisted,
        };
      } finally {
        if (captureIndex) {
          await fsp.rm(captureIndex, { force: true });
          await fsp.rm(`${captureIndex}.lock`, { force: true });
          captureIndex = null;
        }
      }
    });
  } catch (error) {
    const code = classifyError(error);
    return {
      ok: false, workerId, workerBranch: branch, workerHead: head, capture: worker?.capture ?? null,
      treeDigest: null, errorCode: code, error: publicArtifactError(code), manifestStatePersisted: false,
    };
  }
}
