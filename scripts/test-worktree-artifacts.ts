import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWorktreeArtifact, parseNumstatZ } from "../lib/parallel-agent/worktree-artifacts.ts";
import {
  MAX_WORKTREE_PATCH_BYTES,
  readWorktreeManifest,
  writeWorktreeManifestAtomic,
  type WorktreeManifestV1,
} from "../lib/parallel-agent/worktree-manifest.ts";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim();
}

function write(root: string, relative: string, contents: string | Buffer, mode?: number): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function manifestAt(manifestPath: string): WorktreeManifestV1 {
  const result = readWorktreeManifest(manifestPath);
  assert.equal(result.kind, "ok", result.kind === "invalid" || result.kind === "io_error" ? result.error : result.kind);
  return (result as { kind: "ok"; manifest: WorktreeManifestV1 }).manifest;
}

function makeManifest(repo: string, worker: string, manifestPath: string, baseCommit: string): WorktreeManifestV1 {
  const commonDir = fs.realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const now = new Date().toISOString();
  const manifest: WorktreeManifestV1 = {
    version: 1,
    runId: "artifact-real-git-test",
    instanceId: "artifact-test-instance",
    ownerPid: process.pid,
    processStartIdentity: "artifact-process",
    heartbeatAt: now,
    activeOperation: "running",
    repoRoot: fs.realpathSync(repo),
    gitCommonDir: commonDir,
    sourceCwdRelative: ".",
    baseCommit,
    state: "running",
    workers: [{
      workerId: "worker/one",
      displayName: "Artifact Worker",
      index: 0,
      worktreePath: fs.realpathSync(worker),
      agentCwd: fs.realpathSync(worker),
      branch: "worker-old-record",
      provider: "test",
      state: "running",
      capture: null,
      cleanup: null,
    }],
    apply: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  writeWorktreeManifestAtomic(manifestPath, manifest);
  return manifest;
}

function assertPatchRebuildsBase(repo: string, base: string, patchPath: string, expectedTree: string, verify: string): void {
  git(repo, ["worktree", "add", "-q", "--detach", verify, base]);
  git(verify, ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath]);
  assert.equal(git(verify, ["write-tree"]), expectedTree);
}

