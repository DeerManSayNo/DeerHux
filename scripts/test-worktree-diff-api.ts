import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GET } from "../app/api/agent-runs/[runId]/diff/route.ts";
import { MAX_INLINE_DIFF_BYTES } from "../lib/parallel-agent/worktree-diff.ts";
import { getIsolatedRunDir, getIsolatedRunsRoot } from "../lib/parallel-agent/worktree.ts";
import { MAX_WORKTREE_PATCH_BYTES, validateWorktreeManifest, writeWorktreeManifestAtomic, type WorktreeManifestV1 } from "../lib/parallel-agent/worktree-manifest.ts";

const runId = `diff_${randomUUID().replaceAll("-", "")}`;
const workerId = "worker-1";
const runsRoot = getIsolatedRunsRoot();
const runDir = getIsolatedRunDir(runId);
const artifacts = path.join(runDir, "artifacts");
const manifestPath = path.join(runDir, "worktree-manifest.json");
const patch = Buffer.from("diff --git a/readme.txt b/readme.txt\n+hello\n", "utf8");
const digest = createHash("sha256").update(patch).digest("hex");
const artifactPath = path.join(artifacts, `worker-${digest}.patch`);
const now = "2026-01-01T00:00:00.000Z";

function manifest(patchOverride = artifactPath, digestOverride = digest): WorktreeManifestV1 {
  return {
    version: 1,
    runId,
    instanceId: "test-instance",
    ownerPid: process.pid,
    processStartIdentity: "test-process",
    heartbeatAt: now,
    activeOperation: null,
    repoRoot: path.join(runDir, "repo"),
    gitCommonDir: path.join(runDir, "repo", ".git"),
    sourceCwdRelative: ".",
    baseCommit: "a".repeat(40),
    state: "captured",
    workers: [{
      workerId,
      displayName: "Worker One",
      index: 0,
      worktreePath: path.join(runDir, "worker"),
      agentCwd: path.join(runDir, "worker"),
      branch: "deerhux/test/worker",
      provider: "test",
      state: "captured",
      capture: {
        changed: true,
        workerBranch: "deerhux/test/worker",
        workerHead: "b".repeat(40),
        patchPath: patchOverride,
        patchSha256: digestOverride,
        patchBytes: patch.byteLength,
        changedFiles: ["readme.txt", "assets/logo.bin"],
        binaryFiles: ["assets/logo.bin"],
        capturedAt: now,
        captureError: null,
      },
      cleanup: null,
    }],
    apply: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: "2026-01-02T00:00:00.000Z",
  };
}

function request(format = "summary", id = workerId): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/agent-runs/${runId}/diff?workerId=${encodeURIComponent(id)}&format=${format}`),
    { params: Promise.resolve({ runId }) },
  );
}

fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
fs.writeFileSync(artifactPath, patch, { mode: 0o600 });
writeWorktreeManifestAtomic(manifestPath, manifest());

try {
  {
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body.files, [
      { path: "readme.txt", type: "text", bytes: null },
      { path: "assets/logo.bin", type: "binary", bytes: null },
    ]);
    assert.equal(body.artifact.bytes, patch.byteLength);
    assert.equal(body.artifact.containsBinary, true);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(runDir), false, "summary must not expose internal paths");
    assert.equal(serialized.includes("session"), false, "summary must not expose worker sessions");
    assert.equal(serialized.includes(patch.toString("utf8")), false, "summary must not inline patch text");
  }

  {
    const response = await request("patch");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/x-diff; charset=utf-8");
    assert.match(response.headers.get("content-disposition") ?? "", /^inline; filename="deerhux-[a-f0-9]{16}\.patch"$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), patch);
  }

  {
    const response = await request("download");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
    fs.appendFileSync(artifactPath, "must-not-stream-after-verified-length");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), patch);
    fs.truncateSync(artifactPath, patch.byteLength);
  }

  assert.equal((await request("summary", "unknown-worker")).status, 404);
  assert.equal((await request("unknown")).status, 400);

  {
    const largePatch = Buffer.alloc(MAX_INLINE_DIFF_BYTES + 1, 0x78);
    const largeDigest = createHash("sha256").update(largePatch).digest("hex");
    const largePath = path.join(artifacts, `worker-${largeDigest}.patch`);
    fs.writeFileSync(largePath, largePatch, { mode: 0o600 });
    const largeManifest = manifest(largePath, largeDigest);
    largeManifest.workers[0].capture!.patchBytes = largePatch.byteLength;
    writeWorktreeManifestAtomic(manifestPath, largeManifest);
    let eventLoopProgressed = false;
    setImmediate(() => { eventLoopProgressed = true; });
    const summary = await (await request()).json();
    assert.equal(eventLoopProgressed, true, "artifact verification must yield to the event loop");
    assert.equal(summary.artifact.inlineAvailable, false);
    assert.equal((await request("patch")).status, 413, "oversized patch must not be returned inline");
    const download = await request("download");
    assert.equal(download.status, 200, "oversized artifact remains downloadable");
    assert.equal((await download.arrayBuffer()).byteLength, largePatch.byteLength);
    fs.unlinkSync(largePath);
    writeWorktreeManifestAtomic(manifestPath, manifest());
  }

  {
    const oversized = manifest();
    oversized.workers[0].capture!.patchBytes = MAX_WORKTREE_PATCH_BYTES + 1;
    assert.equal(validateWorktreeManifest(oversized).ok, false, "oversized artifacts must be rejected at the manifest boundary");
  }

  fs.chmodSync(artifactPath, 0o644);
  assert.deepEqual(await (await request()).json(), { error: "DIFF_ARTIFACT_REJECTED" });
  fs.chmodSync(artifactPath, 0o600);

  fs.writeFileSync(artifactPath, Buffer.alloc(patch.byteLength, 0x78), { mode: 0o600 });
  assert.deepEqual(await (await request()).json(), { error: "DIFF_ARTIFACT_REJECTED" });
  fs.writeFileSync(artifactPath, patch, { mode: 0o600 });

  const outside = path.join(runDir, `outside-${digest}.patch`);
  fs.writeFileSync(outside, patch, { mode: 0o600 });
  writeWorktreeManifestAtomic(manifestPath, manifest(outside));
  assert.deepEqual(await (await request()).json(), { error: "DIFF_ARTIFACT_REJECTED" });

  writeWorktreeManifestAtomic(manifestPath, manifest());
  fs.unlinkSync(artifactPath);
  fs.symlinkSync(outside, artifactPath);
  assert.deepEqual(await (await request()).json(), { error: "DIFF_ARTIFACT_REJECTED" });

  console.log("worktree diff API tests passed");
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}
