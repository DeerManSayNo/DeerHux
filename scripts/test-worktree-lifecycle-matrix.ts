import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Fresh process keeps process-identity marker files inside this fixture's TMPDIR.
if (process.argv[2] !== "--child") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-lifecycle-matrix-")));
  try {
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", fileURLToPath(import.meta.url), "--child", root], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", TMPDIR: root, TMP: root, TEMP: root }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.equal(fs.readdirSync(root).some((name) => /^deerhux-git-\d+\.start$/.test(name)), false, "normal child exit removes its own process marker");
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const root = process.argv[3];
  assert.equal(os.tmpdir(), root);
  const { planCleanup, HEARTBEAT_STALE_MS, WORKTREE_AUDIT_RETENTION_MS } = await import("../lib/parallel-agent/worktree-reconciler.ts");
  const { acquireGitLock, getGitProcessStartMarker, isGitProcessOwnerAlive, GIT_LOCK_DIRECTORY_NAME } = await import("../lib/parallel-agent/git-lock.ts");
  type ScannedRun = import("../lib/parallel-agent/worktree-reconciler.ts").ScannedRun;
  type GitFacts = import("../lib/parallel-agent/worktree-reconciler.ts").GitFacts;
  type CleanupReason = import("../lib/parallel-agent/worktree-reconciler.ts").CleanupReason;
  const now = Date.parse("2026-09-05T00:00:00Z");
  const base = "a".repeat(40);
  const makeRun = (): ScannedRun => ({ runDir: path.join(root, "run"), manifestPath: path.join(root, "run", "worktree-manifest.json"), manifest: {
    version: 1, runId: "run", instanceId: "old-owner", ownerPid: process.pid, processStartIdentity: "old-start", heartbeatAt: new Date(now - HEARTBEAT_STALE_MS - 1).toISOString(),
    activeOperation: null, repoRoot: root, gitCommonDir: root, sourceCwdRelative: ".", baseCommit: base, state: "preserved",
    createdAt: new Date(now - 1_000).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now - 1).toISOString(), apply: null,
    workers: [{ workerId: "w", displayName: "Worker", index: 0, worktreePath: path.join(root, "run", "1-w"), agentCwd: path.join(root, "run", "1-w"), branch: "deerhux/run/1-w", provider: "test", state: "captured", capture: null, cleanup: null }],
  } });
  const makeFacts = (): GitFacts => ({ workerId: "w", repoMatches: true, pathSafe: true, worktreeExists: false, worktreeRegistered: false,
    branchOid: base, worktreeBranch: null, head: null, dirty: false, ignoredFilesPresent: false, artifactExists: true, artifactDigestMatches: true, captureMatchesWorktree: true });
  function capture(run: ScannedRun, changed: boolean): void {
    run.manifest.workers[0].capture = { changed, workerBranch: "deerhux/run/1-w", workerHead: base,
      patchPath: path.join(root, "run", "artifacts", "test.patch"), patchSha256: "b".repeat(64), patchBytes: changed ? 1 : 0,
      changedFiles: changed ? ["file"] : [], binaryFiles: [], captureError: null, capturedAt: new Date(now - WORKTREE_AUDIT_RETENTION_MS - 1).toISOString() };
  }
  let checks = 0;
  function check(run: ScannedRun, facts: GitFacts | undefined, reason: CleanupReason, options: Parameters<typeof planCleanup>[2] = { now, isProcessAlive: () => false }): void {
    const before = JSON.stringify([run, facts]);
    const decision = planCleanup(run, facts ? { w: facts } : {}, options).workers[0];
    assert.equal(decision.reason, reason, `${checks}: ${before}`);
    assert.equal(decision.decision, reason.startsWith("eligible_") ? "cleanup" : "retain");
    assert.equal(JSON.stringify([run, facts]), before, "planning must not mutate input manifest or facts");
    checks++;
  }

  // Ordered safety rules: every earlier guard must dominate each later guard.
  const guards: Array<{ reason: CleanupReason; activate: (run: ScannedRun, facts: GitFacts) => void }> = [
    { reason: "unsafe_path", activate: (_run, facts) => { facts.pathSafe = false; } },
    { reason: "repo_identity_mismatch", activate: (_run, facts) => { facts.repoMatches = false; } },
    { reason: "git_facts_unavailable", activate: (_run, facts) => { facts.errorCode = "TEST_UNAVAILABLE"; } },
    { reason: "artifact_invalid", activate: (run, facts) => { capture(run, true); facts.artifactDigestMatches = false; } },
    { reason: "worktree_changed_after_capture", activate: (run, facts) => { capture(run, true); facts.captureMatchesWorktree = false; } },
  ];
  for (let earlier = 0; earlier < guards.length; earlier++) {
    for (let later = earlier; later < guards.length; later++) {
      const run = makeRun(), facts = makeFacts();
      guards[later].activate(run, facts); guards[earlier].activate(run, facts);
      run.manifest.state = "applied"; facts.worktreeExists = true;
      check(run, facts, guards[earlier].reason);
    }
  }
  check(makeRun(), undefined, "unsafe_path");

  // Exhaustive product of the named lifecycle dimensions. Additional artifact
  // evidence combinations are expanded separately below to keep the matrix bounded.
  const states = ["planning", "setting_up", "running", "captured", "applying", "applied", "preserved", "discarded", "cleanup_error"] as const;
  for (const state of states) for (const kind of ["none", "empty", "changed"] as const)
    for (const dirty of [false, true, null]) for (const branch of [null, base, "c".repeat(40)])
      for (const exists of [false, true]) for (const registered of [false, true]) for (const ttl of [-1, 0, 1]) {
        const run = makeRun(), facts = makeFacts();
        run.manifest.state = state; run.manifest.expiresAt = new Date(now + ttl).toISOString();
        if (kind !== "none") capture(run, kind === "changed");
        Object.assign(facts, { dirty, branchOid: branch, worktreeExists: exists, worktreeRegistered: registered });
        const expected: CleanupReason = kind === "none" && dirty === true ? "worktree_dirty_without_artifact"
          : kind === "none" && branch !== null && branch !== base ? "branch_ahead_without_artifact"
            : exists || registered ? "worktree_requires_explicit_discard"
              : kind === "changed" ? "artifact_audit_retained"
                : state === "applied" ? "eligible_applied" : state === "discarded" ? "eligible_discarded"
                  : ttl > 0 ? "continue_ttl_active" : kind === "empty" ? "eligible_no_changes" : "manifest_not_settled";
        check(run, facts, expected);
      }
  for (const present of [false, true]) for (const digest of [false, true]) for (const matches of [false, true, null]) {
    const run = makeRun(), facts = makeFacts(); capture(run, true);
    Object.assign(facts, { artifactExists: present, artifactDigestMatches: digest, captureMatchesWorktree: matches });
    check(run, facts, !present || !digest ? "artifact_invalid" : matches === false ? "worktree_changed_after_capture" : "artifact_audit_retained");
  }
  for (const age of [WORKTREE_AUDIT_RETENTION_MS - 1, WORKTREE_AUDIT_RETENTION_MS, WORKTREE_AUDIT_RETENTION_MS + 1]) {
    const run = makeRun(); capture(run, true);
    run.manifest.workers[0].capture!.capturedAt = new Date(now - age).toISOString();
    check(run, makeFacts(), "artifact_audit_retained");
  }

  // Same/foreign owner, active operation and heartbeat boundary dominate unsafe facts.
  for (const alive of [false, true, undefined]) for (const heartbeatAge of [HEARTBEAT_STALE_MS - 1, HEARTBEAT_STALE_MS, HEARTBEAT_STALE_MS + 1])
    for (const sameInstance of [false, true]) for (const sameStart of [false, true]) for (const active of [false, true]) {
      const run = makeRun(), facts = makeFacts(); facts.pathSafe = false;
      run.manifest.heartbeatAt = new Date(now - heartbeatAge).toISOString(); run.manifest.activeOperation = active ? "continue" : null;
      const ownerActive = sameInstance && sameStart || (alive === undefined ? heartbeatAge <= HEARTBEAT_STALE_MS : alive);
      check(run, facts, ownerActive && !sameInstance ? "foreign_owner_active" : ownerActive && active ? "owner_operation_active" : "unsafe_path", {
        now, instanceId: sameInstance ? "old-owner" : "new-owner", processStartIdentity: sameStart ? "old-start" : "new-start",
        ...(alive === undefined ? {} : { isProcessAlive: () => alive }),
      });
    }

  // Create a genuine marker for this living process; no fabricated PID liveness.
  const warm = await acquireGitLock({ commonDir: root, operation: "marker-setup" }); assert.equal(await warm.release(), true);
  const marker = getGitProcessStartMarker(); process.kill(process.pid, 0);
  assert.equal(await isGitProcessOwnerAlive(process.pid, marker), true);
  assert.equal(await isGitProcessOwnerAlive(process.pid, `${marker}-previous-incarnation`), false);
  for (const identityMatches of [false, true]) for (const heartbeatAge of [0, HEARTBEAT_STALE_MS + 1]) {
    const run = makeRun(), facts = makeFacts(); facts.worktreeExists = true;
    run.manifest.processStartIdentity = identityMatches ? marker : `${marker}-previous-incarnation`;
    run.manifest.heartbeatAt = new Date(now - heartbeatAge).toISOString();
    const alive = await isGitProcessOwnerAlive(run.manifest.ownerPid, run.manifest.processStartIdentity);
    check(run, facts, identityMatches ? "foreign_owner_active" : "worktree_requires_explicit_discard", { now, instanceId: "verifier", processStartIdentity: "verifier", isProcessAlive: () => alive });
  }
  const markerPath = path.join(root, `deerhux-git-${process.pid}.start`);
  fs.renameSync(markerPath, `${markerPath}.held`);
  try {
    const alive = await isGitProcessOwnerAlive(process.pid, "unknown");
    assert.equal(alive, true, "live PID without readable identity stays conservatively active");
    const run = makeRun();
    check(run, makeFacts(), "foreign_owner_active", { now, instanceId: "verifier", processStartIdentity: "verifier", isProcessAlive: () => alive });
  }
  finally { fs.renameSync(`${markerPath}.held`, markerPath); }

  for (const identityMatches of [false, true]) for (const old of [false, true]) {
    const common = path.join(root, `lock-${identityMatches}-${old}`); fs.mkdirSync(common);
    const lock = path.join(common, GIT_LOCK_DIRECTORY_NAME); fs.mkdirSync(lock);
    const token = "00000000-0000-0000-0000-000000000001";
    const oldMarker = identityMatches ? marker : `${marker}-previous-incarnation`;
    const ownerPath = path.join(lock, `owner-${token}.json`);
    const bytes = JSON.stringify({ ownerToken: token, instanceId: "previous-lock", pid: process.pid, startMarker: oldMarker,
      processIdentity: `marker:${oldMarker}`, createdAt: new Date(old ? 0 : Date.now()).toISOString(), operation: "test-old-generation" });
    fs.writeFileSync(ownerPath, bytes);
    if (!identityMatches && old) {
      const claimed = await acquireGitLock({ commonDir: common, operation: "reclaim", staleMs: 60_000, timeoutMs: 1_000 });
      assert.notEqual(claimed.metadata.ownerToken, token);
      assert.equal(await claimed.release(), true);
      assert.equal(fs.existsSync(lock), false);
      assert.equal(fs.existsSync(`${lock}.stale-${token}`), true, "old generation tombstone remains an ABA guard");
    } else {
      await assert.rejects(acquireGitLock({ commonDir: common, operation: "blocked", staleMs: 60_000, timeoutMs: 80, pollIntervalMs: 10 }),
        (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "GIT_LOCK_TIMEOUT"));
      assert.equal(fs.readFileSync(ownerPath, "utf8"), bytes, "fresh lock or matching live identity must remain unchanged");
    }
    assert.equal(fs.readdirSync(common).some((name) => name.endsWith(".pending") || name.includes(".release-")), false, "no attempted acquisition leaks pending/release locks");
    fs.rmSync(common, { recursive: true, force: true });
  }
  console.log(`lifecycle matrix passed (${checks} immutable cleanup/owner decisions; real live PID identity and 4 lock generation/age combinations)`);
}
