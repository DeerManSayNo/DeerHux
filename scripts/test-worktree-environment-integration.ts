import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setupIsolatedWorkspace, getIsolatedRunDir } from "../lib/parallel-agent/worktree.ts";
import { captureWorktreeArtifact } from "../lib/parallel-agent/worktree-artifacts.ts";
import { readWorktreeManifest, validateWorktreeManifest } from "../lib/parallel-agent/worktree-manifest.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-env-integration-"));
const repo = path.join(sandbox, "repo");
const agentDir = path.join(sandbox, "agent");
const runIds: string[] = [];
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function nextRunId() { const id = `env_${randomUUID().replaceAll("-", "")}`; runIds.push(id); return id; }
function manifest(runId: string) {
  const result = readWorktreeManifest(path.join(getIsolatedRunDir(runId), "worktree-manifest.json"));
  assert.equal(result.kind, "ok", JSON.stringify(result));
  if (result.kind !== "ok") throw new Error("fixture manifest unavailable");
  return result.manifest;
}
function writeScript(name: string, body: string) {
  fs.writeFileSync(path.join(repo, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}
const workers = [{ workerId: "worker_1", displayName: "Worker" }, { workerId: "worker_2", displayName: "Worker" }];

try {
  fs.mkdirSync(repo);
  fs.mkdirSync(agentDir, { mode: 0o700 });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "env-test@deerhux.invalid"]);
  git(repo, ["config", "user.name", "Environment Test"]);
  fs.writeFileSync(path.join(repo, "source.txt"), "source baseline\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.env\n.deerhux-service.json\n");
  writeScript("prepare.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.cwd() !== input.agentCwd) throw new Error('wrong cwd');
fs.mkdirSync(path.join(input.worktreePath, 'node_modules'));
fs.writeFileSync(path.join(input.worktreePath, 'node_modules', 'pkg.js'), input.workerId);
fs.writeFileSync(path.join(input.worktreePath, 'cache.txt'), 'synthetic cache');
process.stdout.write(JSON.stringify({ syntheticPaths: ['node_modules', 'cache.txt'] }));`);
  writeScript("fail.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.mkdirSync(path.join(input.worktreePath, 'node_modules'));
fs.writeFileSync(path.join(input.worktreePath, 'node_modules', 'valuable.txt'), 'ignored hook result');
fs.writeFileSync(path.join(input.worktreePath, 'source.txt'), 'valuable source change');
process.stderr.write('SECRET_HOOK_STDERR_MUST_NOT_LEAK'); process.exit(7);`);
  writeScript("invalid.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(path.join(input.worktreePath, 'valuable.txt'), 'keep invalid-output work');
process.stdout.write(JSON.stringify({ syntheticPaths: ['../outside'] }));`);
  writeScript("abort.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(path.join(input.worktreePath, 'hook-started.txt'), 'retain abort progress');
setInterval(() => {}, 1000);`);
  writeScript("case-alias.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(path.join(input.worktreePath, 'cache.txt'), 'synthetic must never leak through a case alias');
process.stdout.write(JSON.stringify({ syntheticPaths: ['CACHE.TXT'] }));`);
  writeScript("service.cjs", `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.env.TEST_SERVICE_URL !== 'http://127.0.0.1:45678') throw new Error('declared service unavailable');
fs.writeFileSync(path.join(input.worktreePath, '.deerhux-service.json'), JSON.stringify({ service: process.env.TEST_SERVICE_URL }));
process.stdout.write(JSON.stringify({ syntheticPaths: ['.deerhux-service.json'] }));`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "environment fixtures"]);
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "pkg.js"), "main dependency untouched");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET_MAIN_ENV_DO_NOT_COPY=yes\n");

  const noneId = nextRunId();
  const none = await setupIsolatedWorkspace(repo, noneId, "env-test", [workers[0]], { environmentAgentDir: agentDir });
  const noneRoot = none.worktrees.get("worker_1")!;
  assert.equal(fs.existsSync(path.join(noneRoot, "node_modules")), false, "none must not share/copy main dependencies");
  assert.equal(fs.existsSync(path.join(noneRoot, ".env")), false, "none must not copy ignored credentials");
  assert.equal(fs.existsSync(path.join(noneRoot, "cache.txt")), false, "tracked hook is not automatically executed");
  assert.deepEqual(manifest(noneId).workers[0].environment, { mode: "none", syntheticPaths: [], syntheticIdentities: [] });
  const legacy = structuredClone(manifest(noneId));
  delete legacy.workers[0].environment;
  assert.equal(validateWorktreeManifest(legacy).ok, true, "old manifests without environment stay valid");

  const previousServiceUrl = process.env.TEST_SERVICE_URL;
  process.env.TEST_SERVICE_URL = "http://127.0.0.1:45678";
  try {
    const serviceId = nextRunId();
    const service = await setupIsolatedWorkspace(repo, serviceId, "env-test", [workers[0]], {
      environmentConfig: { mode: "hook", script: "service.cjs", envAllowlist: ["TEST_SERVICE_URL"] },
    });
    const serviceRoot = service.worktrees.get("worker_1")!;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(serviceRoot, ".deerhux-service.json"), "utf8")), { service: "http://127.0.0.1:45678" });
    fs.writeFileSync(path.join(serviceRoot, "source.txt"), "service-backed source output\n");
    const serviceCapture = await captureWorktreeArtifact(service.manifestPath, "worker_1");
    assert.equal(serviceCapture.ok, true);
    assert.deepEqual(serviceCapture.capture?.changedFiles, ["source.txt"]);
    assert.equal(fs.readFileSync(serviceCapture.capture!.patchPath!, "utf8").includes("127.0.0.1:45678"), false,
      "declared local service configuration stays synthetic and out of the patch");
  } finally {
    if (previousServiceUrl === undefined) delete process.env.TEST_SERVICE_URL;
    else process.env.TEST_SERVICE_URL = previousServiceUrl;
  }

  fs.writeFileSync(path.join(agentDir, "worktree-environments.json"), JSON.stringify({
    version: 1, repositories: { [fs.realpathSync(repo)]: { mode: "hook", script: "prepare.cjs" } },
  }), { mode: 0o600 });
  const preparedId = nextRunId();
  const prepared = await setupIsolatedWorkspace(repo, preparedId, "env-test", workers, { environmentAgentDir: agentDir });
  const preparedManifest = manifest(preparedId);
  assert.equal(preparedManifest.state, "running");
  for (const worker of preparedManifest.workers) {
    assert.equal(worker.state, "running");
    assert.equal(worker.environment?.mode, "hook");
    assert.deepEqual(worker.environment?.syntheticPaths, ["node_modules", "cache.txt"]);
    assert.equal(worker.environment?.syntheticIdentities.length, 2);
    assert.equal(fs.lstatSync(path.join(worker.worktreePath, "node_modules")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(worker.worktreePath, "node_modules", "pkg.js"), "utf8"), worker.workerId);
    assert.equal(fs.existsSync(path.join(worker.worktreePath, ".env")), false);
  }
  const first = prepared.worktrees.get("worker_1")!;
  const second = prepared.worktrees.get("worker_2")!;
  fs.writeFileSync(path.join(first, "node_modules", "pkg.js"), "worker-private dependency edit");
  assert.equal(fs.readFileSync(path.join(second, "node_modules", "pkg.js"), "utf8"), "worker_2");
  assert.equal(fs.readFileSync(path.join(repo, "node_modules", "pkg.js"), "utf8"), "main dependency untouched");
  fs.writeFileSync(path.join(first, "source.txt"), "worker source change\n");
  const originalIndex = git(first, ["write-tree"]);
  const captured = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.deepEqual(captured.capture?.changedFiles, ["source.txt"]);
  assert.equal(git(first, ["write-tree"]), originalIndex, "synthetic exclusion must use an isolated temporary index");
  assert.equal(fs.readFileSync(path.join(first, "cache.txt"), "utf8"), "synthetic cache");
  const patchText = fs.readFileSync(captured.capture!.patchPath!, "utf8");
  assert.equal(patchText.includes("node_modules"), false);
  assert.equal(patchText.includes("synthetic cache"), false);
  assert.equal(patchText.includes("SECRET_MAIN_ENV"), false);

  const cache = path.join(first, "cache.txt");
  const originalCache = path.join(first, "original-cache.txt");
  fs.renameSync(cache, originalCache);
  fs.writeFileSync(cache, "replacement is user data");
  const replaced = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(replaced.errorCode, "ARTIFACT_SYNTHETIC_INVALID");
  assert.equal(fs.readFileSync(cache, "utf8"), "replacement is user data");
  fs.unlinkSync(cache);
  fs.renameSync(originalCache, cache);

  const outside = path.join(sandbox, "outside.txt");
  fs.writeFileSync(outside, "outside protected");
  fs.renameSync(cache, originalCache);
  fs.symlinkSync(outside, cache);
  const symlink = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(symlink.errorCode, "ARTIFACT_SYNTHETIC_INVALID");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside protected");
  assert.equal(fs.lstatSync(cache).isSymbolicLink(), true, "unsafe replacement is retained, not removed");
  fs.unlinkSync(cache);
  fs.renameSync(originalCache, cache);

  fs.unlinkSync(path.join(second, "cache.txt"));
  fs.writeFileSync(path.join(second, "source.txt"), "second worker change\n");
  const missing = await captureWorktreeArtifact(prepared.manifestPath, "worker_2");
  assert.equal(missing.ok, true, "already deleted synthetic path is safe without physical cleanup");
  for (const unsafe of [".", "../outside", ".git", path.join(sandbox, "outside.txt")]) {
    const denied = await captureWorktreeArtifact(prepared.manifestPath, "worker_2", { syntheticPaths: [unsafe] });
    assert.equal(denied.errorCode, "ARTIFACT_SYNTHETIC_INVALID", `must reject ${unsafe}`);
    assert.equal(fs.existsSync(path.join(second, "source.txt")), true);
  }

  git(first, ["add", "cache.txt"]);
  const newlyStaged = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(newlyStaged.errorCode, "ARTIFACT_SYNTHETIC_INVALID", "newly staged synthetic file cannot be silently omitted");
  assert.equal(git(first, ["ls-files", "cache.txt"]), "cache.txt");
  git(first, ["commit", "-qm", "worker intentionally tracks synthetic"]);
  const newlyCommitted = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(newlyCommitted.errorCode, "ARTIFACT_SYNTHETIC_INVALID", "worker's new committed file is preserved");
  git(first, ["rm", "--cached", "cache.txt"]);
  const stagedDeletion = await captureWorktreeArtifact(prepared.manifestPath, "worker_1");
  assert.equal(stagedDeletion.errorCode, "ARTIFACT_SYNTHETIC_INVALID", "HEAD-tracked synthetic file remains protected after staged deletion");
  git(second, ["add", "-f", "node_modules/pkg.js"]);
  const trackedChild = await captureWorktreeArtifact(prepared.manifestPath, "worker_2");
  assert.equal(trackedChild.errorCode, "ARTIFACT_SYNTHETIC_INVALID", "synthetic directories cannot hide newly tracked children");
  assert.equal(fs.readFileSync(path.join(repo, "source.txt"), "utf8"), "source baseline\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "source checkout stays clean");

  for (const script of ["fail.cjs", "invalid.cjs", "case-alias.cjs"]) {
    const failedId = nextRunId();
    await assert.rejects(setupIsolatedWorkspace(repo, failedId, "env-test", [workers[0]], {
      environmentConfig: { mode: "hook", script },
    }), (error: unknown) => {
      assert.equal(String(error).includes("SECRET_HOOK_STDERR"), false, "hook stderr is never exposed by setup error");
      return error instanceof Error;
    });
    const retained = manifest(failedId);
    assert.equal(retained.state, "cleanup_error");
    assert.equal(retained.workers[0].state, "preserved");
    assert.equal(retained.workers[0].cleanup?.reason, "environment_hook_retained");
    assert.equal(retained.workers[0].cleanup?.worktreeRemoved, false);
    assert.equal(fs.existsSync(retained.workers[0].worktreePath), true);
    assert.equal(JSON.stringify(retained).includes("SECRET_HOOK_STDERR"), false);
    if (script === "fail.cjs") {
      assert.equal(fs.readFileSync(path.join(retained.workers[0].worktreePath, "source.txt"), "utf8"), "valuable source change");
      assert.equal(fs.readFileSync(path.join(retained.workers[0].worktreePath, "node_modules", "valuable.txt"), "utf8"), "ignored hook result");
    } else if (script === "invalid.cjs") assert.equal(fs.readFileSync(path.join(retained.workers[0].worktreePath, "valuable.txt"), "utf8"), "keep invalid-output work");
    else assert.equal(fs.readFileSync(path.join(retained.workers[0].worktreePath, "cache.txt"), "utf8"), "synthetic must never leak through a case alias");
  }
  const abortedId = nextRunId();
  const controller = new AbortController();
  const aborting = setupIsolatedWorkspace(repo, abortedId, "env-test", [workers[0]], {
    signal: controller.signal, environmentConfig: { mode: "hook", script: "abort.cjs", timeoutMs: 10_000 },
  });
  const abortResult = aborting.then(() => null, (error: unknown) => error);
  const marker = path.join(getIsolatedRunDir(abortedId), "1-worker_1", "hook-started.txt");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() < deadline, "hook must start before abort fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  const abortError = await abortResult;
  assert.equal((abortError as { code?: string })?.code, "ENV_ABORTED");
  await new Promise((resolve) => setImmediate(resolve));
  const abortedManifest = manifest(abortedId);
  assert.equal(abortedManifest.state, "cleanup_error");
  assert.equal(abortedManifest.workers[0].state, "preserved", "aborted hook never transitions to running");
  assert.equal(fs.readFileSync(marker, "utf8"), "retain abort progress");
  console.log("worktree environment integration tests passed");
} finally {
  for (const runId of runIds) {
    const result = readWorktreeManifest(path.join(getIsolatedRunDir(runId), "worktree-manifest.json"));
    if (result.kind === "ok") for (const worker of result.manifest.workers) {
      try { git(repo, ["worktree", "remove", worker.worktreePath, "--force"]); } catch { /* isolated fixture cleanup */ }
      try { git(repo, ["update-ref", "-d", `refs/heads/${worker.branch}`]); } catch { /* isolated fixture cleanup */ }
    }
    fs.rmSync(getIsolatedRunDir(runId), { recursive: true, force: true });
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
