import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { GitRepository } from "./git-repository.ts";
import {
  transitionWorktreeManifest,
  writeWorktreeManifestAtomic,
  MAX_WORKTREE_PATCH_BYTES,
  readWorktreeManifestDigest,
  type WorktreeManifestV1,
  type WorktreeManifestWorkerV1,
} from "./worktree-manifest.ts";
import { collectGitFacts, scanRunsRoot, type GitFacts, type ScannedRun } from "./worktree-reconciler.ts";
import { beginWorktreeOperation, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";

export const DISCARD_TOKEN_TTL_MS = 5 * 60_000;
export const DISCARD_STRONG_CONFIRMATION = "DISCARD_UNCAPTURED_CHANGES" as const;
export const MAX_DISCARD_TOKENS = 256;

export type DiscardRiskCode = "UNCAPTURED_DIRTY_WORKTREE" | "WORKTREE_CHANGED_AFTER_CAPTURE" | "IGNORED_FILES_PRESENT" | "WORKTREE_CONTENT_UNVERIFIED";
export type DiscardBlockCode =
  | "MANIFEST_UNAVAILABLE"
  | "MANIFEST_CHANGED"
  | "RUN_MISMATCH"
  | "WORKER_UNKNOWN"
  | "WORKER_ACTIVE"
  | "RUN_OPERATION_ACTIVE"
  | "UNSAFE_PATH"
  | "REPOSITORY_MISMATCH"
  | "GIT_FACTS_UNAVAILABLE"
  | "ARTIFACT_INVALID";

export interface DiscardWorkerPreview {
  workerId: string;
  worktree: boolean;
  branch: boolean;
  patch: boolean;
  sessionCapability: "unavailable" | "continue_will_be_lost" | "history_only";
  risks: DiscardRiskCode[];
  blockedBy: DiscardBlockCode[];
  /** Resources intentionally retained because no reliable writer freeze exists or audit retention is active. */
  retainedResources: Array<"worktree" | "branch" | "patch">;
}

export interface DiscardPreviewResult {
  ok: boolean;
  mode: "preview";
  runId: string;
  manifestVersion: number;
  manifestDigest: string;
  workerIds: string[];
  workers: DiscardWorkerPreview[];
  riskCodes: DiscardRiskCode[];
  /** Null means uncaptured or post-capture changes make an exact count unavailable. */
  unappliedFileCount: number | null;
  requiresStrongConfirmation: boolean;
  confirmationToken?: string;
  tokenExpiresAt?: string;
  errorCode?: DiscardBlockCode;
}

export interface DiscardWorkerResult {
  workerId: string;
  success: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  patchRemoved: boolean;
  retainedResources: Array<"worktree" | "branch" | "patch">;
  reason: "DISCARDED" | "ALREADY_REMOVED" | "PRESERVED_FOR_RECOVERY" | "PRECONDITION_CHANGED" | "PARTIAL_CLEANUP" | DiscardBlockCode;
}

export interface DiscardCommitResult {
  ok: boolean;
  complete: boolean;
  mode: "commit";
  runId: string;
  workers: DiscardWorkerResult[];
  errorCode?: "TOKEN_INVALID" | "TOKEN_EXPIRED" | "MANIFEST_CHANGED" | "PRECONDITION_FAILED" | "INTERNAL_ERROR";
}

/** Independent host/Store creation identity; never accepted from the HTTP body or the manifest itself. */
export interface DiscardRepositoryIdentity { root: string; commonDir: string; baseCommit: string }

interface TokenBinding {
  runId: string;
  manifestPath: string;
  manifestVersion: number;
  manifestDigest: string;
  workerIds: string[];
  acknowledgedRisks: DiscardRiskCode[];
  branchOids: Record<string, string | null>;
  expiresAt: number;
  repositoryIdentity: DiscardRepositoryIdentity;
}

const tokenRegistryKey = Symbol.for("deerhux.worktreeDiscardTokens");
const globalRegistry = globalThis as typeof globalThis & { [tokenRegistryKey]?: Map<string, TokenBinding> };
const tokens = globalRegistry[tokenRegistryKey] ??= new Map<string, TokenBinding>();

function digestManifest(manifestPath: string): string | null {
  return readWorktreeManifestDigest(manifestPath);
}

function normalizedBranch(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

async function repositoryMatchesAuthority(manifest: WorktreeManifestV1, identity?: DiscardRepositoryIdentity): Promise<boolean> {
  if (!identity || manifest.repoRoot !== identity.root || manifest.gitCommonDir !== identity.commonDir
    || manifest.baseCommit !== identity.baseCommit || !/^[a-f0-9]{40,64}$/.test(identity.baseCommit)) return false;
  try {
    const repository = await GitRepository.open(identity.root);
    return repository.root === identity.root && repository.commonDir === identity.commonDir;
  } catch { return false; }
}

function strictReadRun(manifestPath: string, expectedRunId: string): { run: ScannedRun; digest: string } | null {
  const runDir = path.dirname(manifestPath);
  const runsRoot = path.dirname(runDir);
  const scan = scanRunsRoot(runsRoot);
  let canonicalManifestPath: string;
  try { canonicalManifestPath = fs.realpathSync.native(manifestPath); } catch { return null; }
  const run = scan.runs.find((candidate) => candidate.manifestPath === canonicalManifestPath && candidate.manifest.runId === expectedRunId);
  const digest = digestManifest(manifestPath);
  return run && digest ? { run, digest } : null;
}

function assessWorker(worker: WorktreeManifestWorkerV1, facts: GitFacts): { risks: DiscardRiskCode[]; blockedBy: DiscardBlockCode[] } {
  const risks: DiscardRiskCode[] = [];
  const blockedBy: DiscardBlockCode[] = [];
  if (["planned", "creating", "running"].includes(worker.state)) blockedBy.push("WORKER_ACTIVE");
  if (!facts.pathSafe) blockedBy.push("UNSAFE_PATH");
  if (!facts.repoMatches) blockedBy.push("REPOSITORY_MISMATCH");
  if (facts.errorCode) blockedBy.push("GIT_FACTS_UNAVAILABLE");
  if (facts.worktreeExists && facts.dirty === null) risks.push("WORKTREE_CONTENT_UNVERIFIED");
  if (worker.capture?.changed && (!facts.artifactExists || !facts.artifactDigestMatches)) blockedBy.push("ARTIFACT_INVALID");
  if (facts.dirty && !worker.capture) risks.push("UNCAPTURED_DIRTY_WORKTREE");
  if (facts.ignoredFilesPresent) risks.push("IGNORED_FILES_PRESENT");
  if (worker.capture && facts.captureMatchesWorktree === false) risks.push("WORKTREE_CHANGED_AFTER_CAPTURE");
  return { risks: [...new Set(risks)], blockedBy: [...new Set(blockedBy)] };
}

function factsStable(before: GitFacts, after: GitFacts): boolean {
  return before.pathSafe === after.pathSafe
    && before.repoMatches === after.repoMatches
    && before.worktreeExists === after.worktreeExists
    && before.worktreeRegistered === after.worktreeRegistered
    && before.branchOid === after.branchOid
    && before.worktreeBranch === after.worktreeBranch
    && before.head === after.head
    && before.dirty === after.dirty
    && before.ignoredFilesPresent === after.ignoredFilesPresent
    && before.artifactExists === after.artifactExists
    && before.artifactDigestMatches === after.artifactDigestMatches
    && before.captureMatchesWorktree === after.captureMatchesWorktree
    && before.errorCode === after.errorCode;
}

function patchAuditActive(worker: WorktreeManifestWorkerV1, _now: number): boolean {
  // V1 does not persist a retention start tied to the latest Apply/Discard.
  // `capturedAt` can predate a recent Apply, so deleting from that timestamp
  // could violate the seven-day audit guarantee. Conservatively retain every
  // extant patch until a future manifest version can represent that boundary.
  return Boolean(worker.capture?.patchPath);
}

async function collectDiscardFacts(manifest: WorktreeManifestV1, worker: WorktreeManifestWorkerV1, runDir: string): Promise<GitFacts> {
  const artifactVerification: { exists: boolean; sha256: string | null } = { exists: false, sha256: null };
  const capture = worker.capture;
  if (capture?.patchPath) {
    let handle: fsp.FileHandle | undefined;
    try {
      const runReal = await fsp.realpath(runDir);
      const artifactRoot = path.join(runReal, "artifacts");
      const runNode = await fsp.lstat(runDir);
      const rootNode = await fsp.lstat(artifactRoot);
      const owned = (stat: fs.Stats) => typeof process.getuid !== "function" || stat.uid === process.getuid();
      if (!runNode.isDirectory() || runNode.isSymbolicLink() || !owned(runNode) || (runNode.mode & 0o777) !== 0o700
        || !rootNode.isDirectory() || rootNode.isSymbolicLink() || !owned(rootNode) || (rootNode.mode & 0o777) !== 0o700
        || await fsp.realpath(path.dirname(capture.patchPath)) !== artifactRoot) {
        throw new Error("artifact directory is not private and contained");
      }
      const node = await fsp.lstat(capture.patchPath);
      artifactVerification.exists = true;
      if (node.isFile() && !node.isSymbolicLink() && owned(node) && (node.mode & 0o777) === 0o600) {
        handle = await fsp.open(capture.patchPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const opened = await handle.stat();
        if (opened.isFile() && owned(opened) && (opened.mode & 0o777) === 0o600 && opened.dev === node.dev && opened.ino === node.ino
          && opened.size === capture.patchBytes && opened.size <= MAX_WORKTREE_PATCH_BYTES) {
          const hash = createHash("sha256");
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let offset = 0;
          while (offset < opened.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
            if (bytesRead === 0) throw new Error("artifact shortened during verification");
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          const after = await handle.stat();
          if (after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs) {
            artifactVerification.sha256 = hash.digest("hex");
          }
        }
      }
    } catch (error) {
      // An unreadable resource is retained, not treated as already deleted.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") artifactVerification.exists = true;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return collectGitFacts(manifest, worker, runDir, { artifactVerification });
}

export async function previewWorktreeDiscard(...args: Parameters<typeof previewWorktreeDiscardInternal>): ReturnType<typeof previewWorktreeDiscardInternal> {
  const operation = beginWorktreeOperation("cleanup", { runId: args[0].runId });
  try {
    const result = await previewWorktreeDiscardInternal(...args);
    operation.finish(result.ok ? "planned" : "failed", {
      reason: result.errorCode ? worktreeDiagnosticReason(result.errorCode) : "none",
      preservedCount: result.workers.filter((worker) => worker.retainedResources.length > 0).length,
    });
    return result;
  } catch (error) {
    operation.finish("failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

async function previewWorktreeDiscardInternal(options: {
  runId: string;
  manifestPath: string;
  workerIds: string[];
  strongConfirmation?: string;
  sessionCapabilities?: Record<string, { hasSession: boolean; canContinue: boolean }>;
  now?: number;
  trustedRepository?: DiscardRepositoryIdentity;
}): Promise<DiscardPreviewResult> {
  const now = options.now ?? Date.now();
  for (const [token, binding] of tokens) if (binding.expiresAt < now) tokens.delete(token);
  const strict = strictReadRun(options.manifestPath, options.runId);
  if (!strict) {
    return { ok: false, mode: "preview", runId: options.runId, manifestVersion: 0, manifestDigest: "", workerIds: options.workerIds, workers: [], riskCodes: [], unappliedFileCount: null, requiresStrongConfirmation: false, errorCode: "MANIFEST_UNAVAILABLE" };
  }
  if (!await repositoryMatchesAuthority(strict.run.manifest, options.trustedRepository)) {
    return { ok: false, mode: "preview", runId: options.runId, manifestVersion: strict.run.manifest.version,
      manifestDigest: strict.digest, workerIds: options.workerIds, workers: [], riskCodes: [],
      unappliedFileCount: null, requiresStrongConfirmation: false, errorCode: "REPOSITORY_MISMATCH" };
  }
  const selected = [...new Set(options.workerIds)].sort();
  const knownIds = new Set(strict.run.manifest.workers.map((worker) => worker.workerId));
  if (selected.length === 0 || selected.some((id) => !knownIds.has(id))) {
    return { ok: false, mode: "preview", runId: options.runId, manifestVersion: strict.run.manifest.version, manifestDigest: strict.digest, workerIds: selected, workers: [], riskCodes: [], unappliedFileCount: null, requiresStrongConfirmation: false, errorCode: "WORKER_UNKNOWN" };
  }
  const operationBlocked = strict.run.manifest.activeOperation !== null;
  const previewFacts = new Map<string, GitFacts>();
  const workers: DiscardWorkerPreview[] = [];
  for (const workerId of selected) {
    const worker = strict.run.manifest.workers.find((candidate) => candidate.workerId === workerId)!;
    const facts = await collectDiscardFacts(strict.run.manifest, worker, strict.run.runDir);
    previewFacts.set(workerId, facts);
    const assessment = assessWorker(worker, facts);
    if (operationBlocked) assessment.blockedBy.push("RUN_OPERATION_ACTIVE");
    const session = options.sessionCapabilities?.[workerId];
    const retainPatch = facts.artifactExists && patchAuditActive(worker, now);
    const retainedResources: DiscardWorkerPreview["retainedResources"] = [];
    if (facts.worktreeExists) retainedResources.push("worktree");
    const captureProvesBranch = worker.capture?.captureError === null
      && Boolean(worker.capture.patchPath && worker.capture.patchSha256 && worker.capture.patchBytes !== null)
      && facts.artifactExists && facts.artifactDigestMatches;
    const authorizedBranchOid = captureProvesBranch ? worker.capture!.workerHead : strict.run.manifest.baseCommit;
    if (facts.branchOid && (facts.worktreeExists || facts.branchOid !== authorizedBranchOid)) retainedResources.push("branch");
    if (facts.worktreeExists ? facts.artifactExists : retainPatch) retainedResources.push("patch");
    workers.push({
      workerId,
      worktree: facts.worktreeExists || facts.worktreeRegistered,
      branch: Boolean(facts.branchOid),
      patch: facts.artifactExists,
      sessionCapability: !session?.hasSession ? "unavailable" : session.canContinue ? "continue_will_be_lost" : "history_only",
      risks: assessment.risks,
      blockedBy: assessment.blockedBy,
      retainedResources,
    });
  }
  const riskCodes = [...new Set(workers.flatMap((worker) => worker.risks))];
  const selectedWorkers = selected.map((workerId) => strict.run.manifest.workers.find((worker) => worker.workerId === workerId)!);
  const exactFileCountAvailable = selectedWorkers.every((worker, index) => (
    worker.capture !== null
      && worker.capture.captureError === null
      && !workers[index].risks.includes("UNCAPTURED_DIRTY_WORKTREE")
      && !workers[index].risks.includes("WORKTREE_CHANGED_AFTER_CAPTURE")
      && !workers[index].risks.includes("WORKTREE_CONTENT_UNVERIFIED")
  ));
  const unappliedFileCount = exactFileCountAvailable
    ? new Set(selectedWorkers.flatMap((worker) => {
        const changedFiles = worker.capture?.changedFiles ?? [];
        const apply = strict.run.manifest.apply;
        if (!apply?.requestedWorkerIds.includes(worker.workerId)) return changedFiles;
        const applied = new Set(apply.appliedFiles);
        return changedFiles.filter((file) => !applied.has(file));
      })).size
    : null;
  const blocked = workers.some((worker) => worker.blockedBy.length > 0);
  const riskAcknowledged = riskCodes.length === 0 || options.strongConfirmation === DISCARD_STRONG_CONFIRMATION;
  const result: DiscardPreviewResult = {
    ok: !blocked,
    mode: "preview",
    runId: options.runId,
    manifestVersion: strict.run.manifest.version,
    manifestDigest: strict.digest,
    workerIds: selected,
    workers,
    riskCodes,
    unappliedFileCount,
    requiresStrongConfirmation: riskCodes.length > 0 && !riskAcknowledged,
  };
  if (!blocked && riskAcknowledged) {
    // A newer preview for the same selection supersedes older authority and bounds
    // per-run accumulation. Expired entries were removed above.
    for (const [token, binding] of tokens) {
      if (binding.runId === options.runId && binding.workerIds.join("\0") === selected.join("\0")) tokens.delete(token);
    }
    while (tokens.size >= MAX_DISCARD_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      tokens.delete(oldest);
    }
    const confirmationToken = randomBytes(32).toString("base64url");
    const expiresAt = now + DISCARD_TOKEN_TTL_MS;
    tokens.set(confirmationToken, {
      repositoryIdentity: { ...options.trustedRepository! },
      runId: options.runId,
      manifestPath: options.manifestPath,
      manifestVersion: strict.run.manifest.version,
      manifestDigest: strict.digest,
      workerIds: selected,
      acknowledgedRisks: riskCodes,
      branchOids: Object.fromEntries(selected.map((workerId) => [workerId, previewFacts.get(workerId)?.branchOid ?? null])),
      expiresAt,
    });
    result.confirmationToken = confirmationToken;
    result.tokenExpiresAt = new Date(expiresAt).toISOString();
  }
  return result;
}

export async function commitWorktreeDiscard(...args: Parameters<typeof commitWorktreeDiscardInternal>): ReturnType<typeof commitWorktreeDiscardInternal> {
  const operation = beginWorktreeOperation("cleanup", { runId: args[0].runId });
  try {
    const result = await commitWorktreeDiscardInternal(...args);
    operation.finish(result.complete ? "removed" : result.workers.length > 0 ? "partial" : "failed", {
      reason: result.errorCode ? worktreeDiagnosticReason(result.errorCode) : result.complete ? "none" : "unknown",
      preservedCount: result.workers.filter((worker) => worker.retainedResources.length > 0).length,
      removedWorktreeCount: result.workers.filter((worker) => worker.worktreeRemoved).length,
      removedBranchCount: result.workers.filter((worker) => worker.branchRemoved).length,
    });
    return result;
  } catch (error) {
    operation.finish("failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

async function commitWorktreeDiscardInternal(options: {
  runId: string;
  confirmationToken: string;
  now?: number;
  /** Test/fault-injection seam; production callers must not provide it. */
  beforeWorkerDiscard?: (workerId: string) => void | Promise<void>;
}): Promise<DiscardCommitResult> {
  const binding = tokens.get(options.confirmationToken);
  tokens.delete(options.confirmationToken); // Consume before doing any I/O: every token is single-use, including failed commits.
  if (!binding || binding.runId !== options.runId) return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "TOKEN_INVALID" };
  if (binding.expiresAt < (options.now ?? Date.now())) return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "TOKEN_EXPIRED" };
  const strict = strictReadRun(binding.manifestPath, binding.runId);
  if (!strict || strict.digest !== binding.manifestDigest || strict.run.manifest.version !== binding.manifestVersion) {
    return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "MANIFEST_CHANGED" };
  }
  if (!await repositoryMatchesAuthority(strict.run.manifest, binding.repositoryIdentity)) {
    return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "PRECONDITION_FAILED" };
  }
  let repository: GitRepository;
  try { repository = await GitRepository.open(strict.run.manifest.repoRoot, { instanceId: strict.run.manifest.instanceId }); }
  catch { return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "PRECONDITION_FAILED" }; }
  try {
    return await repository.withWriteLock({ operation: `discard:${binding.runId}` }, async () => {
      const locked = strictReadRun(binding.manifestPath, binding.runId);
      if (!locked || locked.digest !== binding.manifestDigest || locked.run.manifest.version !== binding.manifestVersion) {
        return { ok: false, complete: false, mode: "commit" as const, runId: options.runId, workers: [], errorCode: "MANIFEST_CHANGED" as const };
      }
      if (!await repositoryMatchesAuthority(locked.run.manifest, binding.repositoryIdentity)) {
        return { ok: false, complete: false, mode: "commit" as const, runId: options.runId, workers: [], errorCode: "PRECONDITION_FAILED" as const };
      }
      if (locked.run.manifest.activeOperation !== null) {
        return { ok: false, complete: false, mode: "commit" as const, runId: options.runId, workers: [], errorCode: "PRECONDITION_FAILED" as const };
      }
      const selected = binding.workerIds.map((id) => locked.run.manifest.workers.find((worker) => worker.workerId === id));
      if (selected.some((worker) => !worker)) {
        return { ok: false, complete: false, mode: "commit" as const, runId: options.runId, workers: [], errorCode: "MANIFEST_CHANGED" as const };
      }
      const initialFacts = new Map<string, GitFacts>();
      for (const worker of selected as WorktreeManifestWorkerV1[]) {
        const facts = await collectDiscardFacts(locked.run.manifest, worker, locked.run.runDir);
        const assessment = assessWorker(worker, facts);
        if (facts.branchOid !== binding.branchOids[worker.workerId]
          || assessment.blockedBy.length > 0
          || assessment.risks.some((risk) => !binding.acknowledgedRisks.includes(risk))) {
          return { ok: false, complete: false, mode: "commit" as const, runId: options.runId, workers: [], errorCode: "PRECONDITION_FAILED" as const };
        }
        initialFacts.set(worker.workerId, facts);
      }

      const manifest = locked.run.manifest;
      manifest.activeOperation = "cleanup";
      manifest.updatedAt = new Date().toISOString();
      writeWorktreeManifestAtomic(binding.manifestPath, manifest);
      const results: DiscardWorkerResult[] = [];
      for (const workerId of binding.workerIds) {
        const worker = manifest.workers.find((candidate) => candidate.workerId === workerId)!;
        const before = initialFacts.get(workerId)!;
        if (worker.state === "removed" && worker.cleanup?.worktreeRemoved && worker.cleanup.branchRemoved
          && !before.worktreeExists && !before.worktreeRegistered && !before.branchOid && !before.artifactExists) {
          results.push({ workerId, success: true, worktreeRemoved: true, branchRemoved: true, patchRemoved: true, retainedResources: [], reason: "ALREADY_REMOVED" });
          continue;
        }
        await options.beforeWorkerDiscard?.(workerId);
        const fresh = await collectDiscardFacts(manifest, worker, locked.run.runDir);
        const freshAssessment = assessWorker(worker, fresh);
        // Even when facts changed after confirmation, retaining this directory is
        // always the safe outcome. Persist that decision instead of deleting or
        // merely returning an ephemeral precondition error.
        if (fresh.worktreeExists) {
          worker.state = "preserved";
          worker.cleanup = {
            intent: "discard", eligibility: "manual_review", checkedAt: new Date().toISOString(),
            worktreeRemoved: false, branchRemoved: false, reason: "writer_freeze_unavailable",
          };
          manifest.updatedAt = new Date().toISOString();
          writeWorktreeManifestAtomic(binding.manifestPath, manifest);
          results.push({
            workerId, success: false, worktreeRemoved: false, branchRemoved: false,
            patchRemoved: false,
            retainedResources: ["worktree", ...(fresh.branchOid ? ["branch" as const] : []), ...(fresh.artifactExists ? ["patch" as const] : [])],
            reason: "PRESERVED_FOR_RECOVERY",
          });
          continue;
        }
        if (!factsStable(before, fresh) || freshAssessment.blockedBy.length > 0 || freshAssessment.risks.some((risk) => !binding.acknowledgedRisks.includes(risk))) {
          results.push({ workerId, success: false, worktreeRemoved: !fresh.worktreeRegistered, branchRemoved: !fresh.branchOid, patchRemoved: !fresh.artifactExists, retainedResources: [
            ...(fresh.worktreeRegistered ? ["worktree" as const] : []), ...(fresh.branchOid ? ["branch" as const] : []), ...(fresh.artifactExists ? ["patch" as const] : []),
          ], reason: "PRECONDITION_CHANGED" });
          continue;
        }
        let worktreeRemoved = !fresh.worktreeExists && !fresh.worktreeRegistered;
        let branchRemoved = !fresh.branchOid;
        let patchRemoved = !fresh.artifactExists;
        const captureProvesBranch = worker.capture?.captureError === null
          && Boolean(worker.capture.patchPath && worker.capture.patchSha256 && worker.capture.patchBytes !== null)
          && fresh.artifactExists && fresh.artifactDigestMatches;
        const authorizedBranchOid = captureProvesBranch ? worker.capture!.workerHead : manifest.baseCommit;
        if (fresh.branchOid && fresh.branchOid !== authorizedBranchOid) {
          worker.state = "preserved";
          worker.cleanup = {
            intent: "discard", eligibility: "manual_review", checkedAt: new Date().toISOString(),
            worktreeRemoved: !fresh.worktreeExists, branchRemoved: false, reason: "branch_head_not_captured",
          };
          manifest.updatedAt = new Date().toISOString();
          writeWorktreeManifestAtomic(binding.manifestPath, manifest);
          results.push({
            workerId, success: false, worktreeRemoved: !fresh.worktreeExists, branchRemoved: false, patchRemoved,
            retainedResources: ["branch", ...(fresh.artifactExists ? ["patch" as const] : [])],
            reason: "PRESERVED_FOR_RECOVERY",
          });
          continue;
        }
        worker.cleanup = { intent: "discard", eligibility: "eligible", checkedAt: new Date().toISOString(), worktreeRemoved, branchRemoved, reason: "explicit_discard" };
        manifest.updatedAt = new Date().toISOString();
        writeWorktreeManifestAtomic(binding.manifestPath, manifest);
        try {
          if (!worktreeRemoved) {
            // Only stale registration metadata remains: pruning cannot delete a
            // directory because the canonical worktree path was verified absent.
            await repository.run(["worktree", "prune"]);
            const pruned = await collectDiscardFacts(manifest, worker, locked.run.runDir);
            if (pruned.worktreeExists || pruned.worktreeRegistered) throw new Error("worktree registration remains");
            worktreeRemoved = true;
            worker.cleanup.worktreeRemoved = true;
          }
          if (!branchRemoved) {
            await repository.run(["update-ref", "-d", normalizedBranch(worker.branch), fresh.branchOid!]);
            branchRemoved = true;
            worker.cleanup.branchRemoved = true;
          }
          const patchPath = worker.capture?.patchPath;
          const retainPatch = fresh.artifactExists && patchAuditActive(worker, options.now ?? Date.now());
          if (patchPath && fresh.artifactExists && !retainPatch) {
            const lastFacts = await collectDiscardFacts(manifest, worker, locked.run.runDir);
            if (!lastFacts.pathSafe || !lastFacts.artifactDigestMatches) throw new Error("artifact changed");
            fs.unlinkSync(patchPath);
            patchRemoved = true;
          }
          if (retainPatch) {
            worker.state = "preserved";
            worker.cleanup.eligibility = "manual_review";
            worker.cleanup.reason = "artifact_audit_retained";
            results.push({
              workerId, success: false, worktreeRemoved, branchRemoved, patchRemoved: false,
              retainedResources: ["patch"], reason: "PRESERVED_FOR_RECOVERY",
            });
          } else {
            worker.state = "removed";
            results.push({ workerId, success: true, worktreeRemoved, branchRemoved, patchRemoved, retainedResources: [], reason: "DISCARDED" });
          }
        } catch {
          worker.state = "cleanup_error";
          worker.cleanup.reason = "partial_cleanup";
          results.push({ workerId, success: false, worktreeRemoved, branchRemoved, patchRemoved, retainedResources: [
            ...(!worktreeRemoved ? ["worktree" as const] : []), ...(!branchRemoved ? ["branch" as const] : []), ...(!patchRemoved ? ["patch" as const] : []),
          ], reason: "PARTIAL_CLEANUP" });
        }
        manifest.updatedAt = new Date().toISOString();
        writeWorktreeManifestAtomic(binding.manifestPath, manifest);
      }
      try { await repository.run(["worktree", "prune"]); } catch { /* Per-worker facts remain authoritative. */ }
      manifest.activeOperation = null;
      const complete = results.length > 0 && results.every((result) => result.success);
      if (complete && manifest.state !== "discarded" && manifest.workers.every((worker) => worker.state === "removed")) {
        const transitioned = transitionWorktreeManifest(manifest, "discarded", {
          caller: "cleanup", now: new Date().toISOString(), explicitDiscardConfirmed: true,
          workersTerminated: true, patchVerified: true, manifestPersisted: true,
        });
        Object.assign(manifest, transitioned);
      } else {
        manifest.updatedAt = new Date().toISOString();
      }
      writeWorktreeManifestAtomic(binding.manifestPath, manifest);
      return { ok: complete, complete, mode: "commit" as const, runId: options.runId, workers: results };
    });
  } catch {
    return { ok: false, complete: false, mode: "commit", runId: options.runId, workers: [], errorCode: "INTERNAL_ERROR" };
  }
}

export function clearDiscardTokensForTests(): void {
  tokens.clear();
}
