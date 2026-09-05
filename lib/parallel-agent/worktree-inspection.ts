import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWorktreeInventory, type WorktreeInventory } from "./worktree-inventory.ts";
import { assertPrivateWorktreeDirectory, readWorktreeManifest, type WorktreeManifestV1, type WorktreeManifestWorkerV1 } from "./worktree-manifest.ts";
import { collectGitFacts, HEARTBEAT_STALE_MS, type GitFacts } from "./worktree-reconciler.ts";
import { hashWorktreeRepository } from "./worktree-diagnostics.ts";

export const WORKTREE_INSPECTION_LIMITS = Object.freeze({ runs: 32, entries: 256, workers: 128, manifestBytes: 8 * 1024 * 1024, elapsedMs: 30_000 });
export const defaultInspectionRunsRoot = (): string => path.join(os.tmpdir(), "deerhux-runs");
type InspectionReason = "content_unverified" | "uncaptured_dirty" | "missing_worktree" | "stale_transaction"
  | "untrusted_creation_identity" | "unsafe_path" | "git_unavailable";
interface InspectionPlan {
  runId: string; workerId: string; repoHash: string; decision: "retain"; reason: InspectionReason;
  missingWorktree: boolean; uncapturedDirty: boolean; contentUnverified: boolean; staleTx: boolean;
}
export interface WorktreeInspection {
  version: 1; inventory: WorktreeInventory; gitChecked: boolean; truncated: boolean;
  reason: "declarations_not_live_disk" | "bounded_git_observations" | "inspection_unavailable";
  scannedCandidates: number; rejectedCandidates: number; inspectedWorkers: number;
  counts: { orphan: number | null; missingWorktree: number | null; uncapturedDirty: number | null; staleTx: number | null; contentUnverified: number };
  plans: InspectionPlan[];
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
function canonicalOrMissing(target: string): string {
  try { return fs.realpathSync.native(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(target) === target) throw error;
    return path.join(canonicalOrMissing(path.dirname(target)), path.basename(target));
  }
}
function verifyWorker(runDirectory: string, manifest: WorktreeManifestV1, worker: WorktreeManifestWorkerV1): void {
  if (worker.branch !== `deerhux/${manifest.runId}/${worker.index + 1}-${worker.workerId}`
    || worker.capture && worker.capture.workerBranch !== worker.branch
    || canonicalOrMissing(worker.worktreePath) !== path.join(runDirectory, `${worker.index + 1}-${worker.workerId}`)
    || path.relative(worker.worktreePath, worker.agentCwd).replace(/\\/g, "/") !== (manifest.sourceCwdRelative === "." ? "" : manifest.sourceCwdRelative)) throw new Error("unsafe_path");
  for (const directory of [worker.worktreePath, worker.agentCwd]) {
    try { assertPrivateWorktreeDirectory(directory, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!inside(canonicalOrMissing(worker.worktreePath), canonicalOrMissing(worker.agentCwd))) throw new Error("unsafe_path");
  if (worker.capture?.patchPath) {
    const artifacts = path.join(runDirectory, "artifacts");
    if (canonicalOrMissing(path.dirname(worker.capture.patchPath)) !== artifacts) throw new Error("unsafe_path");
    try { assertPrivateWorktreeDirectory(path.dirname(worker.capture.patchPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const stat = fs.lstatSync(worker.capture.patchPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("unsafe_path");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function observedPlan(manifest: WorktreeManifestV1, worker: WorktreeManifestWorkerV1, facts: GitFacts, staleTx: boolean): InspectionPlan {
  const verified = facts.repoMatches && facts.pathSafe && !facts.errorCode;
  const missingWorktree = verified && !facts.worktreeExists;
  const uncapturedDirty = verified && facts.dirty === true && !worker.capture;
  const contentUnverified = !verified || facts.worktreeExists || Boolean(worker.capture?.patchPath);
  const reason: InspectionReason = !facts.pathSafe ? "unsafe_path" : !verified ? "git_unavailable"
    : staleTx ? "stale_transaction" : uncapturedDirty ? "uncaptured_dirty" : missingWorktree ? "missing_worktree"
      : contentUnverified ? "content_unverified" : "untrusted_creation_identity";
  return { runId: manifest.runId, workerId: worker.workerId, repoHash: hashWorktreeRepository(manifest.repoRoot),
    decision: "retain", reason, missingWorktree, uncapturedDirty, contentUnverified, staleTx };
}

/** Read-only bounded inspection. Patch content is never opened; no recovery or cleanup calls exist here. */
export async function inspectManagedWorktrees(options: { runsRoot?: string; git?: boolean; now?: number; signal?: AbortSignal } = {}): Promise<WorktreeInspection> {
  const runsRoot = options.runsRoot ?? defaultInspectionRunsRoot();
  const now = options.now ?? Date.now();
  const inventory = await readWorktreeInventory(runsRoot, { now, signal: options.signal });
  const report: WorktreeInspection = { version: 1, inventory, gitChecked: false, truncated: inventory.truncated,
    reason: "declarations_not_live_disk", scannedCandidates: 0, rejectedCandidates: 0, inspectedWorkers: 0,
    counts: { orphan: null, missingWorktree: null, uncapturedDirty: null, staleTx: null, contentUnverified: inventory.gauges.managedWorktrees }, plans: [] };
  if (!options.git || inventory.unavailable) return report;
  report.reason = "bounded_git_observations";
  report.counts = { orphan: 0, missingWorktree: 0, uncapturedDirty: 0, staleTx: 0, contentUnverified: 0 };
  const deadline = Date.now() + WORKTREE_INSPECTION_LIMITS.elapsedMs;
  try {
    assertPrivateWorktreeDirectory(runsRoot, false);
    const root = await fsp.realpath(runsRoot);
    const directory = await fsp.opendir(root);
    let entries = 0;
    for await (const entry of directory) {
      if (options.signal?.aborted || Date.now() >= deadline || entries >= WORKTREE_INSPECTION_LIMITS.entries
        || report.scannedCandidates >= WORKTREE_INSPECTION_LIMITS.runs || report.inspectedWorkers >= WORKTREE_INSPECTION_LIMITS.workers) {
        report.truncated = true; break;
      }
      entries++;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { report.rejectedCandidates++; continue; }
      report.scannedCandidates++;
      const runDirectory = path.join(root, entry.name);
      const loaded = readWorktreeManifest(path.join(runDirectory, "worktree-manifest.json"));
      if (loaded.kind !== "ok" || loaded.manifest.runId !== entry.name) { report.rejectedCandidates++; continue; }
      const manifest = loaded.manifest;
      if (manifest.workers.length > WORKTREE_INSPECTION_LIMITS.workers - report.inspectedWorkers) {
        report.truncated = true; report.rejectedCandidates++; continue;
      }
      try {
        assertPrivateWorktreeDirectory(manifest.repoRoot, false);
        assertPrivateWorktreeDirectory(manifest.gitCommonDir, false);
        for (const worker of manifest.workers) verifyWorker(runDirectory, manifest, worker);
      } catch { report.rejectedCandidates++; continue; }
      const staleTx = (manifest.state === "applying" || manifest.apply?.outcome === "pending")
        && now - Date.parse(manifest.apply?.startedAt ?? manifest.updatedAt) > HEARTBEAT_STALE_MS;
      if (staleTx) report.counts.staleTx!++;
      let orphan = manifest.workers.length > 0;
      for (const worker of manifest.workers) {
        if (options.signal?.aborted || Date.now() >= deadline || report.inspectedWorkers >= WORKTREE_INSPECTION_LIMITS.workers) {
          report.truncated = true; orphan = false; break;
        }
        // Existence metadata only; null digest explicitly prevents trusting patch content.
        const facts = collectGitFacts(manifest, worker, runDirectory, { artifactVerification: { exists: Boolean(worker.capture?.patchPath), sha256: null } });
        report.gitChecked = true;
        const plan = observedPlan(manifest, worker, facts, staleTx);
        report.plans.push(plan); report.inspectedWorkers++;
        report.counts.missingWorktree! += Number(plan.missingWorktree);
        report.counts.uncapturedDirty! += Number(plan.uncapturedDirty);
        report.counts.contentUnverified += Number(plan.contentUnverified);
        orphan &&= facts.repoMatches && facts.pathSafe && !facts.errorCode && !facts.worktreeExists && !facts.worktreeRegistered && !facts.branchOid;
      }
      if (orphan) report.counts.orphan!++;
    }
  } catch { report.reason = "inspection_unavailable"; report.truncated = true; }
  return report;
}

export function parseInspectionArguments(args: string[]): { runsRoot?: string; git: boolean; json: boolean; help: boolean } {
  const options: { runsRoot?: string; git: boolean; json: boolean; help: boolean } = { git: false, json: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--git") options.git = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--runs-root" && args[index + 1] && !args[index + 1].startsWith("--")) options.runsRoot = path.resolve(args[++index]);
    else throw new Error("INVALID_ARGUMENTS");
  }
  return options;
}
