import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitRepository } from "./git-repository.ts";
import { recoverPendingAtomicApply } from "./atomic-apply.ts";
import { beginWorktreeOperation, hashWorktreeRepository, recordWorktreeDecision, worktreeDiagnosticReason } from "./worktree-diagnostics.ts";
import {
  readWorktreeManifest,
  validateWorktreeManifest,
  writeWorktreeManifestAtomic,
  assertPrivateWorktreeDirectory,
  openManagedWorktreeFile,
  sameManagedFileStat,
  MAX_WORKTREE_PATCH_BYTES,
  type WorktreeManifestV1,
  type WorktreeManifestWorkerV1,
} from "./worktree-manifest.ts";

export const WORKTREE_TTL_MS = 2 * 60 * 60_000;
export const WORKTREE_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const HEARTBEAT_STALE_MS = 90_000;
export const WORKTREE_MANIFEST_FILE = "worktree-manifest.json";

export interface GitFacts {
  workerId: string;
  repoMatches: boolean;
  pathSafe: boolean;
  worktreeExists: boolean;
  worktreeRegistered: boolean;
  branchOid: string | null;
  worktreeBranch: string | null;
  head: string | null;
  dirty: boolean | null;
  ignoredFilesPresent: boolean | null;
  artifactExists: boolean;
  artifactDigestMatches: boolean;
  captureMatchesWorktree: boolean | null;
  errorCode?: string;
}

export type CleanupReason =
  | "eligible_applied"
  | "eligible_discarded"
  | "eligible_no_changes"
  | "foreign_owner_active"
  | "owner_operation_active"
  | "continue_ttl_active"
  | "artifact_audit_retained"
  | "manifest_not_settled"
  | "worktree_dirty_without_artifact"
  | "branch_ahead_without_artifact"
  | "repo_identity_mismatch"
  | "artifact_invalid"
  | "worktree_changed_after_capture"
  | "worktree_requires_explicit_discard"
  | "unsafe_path"
  | "untrusted_creation_identity"
  | "git_facts_unavailable";

export interface WorkerCleanupPlan {
  workerId: string;
  decision: "cleanup" | "retain";
  reason: CleanupReason;
  facts: GitFacts;
}

export interface CleanupPlan {
  runDir: string;
  manifestPath: string;
  manifest: WorktreeManifestV1;
  workers: WorkerCleanupPlan[];
  plannedAt: string;
}

export interface ScannedRun {
  runDir: string;
  manifestPath: string;
  manifest: WorktreeManifestV1;
}

export interface ScanIssue {
  path: string;
  reason: "unknown_directory" | "symlink" | "invalid_manifest" | "unsafe_path";
}

export interface ScanRunsResult {
  runs: ScannedRun[];
  issues: ScanIssue[];
}

export interface ReconcileOptions {
  runsRoot: string;
  now?: number;
  instanceId: string;
  processStartIdentity: string;
  isProcessAlive?: (pid: number, processStartIdentity: string) => boolean;
}

