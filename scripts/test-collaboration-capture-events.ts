import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerSession } from "../lib/parallel-agent/subagent-runner.ts";
process.env.SUBAGENT_WORKTREE_V2 = "1";

// Replace only model execution. Workspace setup, capture, manifest, Store and events remain real.
let failCapture = false;
type Origin = { runId?: string; workerName?: string };
const origins = new Map<string, Origin>();
let blockPrompt = false;
let releasePrompt: (() => void) | undefined;
let promptStarted: (() => void) | undefined;
let abortCalls = 0;
let modelCalls = 0;
const globals = globalThis as typeof globalThis & {
  __captureEventWorker?: (cwd: string) => void;
  __captureEventSession?: (cwd: string, existingId?: string, origin?: Origin) => WorkerSession;
  __captureEventOrigins?: Map<string, Origin>;
};
globals.__captureEventOrigins = origins;
globals.__captureEventWorker = (cwd) => {
  fs.writeFileSync(path.join(cwd, "result.txt"), "worker result\n");
  if (blockPrompt) fs.writeFileSync(path.join(cwd, "late-after-abort.txt"), "retain late worker output\n");
  if (failCapture) {
    const manifestPath = path.join(path.dirname(cwd), "worktree-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.baseCommit = "f".repeat(40);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
};
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/subagent-runner.ts")) {
      return { format: "module", shortCircuit: true, source: `
        export function getAutoRecoveryModels() { return []; }
        export async function createSubagentWorkerSession(cwd, _mode, existingId, origin) {
          return globalThis.__captureEventSession(cwd, existingId, origin);
        }
        export async function runWorkerPromptWithRecovery(session, prompt, _models, _onRecovery, onStarted) {
          return session.sendPrompt(prompt, onStarted);
        }
      ` };
    }
    if (url.endsWith("/subagent-registry.ts")) {
      return { format: "module", shortCircuit: true, source: `
        export async function getWorkerOrigin(id) { return globalThis.__captureEventOrigins.get(id); }
        export async function getWorkerOrigins() { return globalThis.__captureEventOrigins; }
        export function registerWorkerSession() {}
        export async function pruneWorkerOrigins() {}
      ` };
    }
    return nextLoad(url, context);
  },
});
const { startCollaborationRun, waitForCollaborationRun, continueCollaborationWorker } = await import("../lib/parallel-agent/collaboration-orchestrator.ts");
const { subscribeCollaborationRun, setCollaborationCleanup, removeCollaborationRun, getCollaborationRun, abortCollaborationRun } = await import("../lib/parallel-agent/collaboration-store.ts");
const { getIsolatedRunDir } = await import("../lib/parallel-agent/worktree.ts");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-capture-events-"));
const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-capture-sessions-"));
globals.__captureEventSession = (cwd, existingId, origin) => {
  const sessionId = existingId ?? randomUUID();
  const sessionFile = path.join(sessions, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() })}\n`);
  (globalThis.__deerhuxSessionPathCache ??= new Map()).set(sessionId, sessionFile);
  origins.set(sessionId, origin ?? {});
  return {
    sessionId, listen: () => () => {}, destroy: () => {}, setModel: async () => {},
    abort: async () => { abortCalls += 1; releasePrompt?.(); },
    sendPrompt: async (_prompt, onStarted) => {
      modelCalls += 1;
      onStarted?.();
      if (blockPrompt) await new Promise<void>((resolve) => { releasePrompt = resolve; promptStarted?.(); });
      globals.__captureEventWorker!(cwd);
      return "done";
    },
  };
};
const runIds: string[] = [];
const git = (args: string[]) => execFileSync("git", args, { cwd: sandbox, stdio: "pipe" });
try {
  git(["init", "-q"]);
  git(["config", "user.email", "capture@test.invalid"]);
  git(["config", "user.name", "Capture Test"]);
  fs.writeFileSync(path.join(sandbox, "base.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  const originalSetupAppend = fs.appendFileSync;
  let injectedSetupFailure = false;
  const callsBeforeSetup = modelCalls;
  try {
    fs.appendFileSync = ((file, ...args) => {
      const entry = JSON.parse(String(args[0]));
      if (!injectedSetupFailure && entry.type === "state_snapshot"
        && entry.state?.status === "running" && entry.state?.baseCommit) {
        injectedSetupFailure = true;
        throw new Error("injected setup persistence failure");
      }
      return originalSetupAppend(file, ...args);
    }) as typeof fs.appendFileSync;
    const run = await startCollaborationRun({ cwd: sandbox, mode: "isolated_coding", message: "test setup persistence", workers: [{ name: "Worker", task: "must not start" }] });
    runIds.push(run.runId);
    const failed = await waitForCollaborationRun(run.runId);
    assert.equal(injectedSetupFailure, true);
    assert.equal(failed.status, "error");
    assert.equal(modelCalls, callsBeforeSetup, "failed setup persistence must not start model execution");
    assert.equal(failed.events.some((event) => event.type === "run_setup_complete" || event.type === "worker_start"), false);
    const manifest = JSON.parse(fs.readFileSync(failed.worktreeManifestPath!, "utf8"));
    assert.ok(fs.existsSync(manifest.workers[0].worktreePath), "setup failure must preserve the created workspace");
  } finally {
    fs.appendFileSync = originalSetupAppend;
  }
  // A single failed final-state write must not emit a terminal event backed by
  // a running snapshot, or incorrectly enable Continue on the stopped runtime.
  const originalFinalAppend = fs.appendFileSync;
  let injectedFinalFailure = false;
  try {
    fs.appendFileSync = ((file, ...args) => {
      const entry = JSON.parse(String(args[0]));
      if (!injectedFinalFailure && entry.type === "state_snapshot" && entry.state?.status === "complete") {
        injectedFinalFailure = true;
        throw new Error("injected final persistence failure");
      }
      return originalFinalAppend(file, ...args);
    }) as typeof fs.appendFileSync;
    const run = await startCollaborationRun({ cwd: sandbox, mode: "isolated_coding", message: "test final persistence", workers: [{ name: "Worker", task: "write result" }] });
    runIds.push(run.runId);
    const failed = await waitForCollaborationRun(run.runId);
    assert.equal(injectedFinalFailure, true);
    assert.equal(failed.status, "error");
    assert.equal(failed.canContinue, false);
    assert.equal(failed.events.some((event) => event.type === "run_complete"), false);
    assert.equal(failed.error, "RUN_FINALIZATION_STATE_PERSISTENCE_FAILED");
    assert.ok(failed.workers[0].patchSha256, "the captured artifact must survive projection failure");
    assert.ok(fs.existsSync(path.join(failed.workers[0].worktreePath!, "result.txt")));
  } finally {
    fs.appendFileSync = originalFinalAppend;
  }
  // Abort during a real Git capture may retain the artifact, but must not
  // resurrect Worker completion or emit completion events after run_aborted.
  {
    const run = await startCollaborationRun({ cwd: sandbox, mode: "isolated_coding", message: "test abort during capture", workers: [{ name: "Worker", task: "write result" }] });
    runIds.push(run.runId);
    const unsubscribe = subscribeCollaborationRun(run.runId, (event) => {
      if (event.type === "worker_capture_started") void abortCollaborationRun(run.runId);
    });
    try {
      const aborted = await waitForCollaborationRun(run.runId);
      // Wait for capture's real final manifest write, not an arbitrary delay.
      const deadline = Date.now() + 10_000;
      while (!JSON.parse(fs.readFileSync(aborted.worktreeManifestPath!, "utf8")).workers[0].capture) {
        assert.ok(Date.now() < deadline, "capture must settle after Abort");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(aborted.status, "aborted");
      assert.equal(aborted.workers[0].status, "aborted");
      const afterAbort = aborted.events.slice(aborted.events.findIndex((event) => event.type === "run_aborted") + 1);
      assert.equal(afterAbort.some((event) => ["worker_complete", "worker_capture_completed", "worker_diff_ready"].includes(event.type)), false);
      assert.ok(fs.existsSync(path.join(aborted.workers[0].worktreePath!, "result.txt")));
    } finally {
      unsubscribe();
      abortCalls = 0;
    }
  }
  for (const failure of [false, true]) {
    failCapture = failure;
    const run = await startCollaborationRun({ cwd: sandbox, mode: "isolated_coding", message: "test capture", workers: [{ name: "Worker", task: "write result" }] });
    runIds.push(run.runId);
    const settled = await waitForCollaborationRun(run.runId);
    await new Promise((resolve) => setImmediate(resolve));
    const types = settled.events.map((event) => event.type);
    assert.ok(types.includes("worker_capture_started"));
    if (failure) {
      assert.equal(settled.status, "error");
      assert.ok(types.includes("worker_capture_error"));
      assert.ok(types.includes("worktree_preserved"));
      assert.equal(types.includes("worker_capture_completed"), false);
      assert.ok(fs.existsSync(path.join(settled.workers[0].worktreePath!, "result.txt")));
    } else {
      assert.equal(settled.status, "complete");
      const captured = settled.events.find((event) => event.type === "worker_capture_completed");
      assert.equal(captured?.fileCount, 1);
      assert.equal(captured?.binaryFileCount, 0);
      assert.ok(types.indexOf("worker_capture_started") < types.indexOf("worker_capture_completed"));
      assert.ok(types.indexOf("worker_capture_completed") < types.indexOf("worker_diff_ready"));
      assert.equal(captured?.diff, undefined);

      const originalAppend = fs.appendFileSync;
      try {
        fs.appendFileSync = ((file, ...args) => {
          if (String(file).endsWith(`${run.runId}.jsonl`)) throw new Error("injected disk failure");
          return originalAppend(file, ...args);
        }) as typeof fs.appendFileSync;
        await assert.rejects(continueCollaborationWorker(run.runId, run.workers[0].workerId), /CONTINUE_ADMISSION_FAILED/);
        assert.equal(getCollaborationRun(run.runId)?.status, "complete", "failed admission must not publish running");
      } finally {
        fs.appendFileSync = originalAppend;
      }
      const continued = await continueCollaborationWorker(run.runId, run.workers[0].workerId);
      assert.equal(continued.status, "complete");
      assert.equal(continued.events.filter((event) => event.type === "worker_capture_completed").length, 2);
      const continuedManifest = JSON.parse(fs.readFileSync(continued.worktreeManifestPath!, "utf8"));
      assert.equal(continuedManifest.activeOperation, null, "Continue must release its lease before publishing completion");

      blockPrompt = true;
      const started = new Promise<void>((resolve) => { promptStarted = resolve; });
      const continuing = continueCollaborationWorker(run.runId, run.workers[0].workerId);
      await started;
      assert.equal(await abortCollaborationRun(run.runId), true);
      const aborted = await continuing;
      assert.equal(abortCalls, 1, "Abort must reach the current Continue session, not a destroyed initial session");
      assert.equal(aborted.status, "aborted");
      assert.equal(aborted.workers[0].status, "aborted");
      assert.equal(aborted.events.filter((event) => event.type === "worker_capture_completed").length, 2);
      assert.equal(fs.readFileSync(path.join(aborted.workers[0].worktreePath!, "late-after-abort.txt"), "utf8"), "retain late worker output\n");
      blockPrompt = false;
    }
  }
  console.log("collaboration capture events and Continue admission tests passed");
} finally {
  for (const runId of runIds) {
    // These are unique test-created runs, never an existing user workspace.
    setCollaborationCleanup(runId, () => {});
    await removeCollaborationRun(runId);
    fs.rmSync(getIsolatedRunDir(runId), { recursive: true, force: true });
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(sessions, { recursive: true, force: true });
  for (const id of origins.keys()) globalThis.__deerhuxSessionPathCache?.delete(id);
  hooks.deregister();
  delete globals.__captureEventWorker;
  delete globals.__captureEventSession;
  delete globals.__captureEventOrigins;
}
