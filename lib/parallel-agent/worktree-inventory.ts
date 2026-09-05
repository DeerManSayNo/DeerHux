import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { validateWorktreeManifest, type WorktreeManifestV1 } from "./worktree-manifest.ts";
import { WORKTREE_DIAGNOSTIC_THRESHOLDS } from "./worktree-diagnostics.ts";

export interface WorktreeInventory {
  version: 1;
  gauges: {
    managedRuns: number; managedWorktrees: number; activeWorktrees: number; preservedWorktrees: number;
    pendingApplyTransactions: number; recoverableRuns: number; manualRecoveryRuns: number;
    oldestAgeMs: number | null; patchDeclaredBytes: number;
  };
  scannedEntries: number; scannedBytes: number; invalidManifests: number; unavailableManifests: number; oversizedManifests: number;
  truncated: boolean; unavailable: boolean;
  reason: "none" | "root_unavailable" | "unsafe_root" | "scan_failed" | "cancelled";
  thresholds: typeof WORKTREE_DIAGNOSTIC_THRESHOLDS;
  warnings: { oldManagedRuns: boolean; declaredPatchBytes: boolean; preservedWorktrees: boolean };
}
function emptyInventory(): WorktreeInventory {
  return { version: 1, gauges: { managedRuns: 0, managedWorktrees: 0, activeWorktrees: 0, preservedWorktrees: 0,
    pendingApplyTransactions: 0, recoverableRuns: 0, manualRecoveryRuns: 0, oldestAgeMs: null, patchDeclaredBytes: 0 },
    scannedEntries: 0, scannedBytes: 0, invalidManifests: 0, unavailableManifests: 0, oversizedManifests: 0,
    truncated: false, unavailable: false, reason: "none", thresholds: { ...WORKTREE_DIAGNOSTIC_THRESHOLDS },
    warnings: { oldManagedRuns: false, declaredPatchBytes: false, preservedWorktrees: false } };
}
function ownerAndMode(stat: fs.Stats, mode?: number): boolean {
  return (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (mode === undefined ? (stat.mode & 0o022) === 0 : (stat.mode & 0o777) === mode);
}
function sameNode(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid;
}
async function safeRootAncestors(directory: string): Promise<boolean> {
  if (!path.isAbsolute(directory)) return false;
  let cursor = path.resolve(directory);
  for (let depth = 0; depth < 256; depth += 1) {
    const stat = await fsp.lstat(cursor);
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp"].includes(cursor)
      && stat.uid === 0 && stat.isSymbolicLink();
    if (stat.isSymbolicLink() && !systemAlias || !stat.isDirectory() && !systemAlias) return false;
    if (!systemAlias && (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid()
      || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) return false;
    const parent = path.dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
  return false;
}
function add(left: number, right: number): number { return Math.min(Number.MAX_SAFE_INTEGER, left + Math.max(0, right)); }
function countManifest(inventory: WorktreeInventory, manifest: WorktreeManifestV1, now: number): void {
  const counts = inventory.gauges;
  counts.managedRuns += 1;
  const existing = manifest.workers.filter((worker) => worker.state !== "removed" && worker.cleanup?.worktreeRemoved !== true);
  counts.managedWorktrees += existing.length;
  counts.activeWorktrees += existing.filter((worker) => worker.state === "creating" || worker.state === "running"
    || manifest.activeOperation !== null && !["preserved", "cleanup_error", "discarded"].includes(manifest.state)).length;
  counts.preservedWorktrees += existing.filter((worker) => ["preserved", "cleanup_error"].includes(worker.state)
    || ["preserved", "cleanup_error"].includes(manifest.state)).length;
  const pending = manifest.state === "applying" || manifest.apply?.outcome === "pending";
  if (pending) counts.pendingApplyTransactions += 1;
  const manual = ["preserved", "cleanup_error"].includes(manifest.state) || manifest.apply?.outcome === "recovery_required"
    || manifest.workers.some((worker) => worker.state === "cleanup_error" || Boolean(worker.capture?.captureError) || worker.cleanup?.eligibility === "manual_review");
  if (manual) counts.manualRecoveryRuns += 1;
  if (manual || pending || manifest.state === "captured" || manifest.workers.some((worker) => worker.state === "preserved")) counts.recoverableRuns += 1;
  if (manifest.state !== "discarded") counts.oldestAgeMs = Math.max(counts.oldestAgeMs ?? 0, Math.max(0, now - Date.parse(manifest.createdAt)));
  for (const worker of manifest.workers) counts.patchDeclaredBytes = add(counts.patchDeclaredBytes, worker.capture?.patchBytes ?? 0);
}

/**
 * Read-only manifest inventory. Counts describe validated manifest declarations,
 * not fresh Git/disk reconciliation. No path, raw error, patch, or Session data leaves this function.
 */
export async function readWorktreeInventory(runsRoot: string, options: { signal?: AbortSignal; now?: number } = {}): Promise<WorktreeInventory> {
  const inventory = emptyInventory();
  const now = Number.isFinite(options.now) ? Math.max(0, options.now!) : Date.now();
  let rootBefore: fs.Stats;
  let root: string;
  if (options.signal?.aborted) { inventory.unavailable = true; inventory.reason = "cancelled"; return inventory; }
  try {
    rootBefore = await fsp.lstat(runsRoot);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !ownerAndMode(rootBefore) || !await safeRootAncestors(runsRoot)) {
      inventory.unavailable = true; inventory.reason = "unsafe_root"; return inventory;
    }
    root = await fsp.realpath(runsRoot);
  } catch { inventory.unavailable = true; inventory.reason = "root_unavailable"; return inventory; }
  try {
    const directory = await fsp.opendir(root);
    for await (const entry of directory) {
      if (options.signal?.aborted) { inventory.unavailable = true; inventory.reason = "cancelled"; inventory.truncated = true; break; }
      inventory.scannedEntries += 1;
      const runDirectory = path.join(root, entry.name);
      let runBefore: fs.Stats;
      try {
        runBefore = await fsp.lstat(runDirectory);
        if (!entry.isDirectory() || !runBefore.isDirectory() || runBefore.isSymbolicLink() || !ownerAndMode(runBefore, 0o700)) {
          inventory.unavailableManifests += 1;
          if (inventory.scannedEntries >= WORKTREE_DIAGNOSTIC_THRESHOLDS.maxInventoryEntries) { inventory.truncated = true; break; }
          continue;
        }
      } catch {
        inventory.unavailableManifests += 1;
        if (inventory.scannedEntries >= WORKTREE_DIAGNOSTIC_THRESHOLDS.maxInventoryEntries) { inventory.truncated = true; break; }
        continue;
      }
      let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
      try {
        const manifestPath = path.join(runDirectory, "worktree-manifest.json");
        handle = await fsp.open(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || !ownerAndMode(before, 0o600) || !Number.isSafeInteger(before.size) || before.size < 0) {
          inventory.unavailableManifests += 1;
        } else if (before.size > WORKTREE_DIAGNOSTIC_THRESHOLDS.maxManifestBytes) {
          inventory.oversizedManifests += 1;
          inventory.truncated = true;
        } else if (before.size > WORKTREE_DIAGNOSTIC_THRESHOLDS.maxInventoryBytes - inventory.scannedBytes) {
          inventory.truncated = true;
          break;
        } else {
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          let changed = false;
          while (offset < bytes.length) {
            if (options.signal?.aborted) { changed = true; inventory.unavailable = true; inventory.reason = "cancelled"; inventory.truncated = true; break; }
            const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
            if (bytesRead <= 0) { changed = true; break; }
            offset += bytesRead;
            inventory.scannedBytes += bytesRead;
          }
          const [after, pathAfter, runAfter, rootAfter] = await Promise.all([
            handle.stat(), fsp.lstat(manifestPath), fsp.lstat(runDirectory), fsp.lstat(runsRoot),
          ]);
          if (changed || !sameNode(before, after) || !sameNode(before, pathAfter) || !sameNode(runBefore, runAfter) || !sameNode(rootBefore, rootAfter)
            || pathAfter.isSymbolicLink() || runAfter.isSymbolicLink() || rootAfter.isSymbolicLink()
            || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            inventory.unavailableManifests += 1;
          } else {
            let value: unknown;
            try { value = JSON.parse(bytes.toString("utf8")); } catch { value = null; }
            if (!validateWorktreeManifest(value).ok || (value as WorktreeManifestV1).runId !== entry.name) inventory.invalidManifests += 1;
            else countManifest(inventory, value as WorktreeManifestV1, now);
          }
        }
      } catch { inventory.unavailableManifests += 1; }
      finally { await handle?.close().catch(() => undefined); }
      if (inventory.reason === "cancelled") break;
      if (inventory.scannedEntries >= WORKTREE_DIAGNOSTIC_THRESHOLDS.maxInventoryEntries
        || inventory.scannedBytes >= WORKTREE_DIAGNOSTIC_THRESHOLDS.maxInventoryBytes) { inventory.truncated = true; break; }
    }
  } catch { inventory.unavailable = true; inventory.reason = options.signal?.aborted ? "cancelled" : "scan_failed"; inventory.truncated = true; }
  inventory.warnings = {
    oldManagedRuns: (inventory.gauges.oldestAgeMs ?? 0) >= WORKTREE_DIAGNOSTIC_THRESHOLDS.oldestAgeWarningMs,
    declaredPatchBytes: inventory.gauges.patchDeclaredBytes >= WORKTREE_DIAGNOSTIC_THRESHOLDS.patchDeclaredBytesWarning,
    preservedWorktrees: inventory.gauges.preservedWorktrees >= WORKTREE_DIAGNOSTIC_THRESHOLDS.preservedWorktreesWarning,
  };
  return inventory;
}
