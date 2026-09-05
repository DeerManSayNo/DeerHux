import fs from "node:fs";
import path from "node:path";
import type { SessionHeader } from "@/lib/types";
import { GitRepository } from "./git-repository";
import { getGitProcessStartMarker, isGitProcessOwnerAlive } from "./git-lock";
import {
  readWorktreeManifest,
  transitionWorktreeManifest,
  writeWorktreeManifestAtomic,
  type WorktreeManifestV1,
  type WorktreeManifestWorkerV1,
} from "./worktree-manifest";
import {
  WORKTREE_MANIFEST_FILE,
  WORKTREE_TTL_MS,
  collectGitFacts,
  scanRunsRoot,
  type GitFacts,
} from "./worktree-reconciler";

export type ContinueValidationCode =
  | "CONTINUE_BINDING_INVALID"
  | "CONTINUE_OWNER_ACTIVE"
  | "CONTINUE_OPERATION_ACTIVE"
  | "CONTINUE_REPOSITORY_MISMATCH"
  | "CONTINUE_WORKTREE_INVALID"
  | "CONTINUE_BASE_INVALID"
  | "CONTINUE_SESSION_INVALID";

export class ContinueValidationError extends Error {
  readonly code: ContinueValidationCode;

  constructor(code: ContinueValidationCode, message: string) {
    super(message);
    this.name = "ContinueValidationError";
    this.code = code;
  }
}

export interface ContinueValidationInput {
  manifest: WorktreeManifestV1;
  worker: WorktreeManifestWorkerV1;
  facts: GitFacts;
  expectedRunId: string;
  expectedRepoRoot: string;
  expectedGitCommonDir: string;
  expectedBaseCommit?: string;
  instanceId: string;
  processStartIdentity: string;
  foreignOwnerAlive: boolean;
  agentCwdValid: boolean;
  baseCommitExists: boolean;
  baseCommitIsAncestor: boolean;
  sessionHeader: Pick<SessionHeader, "id" | "cwd"> | null;
  sessionOrigin: { runId?: string; workerName?: string } | null;
  expectedSessionId: string;
}

/** Pure, table-testable validation for every resource a Continue operation will use. */
export function validateContinueResources(input: ContinueValidationInput): void {
  const { manifest, worker, facts } = input;
  if (manifest.runId !== input.expectedRunId) {
    throw new ContinueValidationError("CONTINUE_BINDING_INVALID", "Manifest runId does not match the requested run");
  }
  const sameOwner = manifest.instanceId === input.instanceId
    && manifest.processStartIdentity === input.processStartIdentity;
  if (!sameOwner && input.foreignOwnerAlive) {
    throw new ContinueValidationError("CONTINUE_OWNER_ACTIVE", "Another DeerHux instance still owns this run");
  }
  if (manifest.activeOperation !== null && (sameOwner || input.foreignOwnerAlive)) {
    throw new ContinueValidationError("CONTINUE_OPERATION_ACTIVE", `Run already has an active ${manifest.activeOperation} operation`);
  }
  if (!["captured", "preserved"].includes(manifest.state) || manifest.apply?.outcome === "applied") {
    throw new ContinueValidationError("CONTINUE_OPERATION_ACTIVE", `Manifest state ${manifest.state} cannot be continued`);
  }
  if (manifest.repoRoot !== input.expectedRepoRoot
    || manifest.gitCommonDir !== input.expectedGitCommonDir
    || !facts.repoMatches) {
    throw new ContinueValidationError("CONTINUE_REPOSITORY_MISMATCH", "Manifest repository identity does not match the requested repository");
  }
  if (input.expectedBaseCommit && manifest.baseCommit !== input.expectedBaseCommit) {
    throw new ContinueValidationError("CONTINUE_BASE_INVALID", "Manifest baseCommit does not match the collaboration run");
  }
  if (!input.baseCommitExists || !input.baseCommitIsAncestor) {
    throw new ContinueValidationError("CONTINUE_BASE_INVALID", "Manifest baseCommit is unavailable or is not an ancestor of the worker HEAD");
  }
  if (!facts.pathSafe || !facts.worktreeExists || !facts.worktreeRegistered || facts.errorCode
    || facts.worktreeBranch !== worker.branch || !facts.head || facts.branchOid !== facts.head
    || !input.agentCwdValid) {
    throw new ContinueValidationError("CONTINUE_WORKTREE_INVALID", "Worker worktree, branch, HEAD, or agentCwd no longer matches the manifest");
  }
  if (!input.sessionHeader || input.sessionHeader.id !== input.expectedSessionId
    || path.resolve(input.sessionHeader.cwd) !== path.resolve(worker.agentCwd)
    || input.sessionOrigin?.runId !== manifest.runId
    || input.sessionOrigin.workerName !== worker.displayName) {
    throw new ContinueValidationError("CONTINUE_SESSION_INVALID", "Worker session does not belong to the manifest agentCwd");
  }
}

export interface ContinueLeaseBinding {
  repository: GitRepository;
  manifestPath: string;
  workerId: string;
  agentCwd: string;
  instanceId: string;
  processStartIdentity: string;
}

