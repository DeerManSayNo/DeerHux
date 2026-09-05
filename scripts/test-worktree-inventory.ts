import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWorktreeInventory } from "../lib/parallel-agent/worktree-inventory.ts";
import { validateWorktreeManifest, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-inventory-")));
const createdAt = "2026-01-01T00:00:00.000Z";
function makeManifest(runId: string): WorktreeManifestV1 {
  return { version: 1, runId, instanceId: "inventory-instance", ownerPid: process.pid, processStartIdentity: "inventory-process",
    heartbeatAt: createdAt, activeOperation: null, repoRoot: "/private/should-not-read/repo", gitCommonDir: "/private/should-not-read/repo/.git",
    sourceCwdRelative: ".", baseCommit: "a".repeat(40), state: "captured",
    workers: [{ workerId: `${runId}-worker`, displayName: "secret worker name", index: 0,
      worktreePath: "/private/should-not-read/worktree", agentCwd: "/private/should-not-read/worktree", branch: "private-branch", provider: "test", state: "captured",
      capture: { changed: true, workerBranch: "private-branch", workerHead: "a".repeat(40), patchPath: "/private/should-not-read/patch",
        patchSha256: "b".repeat(64), patchBytes: 100, changedFiles: ["secret-file.txt"], binaryFiles: [], capturedAt: createdAt, captureError: null }, cleanup: null }],
    apply: null, createdAt, updatedAt: createdAt, expiresAt: "2026-01-02T00:00:00.000Z" };
}
function save(parent: string, manifest: WorktreeManifestV1): string {
  assert.equal(validateWorktreeManifest(manifest).ok, true);
  const directory = path.join(parent, manifest.runId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const manifestPath = path.join(directory, "worktree-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return manifestPath;
}
function section(name: string): string { const value = path.join(root, name); fs.mkdirSync(value, { mode: 0o700 }); return value; }
try {
  const normal = section("normal");
  const capturedPath = save(normal, makeManifest("captured-run"));
  const preserved = makeManifest("preserved-run");
  preserved.state = "preserved"; preserved.workers[0].state = "preserved";
  save(normal, preserved);
  const applying = makeManifest("applying-run");
  applying.state = "applying"; applying.activeOperation = "apply";
  applying.apply = { transactionId: "tx-private", requestedWorkerIds: [applying.workers[0].workerId], requestedFiles: null,
    appliedFiles: [], startedAt: createdAt, finishedAt: null, outcome: "pending", errorCode: null };
  save(normal, applying);
  const original = fs.readFileSync(capturedPath);
  const originalOpen = fsp.open;
  const opened: string[] = [];
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    opened.push(String(args[0]));
    assert.equal(path.basename(String(args[0])), "worktree-manifest.json", "inventory opens only manifests, never patch/JSONL/worktree paths");
    return originalOpen(...args);
  }) as typeof fsp.open;
  let inventory;
  try { inventory = await readWorktreeInventory(normal, { now: Date.parse("2026-01-09T00:00:00.000Z") }); }
  finally { fsp.open = originalOpen; }
  assert.equal(opened.length, 3);
  assert.equal(inventory.gauges.managedRuns, 3);
  assert.equal(inventory.gauges.managedWorktrees, 3);
  assert.equal(inventory.gauges.activeWorktrees, 1);
  assert.equal(inventory.gauges.preservedWorktrees, 1);
  assert.equal(inventory.gauges.pendingApplyTransactions, 1);
  assert.equal(inventory.gauges.recoverableRuns, 3);
  assert.equal(inventory.gauges.manualRecoveryRuns, 1);
  assert.equal(inventory.gauges.patchDeclaredBytes, 300);
  assert.equal(inventory.warnings.oldManagedRuns, true);
  assert.equal(inventory.truncated, false);
  assert.equal(inventory.unavailable, false);
  assert.deepEqual(fs.readFileSync(capturedPath), original);
  assert.equal(JSON.stringify(inventory).includes("private"), false);
  assert.equal(JSON.stringify(inventory).includes("secret"), false);
  assert.equal(JSON.stringify(inventory).includes(root), false);

  const unsafe = section("unsafe");
  fs.symlinkSync(path.dirname(capturedPath), path.join(unsafe, "directory-link"));
  const linked = path.join(unsafe, "manifest-link"); fs.mkdirSync(linked, { mode: 0o700 });
  fs.symlinkSync(capturedPath, path.join(linked, "worktree-manifest.json"));
  const wrongMode = save(unsafe, makeManifest("wrong-mode")); fs.chmodSync(wrongMode, 0o644);
  const malformed = path.join(unsafe, "malformed"); fs.mkdirSync(malformed, { mode: 0o700 });
  fs.writeFileSync(path.join(malformed, "worktree-manifest.json"), '{"private":', { mode: 0o600 });
  const unsafeResult = await readWorktreeInventory(unsafe);
  assert.equal(unsafeResult.gauges.managedRuns, 0);
  assert.equal(unsafeResult.unavailableManifests, 3);
  assert.equal(unsafeResult.invalidManifests, 1);
  const rootLink = path.join(root, "root-link"); fs.symlinkSync(normal, rootLink);
  assert.equal((await readWorktreeInventory(rootLink)).reason, "unsafe_root");
  const ancestorLink = path.join(root, "ancestor-link"); fs.symlinkSync(root, ancestorLink);
  const aliasedRoot = await readWorktreeInventory(path.join(ancestorLink, "normal"));
  assert.equal(aliasedRoot.reason, "unsafe_root");
  assert.equal(aliasedRoot.scannedEntries, 0, "a user-controlled ancestor cannot redirect the scan");
  assert.equal((await readWorktreeInventory(path.join(root, "absent"))).reason, "root_unavailable");
  const controller = new AbortController(); controller.abort("private abort reason");
  assert.equal((await readWorktreeInventory(normal, { signal: controller.signal })).reason, "cancelled");

  const oversized = section("oversized");
  const large = makeManifest("large-valid"); large.workers[0].displayName = "x".repeat(1024 * 1024);
  save(oversized, large);
  const largeResult = await readWorktreeInventory(oversized);
  assert.equal(largeResult.oversizedManifests, 1);
  assert.equal(largeResult.invalidManifests, 0);
  assert.equal(largeResult.scannedBytes, 0);
  assert.equal(largeResult.truncated, true);

  const entries = section("entry-cap");
  for (let index = 0; index < 300; index += 1) fs.writeFileSync(path.join(entries, `ignored-${index}`), "");
  const entriesResult = await readWorktreeInventory(entries);
  assert.equal(entriesResult.scannedEntries, 256);
  assert.equal(entriesResult.truncated, true);
  assert.equal(entriesResult.scannedBytes, 0);

  const total = section("byte-cap");
  for (let index = 0; index < 20; index += 1) {
    const value = makeManifest(`run-${index}`); value.workers[0].displayName = "x".repeat(900_000); save(total, value);
  }
  const totalResult = await readWorktreeInventory(total);
  assert.equal(totalResult.truncated, true);
  assert.ok(totalResult.scannedBytes <= 16 * 1024 * 1024);
  assert.ok(totalResult.gauges.managedRuns < 20);

  const mutation = section("mutation");
  const mutateManifest = makeManifest("mutating"); mutateManifest.workers[0].displayName = "x".repeat(100_000);
  const mutatePath = save(mutation, mutateManifest);
  let mutated = false;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await Reflect.apply(read, handle, readArgs);
      if (!mutated) { mutated = true; fs.appendFileSync(mutatePath, "x".repeat(2 * 1024 * 1024)); }
      return result;
    }) as typeof handle.read;
    return handle;
  }) as typeof fsp.open;
  try {
    const changing = await readWorktreeInventory(mutation);
    assert.equal(changing.gauges.managedRuns, 0);
    assert.equal(changing.unavailableManifests, 1);
    assert.ok(changing.scannedBytes < 1024 * 1024, "fixed descriptor read never follows a growing file to EOF");
  } finally { fsp.open = originalOpen; }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("worktree inventory tests passed");