const parsed = parseNumstatZ(Buffer.concat([
  Buffer.from("1\t2\tspace name.txt\0", "utf8"),
  Buffer.from("0\t0\t\0old\nname.txt\0Unicode-\u6587\u4ef6.txt\0", "utf8"),
  Buffer.from("-\t-\tbinary.bin\0", "utf8"),
]));
assert.deepEqual(parsed.changedFiles, ["space name.txt", "Unicode-\u6587\u4ef6.txt", "binary.bin"]);
assert.deepEqual(parsed.binaryFiles, ["binary.bin"]);
assert.throws(() => parseNumstatZ(Buffer.from("1\t1\tunterminated")), /NUL terminated/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-artifact-test-"));
const repo = path.join(temp, "main repo");
const worker = path.join(temp, "worker repo");
const verify = path.join(temp, "verify repo");
const workerTwo = path.join(temp, "worker two");
const manifestPath = path.join(temp, "run-manifest.json");
let linkedWorker = false;
let linkedVerify = false;
let linkedWorkerTwo = false;

try {
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Artifact Test"]);
  git(repo, ["config", "user.email", "artifact@example.invalid"]);
  git(repo, ["config", "core.filemode", "true"]);

  write(repo, "tracked.txt", "base tracked\n");
  write(repo, "delete me.txt", "delete this\n");
  write(repo, "rename old.txt", "rename exactly\n");
  write(repo, "mode.sh", "#!/bin/sh\necho base\n", 0o644);
  write(repo, "binary-mod.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), randomBytes(2048)]));
  write(repo, "binary-delete.bin", Buffer.concat([Buffer.from([0, 9, 0]), randomBytes(1024)]));
  write(repo, "commit-base.txt", "zero\n");
  write(repo, "typechange.txt", "regular file\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  git(repo, ["worktree", "add", "-q", "-b", "artifact-worker", worker, base]);
  linkedWorker = true;
  const originalManifest = makeManifest(repo, worker, manifestPath, base);

  write(worker, "tracked.txt", "base tracked\nchanged with no final newline");
  write(worker, "new text.txt", "new file\n");
  fs.rmSync(path.join(worker, "delete me.txt"));
  fs.renameSync(path.join(worker, "rename old.txt"), path.join(worker, "rename new.txt"));
  fs.chmodSync(path.join(worker, "mode.sh"), 0o755);
  fs.symlinkSync("tracked.txt", path.join(worker, "tracked-link"));
  fs.unlinkSync(path.join(worker, "typechange.txt")); fs.symlinkSync("tracked.txt", path.join(worker, "typechange.txt"));
  write(worker, "empty-new.txt", "");
  write(worker, "binary-mod.bin", Buffer.concat([Buffer.from([0, 3, 0, 4]), randomBytes(4096)]));
  fs.rmSync(path.join(worker, "binary-delete.bin"));
  write(worker, "binary-new.bin", Buffer.concat([Buffer.from([0, 7, 0]), randomBytes(8192)]));
  write(worker, "Unicode-\u6587\u4ef6.txt", "unicode\n");
  write(worker, "line\nbreak.txt", "newline path\n");
  write(worker, "--leading-option.txt", "dash path\n");
  write(worker, ".synthetic/cache.txt", "must not leak\n");

  write(worker, "commit-base.txt", "first commit\n");
  git(worker, ["add", "commit-base.txt"]);
  git(worker, ["commit", "-qm", "worker commit one"]);
  write(worker, "committed-new.txt", "second commit\n");
  git(worker, ["add", "committed-new.txt"]);
  git(worker, ["commit", "-qm", "worker commit two"]);
  write(worker, "commit-base.txt", "continued after commits\n");

  // Incompressible binary data produces a binary patch comfortably above 10 MiB.
  write(worker, "large-random.bin", randomBytes(9 * 1024 * 1024));

  const originalWorkerIndexTree = git(worker, ["write-tree"]);
  const result = await captureWorktreeArtifact(manifestPath, "worker/one", {
    syntheticPaths: [".synthetic"],
  });
  assert.equal(result.ok, true, result.error ?? undefined);
  assert.equal(result.workerBranch, "artifact-worker");
  assert.equal(result.workerHead, git(worker, ["rev-parse", "HEAD"]));
  assert.ok(result.capture?.patchPath);
  assert.ok((result.capture?.patchBytes ?? 0) > 10 * 1024 * 1024, "patch must exceed 10 MiB");
  assert.equal(fs.statSync(result.capture!.patchPath!).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(worker, ".synthetic")), true, "synthetic files are excluded, never physically deleted");
  assert.equal(git(worker, ["write-tree"]), originalWorkerIndexTree, "synthetic capture uses a private index");
  assert.match(fs.readFileSync(result.capture!.patchPath!).subarray(0, 256 * 1024).toString("utf8"), /GIT binary patch/);

  const expectedNames = [
    "tracked.txt", "new text.txt", "delete me.txt", "rename new.txt", "mode.sh", "tracked-link",
    "binary-mod.bin", "binary-delete.bin", "binary-new.bin", "Unicode-\u6587\u4ef6.txt",
    "line\nbreak.txt", "--leading-option.txt", "commit-base.txt", "committed-new.txt", "large-random.bin",
  ];
  for (const name of expectedNames) assert.ok(result.capture!.changedFiles.includes(name), `missing changed path ${JSON.stringify(name)}`);
  for (const name of ["binary-mod.bin", "binary-delete.bin", "binary-new.bin", "large-random.bin"]) {
    assert.ok(result.capture!.binaryFiles.includes(name), `missing binary path ${name}`);
  }
  assert.ok(!result.capture!.changedFiles.some((name) => name.startsWith(".synthetic")));
  const metadata = new Map(result.capture!.fileChanges!.map((file) => [file.path, file]));
  assert.equal(metadata.get("new text.txt")?.changeKind, "new"); assert.equal(metadata.get("new text.txt")?.newBytes, 9);
  assert.equal(metadata.get("empty-new.txt")?.newBytes, 0);
  assert.equal(metadata.get("delete me.txt")?.changeKind, "deleted"); assert.equal(metadata.get("delete me.txt")?.oldBytes, 12); assert.equal(metadata.get("delete me.txt")?.newBytes, null);
  assert.equal(metadata.get("rename new.txt")?.changeKind, "renamed"); assert.equal(metadata.get("rename new.txt")?.previousPath, "rename old.txt");
  assert.equal(metadata.get("typechange.txt")?.changeKind, "typechange"); assert.equal(metadata.get("typechange.txt")?.newBytes, 11);
  assert.equal(metadata.get("mode.sh")?.changeKind, "modified"); assert.equal(metadata.get("mode.sh")?.addedLines, 0);
  assert.equal(metadata.get("binary-mod.bin")?.oldBytes, 2052); assert.equal(metadata.get("binary-mod.bin")?.newBytes, 4100);
  assert.equal(metadata.get("binary-delete.bin")?.oldBytes, 1027); assert.equal(metadata.get("binary-delete.bin")?.newBytes, null);
  assert.equal(metadata.get("binary-new.bin")?.newBytes, 8195); assert.equal(metadata.get("binary-new.bin")?.addedLines, null);
  assert.equal(metadata.get("large-random.bin")?.newBytes, 9 * 1024 * 1024);
  assert.equal(metadata.get("tracked.txt")?.addedLines, 1); assert.equal(metadata.get("tracked.txt")?.deletedLines, 0);

  const stagedTree = result.treeDigest!;
  assertPatchRebuildsBase(repo, base, result.capture!.patchPath!, stagedTree, verify);
  linkedVerify = true;
  assert.deepEqual(fs.readFileSync(path.join(verify, "binary-new.bin")), fs.readFileSync(path.join(worker, "binary-new.bin")));
  assert.deepEqual(fs.readFileSync(path.join(verify, "large-random.bin")), fs.readFileSync(path.join(worker, "large-random.bin")));
  assert.equal(fs.existsSync(path.join(verify, "binary-delete.bin")), false);
  assert.equal(fs.readlinkSync(path.join(verify, "tracked-link")), "tracked.txt");
  assert.equal(fs.statSync(path.join(verify, "mode.sh")).mode & 0o111, 0o111);

  const captured = manifestAt(manifestPath);
  assert.equal(captured.state, "captured");
  assert.equal(captured.workers[0].state, "captured");
  assert.equal(captured.workers[0].branch, "artifact-worker");
  assert.equal(captured.workers[0].capture?.patchPath, result.capture!.patchPath);
  assert.equal(captured.workers[0].capture?.changed, true);
  assert.equal(captured.workers[0].capture?.workerBranch, "artifact-worker");
  assert.equal(captured.workers[0].capture?.workerHead, result.workerHead);
  assert.deepEqual(captured.workers[0].capture?.fileChanges, result.capture!.fileChanges, "structured metadata is durable with the verified artifact");
  const oldArtifact = fs.readFileSync(result.capture!.patchPath!);
  const oldCapture = structuredClone(captured.workers[0].capture);

  // A partial-write/disk-style failure cannot replace the old artifact or old capture facts.
  write(worker, "failure-change.txt", "must remain in worktree\n");
  const partialFailure = await captureWorktreeArtifact(manifestPath, "worker/one", {
    faults: {
      afterPatchWrite(tempPatch) {
        const fd = fs.openSync(tempPatch, "r+");
        try { fs.ftruncateSync(fd, Math.max(1, Math.floor(fs.fstatSync(fd).size / 2))); }
        finally { fs.closeSync(fd); }
        throw Object.assign(new Error("simulated ENOSPC after partial patch"), { code: "ENOSPC" });
      },
    },
  });
  assert.equal(partialFailure.ok, false);
  assert.equal(partialFailure.errorCode, "ARTIFACT_PATCH_WRITE_FAILED");
  assert.equal(partialFailure.error, "Artifact patch could not be persisted");
  let preserved = manifestAt(manifestPath);
  assert.equal(preserved.state, "preserved");
  assert.equal(preserved.workers[0].state, "preserved");
  assert.deepEqual(preserved.workers[0].capture, oldCapture);
  assert.deepEqual(fs.readFileSync(result.capture!.patchPath!), oldArtifact);
  assert.equal(fs.existsSync(path.join(worker, "failure-change.txt")), true);

  const oversizedFailure = await captureWorktreeArtifact(manifestPath, "worker/one", {
    faults: {
      afterPatchWrite(tempPatch) {
        const fd = fs.openSync(tempPatch, "r+");
        try { fs.ftruncateSync(fd, MAX_WORKTREE_PATCH_BYTES + 1); }
        finally { fs.closeSync(fd); }
      },
    },
  });
  assert.equal(oversizedFailure.ok, false);
  assert.equal(oversizedFailure.errorCode, "ARTIFACT_PATCH_TOO_LARGE");
  assert.deepEqual(manifestAt(manifestPath).workers[0].capture, oldCapture);

  const digestFailure = await captureWorktreeArtifact(manifestPath, "worker/one", {
    faults: { forceDigestMismatch: true },
  });
  assert.equal(digestFailure.ok, false);
  assert.equal(digestFailure.errorCode, "ARTIFACT_DIGEST_MISMATCH");
  preserved = manifestAt(manifestPath);
  assert.equal(preserved.state, "preserved");
  assert.deepEqual(preserved.workers[0].capture, oldCapture);
  assert.deepEqual(fs.readFileSync(result.capture!.patchPath!), oldArtifact);

  const treeFailure = await captureWorktreeArtifact(manifestPath, "worker/one", {
    faults: { forceTreeMismatch: true },
  });
  assert.equal(treeFailure.ok, false);
  assert.equal(treeFailure.errorCode, "ARTIFACT_TREE_MISMATCH");
  assert.deepEqual(manifestAt(manifestPath).workers[0].capture, oldCapture);

  const artifactsBeforeManifestFault = new Set(fs.readdirSync(path.dirname(result.capture!.patchPath!)));
  const manifestFailure = await captureWorktreeArtifact(manifestPath, "worker/one", {
    faults: { beforeManifestWrite() { throw new Error("simulated manifest write fault"); } },
  });
  assert.equal(manifestFailure.ok, false);
  assert.equal(manifestFailure.errorCode, "ARTIFACT_MANIFEST_WRITE_FAILED");
  assert.deepEqual(new Set(fs.readdirSync(path.dirname(result.capture!.patchPath!))), artifactsBeforeManifestFault);
  assert.deepEqual(manifestAt(manifestPath).workers[0].capture, oldCapture);

  // A worker commit whose final tree returns to base is a successful no-change capture.
  git(worker, ["reset", "--hard", base]);
  git(worker, ["clean", "-fd"]);
  const resetManifest = { ...originalManifest, updatedAt: new Date().toISOString() };
  writeWorktreeManifestAtomic(manifestPath, resetManifest);
  write(worker, "temporary.txt", "committed then removed\n");
  git(worker, ["add", "temporary.txt"]);
  git(worker, ["commit", "-qm", "temporary commit"]);
  git(worker, ["rm", "-q", "temporary.txt"]);
  git(worker, ["commit", "-qm", "return to base tree"]);
  assert.equal(git(worker, ["write-tree"]), git(repo, ["rev-parse", `${base}^{tree}`]));
  const noChange = await captureWorktreeArtifact(manifestPath, "worker/one");
  assert.equal(noChange.ok, true, noChange.error ?? undefined);
  assert.equal(noChange.capture?.patchBytes, 0);
  assert.equal(noChange.capture?.changed, false);
  assert.deepEqual(noChange.capture?.changedFiles, []);
  assert.deepEqual(noChange.capture?.binaryFiles, []);
  assert.equal(manifestAt(manifestPath).state, "captured");

  git(worker, ["reset", "--hard", base]);
  git(worker, ["clean", "-fd"]);
  git(repo, ["worktree", "add", "-q", "-b", "artifact-worker-two", workerTwo, base]);
  linkedWorkerTwo = true;
  write(worker, "parallel-one.txt", "one\n");
  write(workerTwo, "parallel-two.txt", "two\n");
  const parallelManifest = structuredClone(originalManifest);
  parallelManifest.updatedAt = new Date().toISOString();
  parallelManifest.workers.push({
    ...structuredClone(parallelManifest.workers[0]),
    workerId: "worker/two",
    displayName: "Worker Two",
    index: 1,
    worktreePath: workerTwo,
    agentCwd: workerTwo,
    branch: "artifact-worker-two",
  });
  writeWorktreeManifestAtomic(manifestPath, parallelManifest);
  const parallelResults = await Promise.all([
    captureWorktreeArtifact(manifestPath, "worker/one"),
    captureWorktreeArtifact(manifestPath, "worker/two"),
  ]);
  assert.equal(parallelResults.every((capture) => capture.ok), true);
  const parallelCaptured = manifestAt(manifestPath);
  assert.equal(parallelCaptured.state, "captured");
  assert.equal(parallelCaptured.workers.every((entry) => entry.capture !== null), true);
  assert.deepEqual(parallelCaptured.workers.map((entry) => entry.capture?.changedFiles[0]).sort(), ["parallel-one.txt", "parallel-two.txt"]);

  assert.equal(fs.readdirSync(path.join(temp, "artifacts")).some((name) => name.endsWith(".tmp")), false);
  console.log("worktree artifact tests passed");
} finally {
  if (linkedWorkerTwo) {
    try { git(repo, ["worktree", "remove", "--force", workerTwo]); } catch { /* test cleanup */ }
  }
  if (linkedVerify) {
    try { git(repo, ["worktree", "remove", "--force", verify]); } catch { /* test cleanup */ }
  }
  if (linkedWorker) {
    try { git(repo, ["worktree", "remove", "--force", worker]); } catch { /* test cleanup */ }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