function canonicalDirectory(target: string): string | null {
  try {
    const resolved = fs.realpathSync.native(target);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Claim a Continue lease while holding the repository lock and return only manifest-bound paths. */
export async function claimContinueLease(options: {
  runsRoot: string;
  runId: string;
  workerId: string;
  repository: GitRepository;
  expectedBaseCommit?: string;
  sessionId: string;
  sessionHeader: Pick<SessionHeader, "id" | "cwd"> | null;
  sessionOrigin: { runId?: string; workerName?: string } | null;
  instanceId: string;
  processStartIdentity?: string;
}): Promise<ContinueLeaseBinding> {
  const processStartIdentity = options.processStartIdentity ?? getGitProcessStartMarker();
  return options.repository.withWriteLock({ operation: `continue_lease:${options.runId}:${options.workerId}` }, async () => {
    const runsRoot = fs.realpathSync.native(options.runsRoot);
    const expectedRunDir = path.join(runsRoot, options.runId);
    const expectedManifestPath = path.join(expectedRunDir, WORKTREE_MANIFEST_FILE);
    const scanned = scanRunsRoot(runsRoot).runs.find((candidate) => (
      candidate.manifest.runId === options.runId
      && candidate.runDir === expectedRunDir
      && candidate.manifestPath === expectedManifestPath
    ));
    if (!scanned) throw new ContinueValidationError("CONTINUE_BINDING_INVALID", "Strict runs-root scan rejected the requested manifest");
    const worker = scanned.manifest.workers.find((candidate) => candidate.workerId === options.workerId);
    if (!worker) throw new ContinueValidationError("CONTINUE_BINDING_INVALID", "Worker is missing from the requested manifest");
    const foreignOwnerAlive = scanned.manifest.instanceId === options.instanceId
      && scanned.manifest.processStartIdentity === processStartIdentity
      ? true
      : await isGitProcessOwnerAlive(scanned.manifest.ownerPid, scanned.manifest.processStartIdentity);
    const facts = collectGitFacts(scanned.manifest, worker, scanned.runDir);
    const agentCwd = canonicalDirectory(worker.agentCwd);
    const worktreePath = canonicalDirectory(worker.worktreePath);
    let baseCommitExists = false;
    let baseCommitIsAncestor = false;
    try {
      await options.repository.run(["cat-file", "-e", `${scanned.manifest.baseCommit}^{commit}`]);
      baseCommitExists = true;
      if (facts.head) {
        const result = await options.repository.run(["merge-base", "--is-ancestor", scanned.manifest.baseCommit, facts.head], {
          maxStdoutBytes: 1024,
          maxStderrBytes: 4096,
        });
        baseCommitIsAncestor = result.exitCode === 0;
      }
    } catch {
      baseCommitIsAncestor = false;
    }
    validateContinueResources({
      manifest: scanned.manifest,
      worker,
      facts,
      expectedRunId: options.runId,
      expectedRepoRoot: options.repository.root,
      expectedGitCommonDir: options.repository.commonDir,
      expectedBaseCommit: options.expectedBaseCommit,
      instanceId: options.instanceId,
      processStartIdentity,
      foreignOwnerAlive,
      agentCwdValid: Boolean(agentCwd && worktreePath
        && (agentCwd === worktreePath || agentCwd.startsWith(`${worktreePath}${path.sep}`))
        && path.relative(worktreePath, agentCwd).split(path.sep).join("/") === (scanned.manifest.sourceCwdRelative === "." ? "" : scanned.manifest.sourceCwdRelative)),
      baseCommitExists,
      baseCommitIsAncestor,
      sessionHeader: options.sessionHeader,
      sessionOrigin: options.sessionOrigin,
      expectedSessionId: options.sessionId,
    });

    const now = new Date().toISOString();
    const claimed = transitionWorktreeManifest(scanned.manifest, "running", { caller: "runner", now });
    claimed.instanceId = options.instanceId;
    claimed.ownerPid = process.pid;
    claimed.processStartIdentity = processStartIdentity;
    claimed.heartbeatAt = now;
    claimed.expiresAt = new Date(Date.parse(now) + WORKTREE_TTL_MS).toISOString();
    claimed.activeOperation = "continue";
    worker.state = "running";
    writeWorktreeManifestAtomic(expectedManifestPath, claimed);
    return {
      repository: options.repository,
      manifestPath: expectedManifestPath,
      workerId: options.workerId,
      agentCwd: worker.agentCwd,
      instanceId: options.instanceId,
      processStartIdentity,
    };
  });
}

/** Clear only the lease we still own; never clear another instance's active operation. */
export async function settleContinueLease(binding: ContinueLeaseBinding): Promise<void> {
  await binding.repository.withWriteLock({ operation: `continue_settle:${binding.workerId}` }, async () => {
    const result = readWorktreeManifest(binding.manifestPath);
    if (result.kind !== "ok") throw new ContinueValidationError("CONTINUE_BINDING_INVALID", "Continue manifest is unavailable while settling its lease");
    const manifest = result.manifest;
    if (manifest.instanceId !== binding.instanceId
      || manifest.processStartIdentity !== binding.processStartIdentity
      || manifest.activeOperation !== "continue") {
      throw new ContinueValidationError("CONTINUE_OWNER_ACTIVE", "Continue lease ownership changed before it could be settled");
    }
    const worker = manifest.workers.find((candidate) => candidate.workerId === binding.workerId);
    if (!worker || path.resolve(worker.agentCwd) !== path.resolve(binding.agentCwd)) {
      throw new ContinueValidationError("CONTINUE_BINDING_INVALID", "Continue worker binding changed before lease settlement");
    }
    const now = new Date().toISOString();
    worker.state = worker.state === "running" ? "stopped" : worker.state;
    const settled = manifest.state === "running"
      ? transitionWorktreeManifest(manifest, "preserved", { caller: "runner", now })
      : { ...manifest, updatedAt: now };
    settled.activeOperation = null;
    settled.heartbeatAt = now;
    settled.expiresAt = new Date(Date.parse(now) + WORKTREE_TTL_MS).toISOString();
    writeWorktreeManifestAtomic(binding.manifestPath, settled);
  });
}
