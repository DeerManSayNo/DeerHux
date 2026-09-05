import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function directoryDigest(root: string): string {
  const hash = createHash("sha256");
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name); const stat = fs.lstatSync(target);
      hash.update(path.relative(root, target)); hash.update(String(stat.mode));
      if (stat.isDirectory()) visit(target);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(target));
      else hash.update(fs.readFileSync(target));
    }
  }
  visit(root); return hash.digest("hex");
}
async function child(root: string) {
  assert.equal(process.env.DEERHUX_CODING_AGENT_DIR, path.join(root, "agent"));
  const { createWorktreeGitFixture } = await import("./fixtures/worktree-git-fixture.ts");
  const store = await import("../lib/parallel-agent/collaboration-store.ts");
  const { POST: createRoute } = await import("../app/api/agent-runs/route.ts");
  const { POST: applyRoute } = await import("../app/api/agent-runs/[runId]/apply/route.ts");
  const { GET: diffRoute } = await import("../app/api/agent-runs/[runId]/diff/route.ts");
  const { GET: recoveryRoute } = await import("../app/api/agent-runs/[runId]/recovery/route.ts");
  const { normalizePersistedState } = await import("../lib/parallel-agent/subagent-persistence.ts");
  const fixture = createWorktreeGitFixture();
  const body = (value: unknown) => new Request("http://fixture.invalid/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  let runId: string | undefined;
  const legacyIds: string[] = [];
  try {
    const gitBeforeCreate = directoryDigest(fixture.commonDir);
    const blockedCreate = await createRoute(body({ cwd: fixture.repoRoot, mode: "isolated_coding", message: "disabled admission",
      workers: [{ name: "Worker", task: "must not run" }] }));
    assert.equal(blockedCreate.status, 503);
    assert.equal((await blockedCreate.json()).errorCode, "WORKTREE_V2_DISABLED");
    assert.equal(directoryDigest(fixture.commonDir), gitBeforeCreate, "disabled creation must not modify repository metadata");
    const run = await fixture.setupRun(1); runId = run.runId;
    const workerId = run.workerIds[0]; const worktree = run.worktrees.get(workerId)!;
    fixture.untracked(worktree, "result.txt", "result from retained Run\n");
    const captured = await fixture.capture(run, workerId); assert.equal(captured.ok, true);
    const now = new Date().toISOString();
    store.createCollaborationRun({ runId, version: 0, cwd: fixture.repoRoot, mode: "isolated_coding", status: "complete",
      worktreeImplementation: 2, worktreeManifestPath: run.manifestPath, baseCommit: run.baseCommit, captureState: "captured",
      message: "rollout fixture", createdAt: now, updatedAt: now, events: [], workers: [{ workerId, name: "Worker", task: "fixture", status: "complete",
        worktreePath: worktree, changedFiles: captured.capture!.changedFiles, patchSha256: captured.capture!.patchSha256!, patchBytes: captured.capture!.patchBytes! }] });
    const params = { params: Promise.resolve({ runId }) };
    const payload = { workerIds: [workerId], idempotencyKey: "rollout-key" };
    process.env.SUBAGENT_WORKTREE_V2_APPLY = "0";
    const before = { git: directoryDigest(fixture.commonDir), store: directoryDigest(path.join(root, "agent")),
      manifest: fs.readFileSync(run.manifestPath), run: JSON.stringify(store.getCollaborationRun(runId)) };
    const blockedApply = await applyRoute(body(payload), params);
    assert.equal(blockedApply.status, 503); assert.equal((await blockedApply.json()).code, "APPLY_DISABLED");
    assert.equal(directoryDigest(fixture.commonDir), before.git, "new Apply brake must perform zero Git metadata writes");
    assert.equal(directoryDigest(path.join(root, "agent")), before.store, "new Apply brake must perform zero persisted Store writes");
    assert.deepEqual(fs.readFileSync(run.manifestPath), before.manifest);
    assert.equal(JSON.stringify(store.getCollaborationRun(runId)), before.run);
    assert.equal(fs.existsSync(path.join(fixture.repoRoot, "result.txt")), false);
    const diff = await diffRoute(new Request(`http://fixture.invalid/diff?workerId=${workerId}&download=1`), params);
    assert.equal(diff.status, 200); assert.match(await diff.text(), /result from retained Run/);
    assert.equal(fs.existsSync(worktree), true);
    // Turning off new-run admission is not a lifecycle switch for an existing Run.
    process.env.SUBAGENT_WORKTREE_V2_APPLY = "1";
    assert.equal(process.env.SUBAGENT_WORKTREE_V2, "0");
    const applied = await applyRoute(body(payload), params); assert.equal(applied.status, 200, await applied.clone().text());
    assert.equal((await applied.json()).outcome, "applied");
    fixture.git(fixture.repoRoot, ["commit", "-qm", "user accepts result"]);
    fs.appendFileSync(path.join(fixture.repoRoot, "result.txt"), "later user edit\n");
    process.env.SUBAGENT_WORKTREE_V2_APPLY = "0";
    const beforeReplay = directoryDigest(fixture.repoRoot);
    const replay = await applyRoute(body(payload), params); assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await replay.json()).outcome, "applied");
    assert.equal(directoryDigest(fixture.repoRoot), beforeReplay, "historical replay under brake must not reapply or change user edits");
    const manifestBeforeRejection = fs.readFileSync(run.manifestPath);
    const wrongKey = await applyRoute(body({ ...payload, idempotencyKey: "different-new-key" }), params);
    assert.notEqual(wrongKey.status, 200, "a new key must not masquerade as historical success");
    assert.deepEqual(fs.readFileSync(run.manifestPath), manifestBeforeRejection);
    assert.equal(directoryDigest(fixture.repoRoot), beforeReplay);
    for (const legacyStatus of ["running", "applied"] as const) {
      const legacyId = `legacy_${legacyStatus}_${process.pid}`; legacyIds.push(legacyId);
      store.createCollaborationRun({ runId: legacyId, version: 0, cwd: fixture.repoRoot, mode: "isolated_coding", status: legacyStatus,
        message: "LEGACY_PRIVATE_PROMPT", createdAt: now, updatedAt: now, events: [], workers: [{ workerId: "legacy_worker", name: "PRIVATE_NAME",
          task: "PRIVATE_TASK", status: "complete", sessionId: "PRIVATE_SESSION", worktreePath: "/private/UNVERIFIED_PATH",
          diff: "PRIVATE_DIFF_TOKEN and /private/secret" }] });
      globalThis.__deerhuxCollaborationRuns?.delete(legacyId);
      assert.equal(globalThis.__deerhuxCollaborationRuns?.has(legacyId), false);
      const beforeRead = { store: directoryDigest(path.join(root, "agent")), git: directoryDigest(fixture.commonDir) };
      const response = await recoveryRoute(new Request("http://fixture.invalid/recovery"), { params: Promise.resolve({ runId: legacyId }) });
      assert.equal(response.status, 200); assert.match(response.headers.get("Content-Disposition")!, /^attachment;/);
      const report = await response.json();
      assert.equal(report.historicalStatus, legacyStatus); assert.equal(report.historicalApplied, legacyStatus === "applied");
      assert.equal(report.historyEvidence, "store_only_not_git_verified"); assert.equal(report.baseline, "unverified");
      assert.equal(report.workers[0].storedDiffPresent, true); assert.equal(report.diffExport.available, false);
      for (const secret of [root, "PRIVATE_PROMPT", "PRIVATE_NAME", "PRIVATE_TASK", "PRIVATE_SESSION", "UNVERIFIED_PATH", "PRIVATE_DIFF_TOKEN", "/private/secret"]) {
        assert.equal(JSON.stringify(report).includes(secret), false, `legacy report leaked ${secret}`);
      }
      assert.equal(directoryDigest(path.join(root, "agent")), beforeRead.store, "cold legacy report must not mark interrupted or persist a snapshot");
      assert.equal(directoryDigest(fixture.commonDir), beforeRead.git);
      assert.equal(globalThis.__deerhuxCollaborationRuns?.has(legacyId), false, "cold inspection must not populate runtime Store");
    }
    const markerId = `v2_missing_manifest_${process.pid}`; legacyIds.push(markerId);
    const missingManifestState = { runId: markerId, version: 0, cwd: fixture.repoRoot, mode: "isolated_coding" as const, status: "complete" as const,
      worktreeImplementation: 2 as const, message: "test", workers: [], events: [], createdAt: now, updatedAt: now };
    const normalized = normalizePersistedState(structuredClone(missingManifestState));
    assert.equal(normalized.worktreeImplementation, 2); assert.equal(normalized.recoveryState, "manual_recovery_required");
    store.createCollaborationRun(missingManifestState); globalThis.__deerhuxCollaborationRuns?.delete(markerId);
    const markerBefore = directoryDigest(path.join(root, "agent"));
    const markerResponse = await recoveryRoute(new Request("http://fixture.invalid/recovery"), { params: Promise.resolve({ runId: markerId }) });
    assert.equal(markerResponse.status, 409, "a v2 marker without manifest cannot fall back to legacy report");
    assert.equal(directoryDigest(path.join(root, "agent")), markerBefore); assert.equal(globalThis.__deerhuxCollaborationRuns?.has(markerId), false);
    console.log("worktree rollout redteam passed (admission/brake/read/replay, cold legacy read-only export, no v2 fallback)");
  } finally {
    for (const legacyId of legacyIds) await store.removeCollaborationRun(legacyId);
    if (runId) await store.removeCollaborationRun(runId);
    fixture.dispose();
  }
}
if (process.argv[2] === "--child") {
  await child(process.argv[3]);
} else {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-rollout-redteam-")));
  for (const name of ["agent", "tmp"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import",
      fileURLToPath(new URL("./register-typescript-test-loader.mjs", import.meta.url)), fileURLToPath(import.meta.url), "--child", root], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
        DEERHUX_CODING_AGENT_DIR: path.join(root, "agent"), PI_CODING_AGENT_DIR: path.join(root, "agent"),
        SUBAGENT_WORKTREE_V2: "0", SUBAGENT_WORKTREE_V2_APPLY: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "absent") },
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); process.stdout.write(result.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