export interface ReconcileResult {
  recovered: Array<{ runId: string; state: "recoverable" | "captured" | "applied" | "discarded" | "recovery_failed" | "apply_recovery_required" }>;
  plans: CleanupPlan[];
  issues: ScanIssue[];
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonicalExisting(target: string): string | null {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

function canonicalExistingOrMissing(target: string): string | null {
  let ancestor = path.resolve(target);
  const missingSegments: string[] = [];
  while (true) {
    const ancestorReal = canonicalExisting(ancestor);
    if (ancestorReal) return path.join(ancestorReal, ...missingSegments);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
  }
}

function isSymlink(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function artifactPathSafe(runDir: string, artifactPath: string): boolean {
  const root = path.join(path.resolve(runDir), "artifacts");
  if (!path.isAbsolute(artifactPath)
    || canonicalExistingOrMissing(path.dirname(artifactPath)) !== canonicalExistingOrMissing(root)) return false;
  try {
    assertPrivateWorktreeDirectory(runDir);
    assertPrivateWorktreeDirectory(root);
    assertPrivateWorktreeDirectory(path.dirname(artifactPath));
    const stat = fs.lstatSync(artifactPath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600
      && (typeof process.getuid !== "function" || stat.uid === process.getuid())
      && stat.size <= MAX_WORKTREE_PATCH_BYTES
      && canonicalExisting(path.dirname(artifactPath)) === canonicalExisting(root);
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"
    && canonicalExistingOrMissing(root) === path.join(canonicalExisting(runDir) ?? "", "artifacts"); }
}

function artifactDigest(filePath: string, expectedBytes: number | null): { exists: boolean; sha256: string | null } {
  let fd: number | undefined;
  try {
    const opened = openManagedWorktreeFile(filePath, MAX_WORKTREE_PATCH_BYTES);
    fd = opened.fd;
    if (opened.stat.size !== expectedBytes) return { exists: true, sha256: null };
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, MAX_WORKTREE_PATCH_BYTES + 1 - total), null);
      if (!count) break;
      total += count;
      if (total > MAX_WORKTREE_PATCH_BYTES) return { exists: true, sha256: null };
      hash.update(chunk.subarray(0, count));
    }
    assertPrivateWorktreeDirectory(path.dirname(filePath));
    const unchanged = total === opened.stat.size && sameManagedFileStat(opened.stat, fs.fstatSync(fd))
      && sameManagedFileStat(opened.stat, fs.lstatSync(filePath));
    return { exists: true, sha256: unchanged ? hash.digest("hex") : null };
  } catch (error) {
    return { exists: (error as NodeJS.ErrnoException).code !== "ENOENT", sha256: null };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) as NodeJS.ProcessEnv;
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=", "-c", "core.pager=cat", ...args], {
    cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizedBranch(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function collectGitFacts(
  manifest: WorktreeManifestV1,
  worker: WorktreeManifestWorkerV1,
  runDir: string,
  options?: { artifactVerification: { exists: boolean; sha256: string | null } },
): GitFacts {
  const runReal = canonicalExisting(runDir);
  const worktreeReal = canonicalExisting(worker.worktreePath);
  const agentReal = canonicalExisting(worker.agentCwd);
  const artifactPath = worker.capture?.patchPath ?? null;
  const artifactSafe = !artifactPath || artifactPathSafe(runDir, artifactPath);
  // HTTP callers supply bounded asynchronous verification; legacy synchronous
  // reconciliation retains its existing interface.
  const verification = artifactPath && artifactSafe
    ? options?.artifactVerification ?? artifactDigest(artifactPath, worker.capture?.patchBytes ?? null)
    : { exists: Boolean(artifactPath), sha256: null };
  let artifactSizeMatches = false;
  if (artifactPath && artifactSafe) {
    try { artifactSizeMatches = fs.lstatSync(artifactPath).size === worker.capture?.patchBytes; } catch { /* Unknown remains false. */ }
  }
  const base: GitFacts = {
    workerId: worker.workerId,
    repoMatches: false,
    pathSafe: Boolean(runReal
      && (worktreeReal ? contained(runReal, worktreeReal) : canonicalExisting(path.dirname(worker.worktreePath)) === runReal)
      && (!agentReal || Boolean(worktreeReal && contained(worktreeReal, agentReal)))
      && artifactSafe
      && worker.branch === `deerhux/${manifest.runId}/${worker.index + 1}-${worker.workerId}`
      && path.basename(runDir) === manifest.runId),
    worktreeExists: Boolean(worktreeReal),
    worktreeRegistered: false,
    branchOid: null,
    worktreeBranch: null,
    head: null,
    dirty: null,
    ignoredFilesPresent: null,
    artifactExists: verification.exists,
    artifactDigestMatches: Boolean(artifactSizeMatches && verification.sha256 && verification.sha256 === worker.capture?.patchSha256
      && worker.capture?.captureError === null),
    captureMatchesWorktree: null,
  };
  try {
    const repoRoot = fs.realpathSync.native(git(manifest.repoRoot, ["rev-parse", "--show-toplevel"]));
    const commonDir = fs.realpathSync.native(git(manifest.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    base.repoMatches = repoRoot === fs.realpathSync.native(manifest.repoRoot)
      && commonDir === fs.realpathSync.native(manifest.gitCommonDir);
    const listed = git(manifest.repoRoot, ["worktree", "list", "--porcelain"]);
    base.worktreeRegistered = listed.split("\n").includes(`worktree ${worker.worktreePath}`)
      || Boolean(worktreeReal && listed.split("\n").includes(`worktree ${worktreeReal}`));
    try { base.branchOid = git(manifest.repoRoot, ["rev-parse", "--verify", normalizedBranch(worker.branch)]); } catch { base.branchOid = null; }
    if (worktreeReal) {
      base.head = git(worktreeReal, ["rev-parse", "HEAD"]);
      try { base.worktreeBranch = git(worktreeReal, ["symbolic-ref", "--short", "HEAD"]); } catch { base.worktreeBranch = null; }
      // Even status may execute clean/process filters, and config can change
      // between a filter preflight and status. Do not probe worktree contents.
      base.dirty = git(worktreeReal, ["ls-files", "--others", "--exclude-standard", "-z"]).length > 0 ? true : null;
      base.ignoredFilesPresent = git(worktreeReal, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).length > 0;
      if (base.worktreeBranch !== worker.branch) base.repoMatches = false;
      // Comparing full snapshots requires git add (filters) and writes Git objects.
      // Management reads never do that: a moved HEAD disproves equality; all other
      // cases remain unknown, and existing worktrees are retained regardless.
      if (worker.capture && base.head !== worker.capture.workerHead) base.captureMatchesWorktree = false;
    }
  } catch {
    base.errorCode = "GIT_FACTS_UNAVAILABLE";
  }
  return base;
}

export function scanRunsRoot(runsRoot: string): ScanRunsResult {
  const runs: ScannedRun[] = [];
  const issues: ScanIssue[] = [];
  let rootReal: string;
  try {
    assertPrivateWorktreeDirectory(runsRoot, false);
    rootReal = fs.realpathSync.native(runsRoot);
  } catch { return { runs, issues: [{ path: runsRoot, reason: "unsafe_path" }] }; }
  for (const entry of fs.readdirSync(rootReal, { withFileTypes: true })) {
    const runDir = path.join(rootReal, entry.name);
    if (entry.isSymbolicLink()) { issues.push({ path: runDir, reason: "symlink" }); continue; }
    if (!entry.isDirectory()) { issues.push({ path: runDir, reason: "unknown_directory" }); continue; }
    const manifestPath = path.join(runDir, WORKTREE_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) { issues.push({ path: runDir, reason: "unknown_directory" }); continue; }
    try {
      if (fs.lstatSync(manifestPath).isSymbolicLink()) { issues.push({ path: manifestPath, reason: "symlink" }); continue; }
      const result = readWorktreeManifest(manifestPath);
      if (result.kind !== "ok" || path.basename(runDir) !== result.manifest.runId || !contained(rootReal, fs.realpathSync.native(runDir))) {
        issues.push({ path: manifestPath, reason: "invalid_manifest" });
        continue;
      }
      const resourcesValid = result.manifest.workers.every((worker) => {
        if (isSymlink(worker.worktreePath)) return false;
        if (worker.capture?.patchPath && isSymlink(worker.capture.patchPath)) return false;
        const expectedBranch = `deerhux/${result.manifest.runId}/${worker.index + 1}-${worker.workerId}`;
        const workerParent = canonicalExisting(path.dirname(worker.worktreePath));
        const agentRelative = path.relative(worker.worktreePath, worker.agentCwd).replace(/\\/g, "/") || ".";
        const artifactSafe = !worker.capture?.patchPath || artifactPathSafe(runDir, worker.capture.patchPath);
        return workerParent === runDir
          && path.basename(worker.worktreePath) === `${worker.index + 1}-${worker.workerId}`
          && agentRelative === result.manifest.sourceCwdRelative
          && worker.branch === expectedBranch
          && (!worker.capture || worker.capture.workerBranch === worker.branch)
          && artifactSafe;
      });
      if (!resourcesValid) {
        issues.push({ path: manifestPath, reason: "unsafe_path" });
        continue;
      }
      runs.push({ runDir, manifestPath, manifest: result.manifest });
    } catch { issues.push({ path: manifestPath, reason: "invalid_manifest" }); }
  }
  return { runs, issues };
}

function ownerActive(manifest: WorktreeManifestV1, options: ReconcileOptions | { now: number; instanceId?: string; processStartIdentity?: string; isProcessAlive?: (pid: number, identity: string) => boolean }): boolean {
  const now = options.now ?? Date.now();
  if (options.instanceId === manifest.instanceId && options.processStartIdentity === manifest.processStartIdentity) return true;
  const processAlive = options.isProcessAlive?.(manifest.ownerPid, manifest.processStartIdentity);
  if (processAlive === true) return true;
  if (processAlive === false) return false;
  return now - Date.parse(manifest.heartbeatAt) <= HEARTBEAT_STALE_MS;
}

export function planCleanup(...args: Parameters<typeof planCleanupInternal>): ReturnType<typeof planCleanupInternal> {
  const operation = beginWorktreeOperation("cleanup", { runId: args[0].manifest.runId, repoHash: hashWorktreeRepository(args[0].manifest.repoRoot) });
  try {
    const result = planCleanupInternal(...args);
    for (const worker of result.workers) recordWorktreeDecision({ runId: result.manifest.runId, workerId: worker.workerId,
      repoHash: hashWorktreeRepository(result.manifest.repoRoot) }, worker.reason, {
      repoMatches: worker.facts.repoMatches, pathSafe: worker.facts.pathSafe,
      worktreeExists: worker.facts.worktreeExists, worktreeRegistered: worker.facts.worktreeRegistered,
      dirty: worker.facts.dirty, artifactExists: worker.facts.artifactExists,
      artifactDigestMatches: worker.facts.artifactDigestMatches, captureMatchesWorktree: worker.facts.captureMatchesWorktree,
    });
    operation.finish("planned", { preservedCount: result.workers.filter((worker) => worker.decision === "retain").length });
    return result;
  } catch (error) {
    operation.finish("failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

function planCleanupInternal(
  run: ScannedRun,
  factsByWorker: Record<string, GitFacts>,
  options: { now?: number; instanceId?: string; processStartIdentity?: string; isProcessAlive?: (pid: number, identity: string) => boolean } = {},
): CleanupPlan {
  const now = options.now ?? Date.now();
  const isActive = ownerActive(run.manifest, { ...options, now });
  const workers = run.manifest.workers.map((worker): WorkerCleanupPlan => {
    const facts = factsByWorker[worker.workerId] ?? {
      workerId: worker.workerId, repoMatches: false, pathSafe: false, worktreeExists: false,
      worktreeRegistered: false, branchOid: null, worktreeBranch: null, head: null, dirty: null, ignoredFilesPresent: null,
      artifactExists: false, artifactDigestMatches: false, captureMatchesWorktree: null, errorCode: "GIT_FACTS_UNAVAILABLE",
    };
    const retain = (reason: CleanupReason): WorkerCleanupPlan => ({ workerId: worker.workerId, decision: "retain", reason, facts });
    if (isActive && options.instanceId !== run.manifest.instanceId) return retain("foreign_owner_active");
    if (isActive && run.manifest.activeOperation) return retain("owner_operation_active");
    if (!facts.pathSafe) return retain("unsafe_path");
    if (!facts.repoMatches) return retain("repo_identity_mismatch");
    if (facts.errorCode) return retain("git_facts_unavailable");
    if (worker.capture?.changed && (!facts.artifactExists || !facts.artifactDigestMatches)) return retain("artifact_invalid");
    if (worker.capture?.changed && facts.captureMatchesWorktree === false) return retain("worktree_changed_after_capture");
    if (facts.dirty && !worker.capture) return retain("worktree_dirty_without_artifact");
    if (facts.branchOid && facts.branchOid !== run.manifest.baseCommit && !worker.capture) return retain("branch_ahead_without_artifact");
    // A Git worktree is not an OS sandbox: ignored files and orphaned child
    // processes can still write after the final facts check. Automatic cleanup
    // therefore never removes an existing directory. A future explicit Discard
    // transaction must carry its own confirmation-bound deletion authority.
    if (facts.worktreeExists || facts.worktreeRegistered) return retain("worktree_requires_explicit_discard");
    // When the worktree is already gone, a branch containing captured changes
    // remains the last independent recovery source if the artifact disappears.
    if (worker.capture?.changed) return retain("artifact_audit_retained");
    if (run.manifest.state === "applied") return { workerId: worker.workerId, decision: "cleanup", reason: "eligible_applied", facts };
    if (run.manifest.state === "discarded") return { workerId: worker.workerId, decision: "cleanup", reason: "eligible_discarded", facts };
    if (Date.parse(run.manifest.expiresAt) > now) return retain("continue_ttl_active");
    if (worker.capture?.changed === false) return { workerId: worker.workerId, decision: "cleanup", reason: "eligible_no_changes", facts };
    if (worker.capture && Date.parse(worker.capture.capturedAt ?? run.manifest.updatedAt) + WORKTREE_AUDIT_RETENTION_MS > now) return retain("artifact_audit_retained");
    return retain("manifest_not_settled");
  });
  return { runDir: run.runDir, manifestPath: run.manifestPath, manifest: run.manifest, workers, plannedAt: new Date(now).toISOString() };
}

export async function reconcileRuns(options: ReconcileOptions): Promise<ReconcileResult> {
  const scan = scanRunsRoot(options.runsRoot);
  const recovered: ReconcileResult["recovered"] = [];
  const plans: CleanupPlan[] = [];
  const now = options.now ?? Date.now();
  for (const run of scan.runs) {
    const facts = Object.fromEntries(run.manifest.workers.map((worker) => [worker.workerId, collectGitFacts(run.manifest, worker, run.runDir)]));
    if (!ownerActive(run.manifest, { ...options, now })) {
      if (run.manifest.state === "applying") {
        const applyResult = await recoverPendingAtomicApply(run.manifestPath, run.manifest.repoRoot).catch(() => null);
        if (applyResult?.outcome === "applied") {
          const refreshed = readWorktreeManifest(run.manifestPath);
          if (refreshed.kind === "ok") run.manifest = refreshed.manifest;
          recovered.push({ runId: run.manifest.runId, state: "applied" });
        } else {
          recovered.push({ runId: run.manifest.runId, state: "apply_recovery_required" });
        }
      } else if (run.manifest.state === "applied" || run.manifest.state === "discarded") {
        // Resource retention is independent of durable transaction settlement.
        // Never downgrade historical Apply/Discard facts or rewrite their journal
        // just because a worktree remains (or an audit artifact has since expired).
        recovered.push({ runId: run.manifest.runId, state: run.manifest.state });
      } else {
        const hasWorktree = Object.values(facts).some((fact) => fact.worktreeExists || fact.worktreeRegistered);
        const hasArtifacts = run.manifest.workers.length > 0 && run.manifest.workers.every((worker) => (
          worker.capture !== null && worker.capture.captureError === null
          && facts[worker.workerId]?.artifactDigestMatches
        ));
        if (run.manifest.state === "captured" && hasArtifacts && run.manifest.activeOperation === null) {
          // A settled snapshot remains applyable; it does not assert that the
          // retained worktree still equals that snapshot, nor authorize cleanup.
          recovered.push({ runId: run.manifest.runId, state: "captured" });
        } else if (hasWorktree) {
          run.manifest.state = "preserved";
          for (const worker of run.manifest.workers) if (["creating", "running"].includes(worker.state)) worker.state = "preserved";
          recovered.push({ runId: run.manifest.runId, state: "recoverable" });
        } else if (hasArtifacts) {
          run.manifest.state = "captured";
          recovered.push({ runId: run.manifest.runId, state: "captured" });
        } else {
          run.manifest.state = "cleanup_error";
          recovered.push({ runId: run.manifest.runId, state: "recovery_failed" });
        }
        run.manifest.activeOperation = null;
        run.manifest.updatedAt = new Date(now).toISOString();
        run.manifest.heartbeatAt = run.manifest.updatedAt;
        writeWorktreeManifestAtomic(run.manifestPath, run.manifest);
      }
    }
    plans.push(planCleanup(run, facts, { ...options, now }));
  }
  return { recovered, plans, issues: scan.issues };
}

export async function executeCleanup(...args: Parameters<typeof executeCleanupInternal>): ReturnType<typeof executeCleanupInternal> {
  const operation = beginWorktreeOperation("cleanup", { runId: args[0].manifest.runId, repoHash: hashWorktreeRepository(args[0].manifest.repoRoot) });
  try {
    const result = await executeCleanupInternal(...args);
    // Automatic cleanup currently only settles resources already absent. Never
    // count a successful settlement as a new physical removal.
    operation.finish(result.complete ? "removed" : result.workers.some((worker) => worker.success) ? "partial" : "preserved", {
      reason: result.complete ? "none" : "recovery_required",
      preservedCount: result.workers.filter((worker) => !worker.success).length,
    });
    return result;
  } catch (error) {
    operation.finish("failed", { reason: worktreeDiagnosticReason(error) });
    throw error;
  }
}

async function executeCleanupInternal(
  plan: CleanupPlan,
  options: {
    instanceId: string;
    processStartIdentity: string;
    isProcessAlive?: (pid: number, identity: string) => boolean;
    afterCleanupIntentPersisted?: () => void | Promise<void>;
    afterWorkerEligibilityChecked?: (workerId: string) => void | Promise<void>;
  },
): Promise<{ complete: boolean; workers: Array<{ workerId: string; success: boolean; reason: string }> }> {
  const validation = validateWorktreeManifest(plan.manifest);
  if (!validation.ok) return { complete: false, workers: [] };
  const repository = await GitRepository.open(plan.manifest.repoRoot, { instanceId: plan.manifest.instanceId });
  return repository.withWriteLock({ operation: `cleanup:${plan.manifest.runId}` }, async () => {
    const current = readWorktreeManifest(plan.manifestPath);
    if (current.kind !== "ok" || JSON.stringify(current.manifest) !== JSON.stringify(plan.manifest)
      || path.resolve(plan.manifestPath) !== path.join(path.resolve(plan.runDir), WORKTREE_MANIFEST_FILE)
      || !scanRunsRoot(path.dirname(plan.runDir)).runs.some((run) => run.runDir === canonicalExisting(plan.runDir)
        && JSON.stringify(run.manifest) === JSON.stringify(current.manifest))) return { complete: false, workers: [] };
    const currentRun: ScannedRun = { runDir: plan.runDir, manifestPath: plan.manifestPath, manifest: current.manifest };
    const currentFacts = Object.fromEntries(current.manifest.workers.map((worker) => [
      worker.workerId,
      collectGitFacts(current.manifest, worker, plan.runDir),
    ]));
    const currentPlan = planCleanup(currentRun, currentFacts, { ...options, now: Date.now() });
    const results: Array<{ workerId: string; success: boolean; reason: string }> = [];
    current.manifest.activeOperation = "cleanup";
    current.manifest.updatedAt = new Date().toISOString();
    writeWorktreeManifestAtomic(plan.manifestPath, current.manifest);
    await options.afterCleanupIntentPersisted?.();
    for (const workerPlan of currentPlan.workers) {
      if (workerPlan.decision !== "cleanup") { results.push({ workerId: workerPlan.workerId, success: false, reason: workerPlan.reason }); continue; }
      const worker = current.manifest.workers.find((candidate) => candidate.workerId === workerPlan.workerId)!;
      const facts = collectGitFacts(current.manifest, worker, plan.runDir);
      const freshManifest = { ...current.manifest, activeOperation: null };
      const freshPlan = planCleanup(
        { ...currentRun, manifest: freshManifest },
        { [worker.workerId]: facts },
        { ...options, now: Date.now() },
      );
      const freshDecision = freshPlan.workers.find((candidate) => candidate.workerId === worker.workerId);
      if (!freshDecision || freshDecision.decision !== "cleanup") {
        results.push({ workerId: worker.workerId, success: false, reason: freshDecision?.reason ?? "facts_changed" });
        continue;
      }
      // A recovered manifest is not an independent creation/ownership anchor.
      // Even a matching namespace and OID cannot authorize deleting a live ref
      // in a repository selected by that same untrusted document.
      if (facts.branchOid || facts.worktreeExists || facts.worktreeRegistered) {
        results.push({ workerId: worker.workerId, success: false, reason: "untrusted_creation_identity" });
        continue;
      }
      await options.afterWorkerEligibilityChecked?.(worker.workerId);
      worker.cleanup = {
        intent: current.manifest.state === "applied" ? "post_apply" : current.manifest.state === "discarded" ? "discard" : "automatic",
        eligibility: "eligible",
        checkedAt: new Date().toISOString(),
        worktreeRemoved: !facts.worktreeExists && !facts.worktreeRegistered,
        branchRemoved: !facts.branchOid,
        reason: workerPlan.reason,
      };
      current.manifest.updatedAt = new Date().toISOString();
      writeWorktreeManifestAtomic(plan.manifestPath, current.manifest);
      try {
        worker.cleanup.worktreeRemoved = true;
        worker.cleanup.branchRemoved = true;
        worker.state = "removed";
        results.push({ workerId: worker.workerId, success: true, reason: "cleaned" });
      } catch {
        worker.state = "cleanup_error";
        worker.cleanup.reason = "partial_cleanup";
        results.push({ workerId: worker.workerId, success: false, reason: "partial_cleanup" });
      }
      current.manifest.updatedAt = new Date().toISOString();
      writeWorktreeManifestAtomic(plan.manifestPath, current.manifest);
    }
    current.manifest.activeOperation = null;
    current.manifest.updatedAt = new Date().toISOString();
    writeWorktreeManifestAtomic(plan.manifestPath, current.manifest);
    return { complete: results.length > 0 && results.every((item) => item.success), workers: results };
  });
}

export function refreshManifestHeartbeat(manifestPath: string, instanceId: string, processStartIdentity: string, activeOperation: WorktreeManifestV1["activeOperation"]): boolean {
  const result = readWorktreeManifest(manifestPath);
  if (result.kind !== "ok" || result.manifest.instanceId !== instanceId || result.manifest.processStartIdentity !== processStartIdentity) return false;
  if (activeOperation !== null && !["setting_up", "running", "applying", "preserved"].includes(result.manifest.state)) return false;
  const now = new Date().toISOString();
  result.manifest.heartbeatAt = now;
  result.manifest.updatedAt = now;
  result.manifest.activeOperation = activeOperation;
  result.manifest.expiresAt = new Date(Date.parse(now) + WORKTREE_TTL_MS).toISOString();
  writeWorktreeManifestAtomic(manifestPath, result.manifest);
  return true;
}
