import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import net from "node:net";
import type { WorkerSession } from "../../lib/parallel-agent/subagent-runner.ts";
import type { WorkerSessionOrigin } from "../../lib/parallel-agent/subagent-registry.ts";
import { assertPublic, git, makeRepository, treeDigest } from "./worktree-e2e-fixture.ts";

const [mode, root] = process.argv.slice(2);
assert.ok(root && fs.realpathSync(root) === root);
assert.equal(process.env.DEERHUX_CODING_AGENT_DIR, path.join(root, "agent"));
assert.equal(process.env.TMPDIR, path.join(root, "tmp"));
// Prevent accidental real model, telemetry or provider traffic, including imported modules.
globalThis.fetch = async () => { throw new Error("E2E_NETWORK_FORBIDDEN"); };
net.Socket.prototype.connect = (() => { throw new Error("E2E_NETWORK_FORBIDDEN"); }) as typeof net.Socket.prototype.connect;
const globals = globalThis as typeof globalThis & { __worktreeE2eSession?: (cwd: string, id?: string, origin?: Partial<WorkerSessionOrigin>) => Promise<WorkerSession> };
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/subagent-runner.ts")) return { format: "module", shortCircuit: true, source: `
    export function getAutoRecoveryModels() { return []; }
    export async function createSubagentWorkerSession(cwd, _mode, id, origin) { return globalThis.__worktreeE2eSession(cwd, id, origin); }
    export async function runWorkerPromptWithRecovery(session, prompt, _models, _recover, onStarted) { return session.sendPrompt(prompt, onStarted); }
  ` };
  return nextLoad(url, context);
} });
const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
const { registerWorkerSession, getWorkerOrigin } = await import("../../lib/parallel-agent/subagent-registry.ts");
const { resolveSessionPath } = await import("../../lib/session-reader.ts");
assert.equal(getAgentDir(), path.join(root, "agent"));
const sessionCacheInitiallyEmpty = !globalThis.__deerhuxSessionPathCache?.size;
let modelCalls = 0;
let releaseAbortedPrompt: (() => void) | undefined;
let notifyAbortedPrompt: (() => void) | undefined;
const abortedPromptStarted = new Promise<void>((resolve) => { notifyAbortedPrompt = resolve; });
globals.__worktreeE2eSession = async (cwd, id, origin) => {
  assert.ok(cwd.startsWith(path.join(root, "tmp", "deerhux-runs") + path.sep));
  const existingPath = id ? await resolveSessionPath(id) : null;
  if (id) assert.ok(existingPath?.startsWith(path.join(root, "agent", "sessions") + path.sep), "existing session is read from isolated disk, not fabricated");
  const manager = existingPath ? SessionManager.open(existingPath) : SessionManager.create(cwd);
  const sessionId = manager.getSessionId();
  const registered = id ? await getWorkerOrigin(id) : origin;
  assert.ok(registered?.workerName && registered.runId);
  registerWorkerSession({ ...registered, workerSessionId: sessionId, createdAt: new Date().toISOString() });
  return { sessionId, listen: () => () => {}, destroy: () => {}, setModel: async () => {}, abort: async () => { releaseAbortedPrompt?.(); },
    sendPrompt: async (prompt, onStarted) => {
      modelCalls += 1;
      onStarted?.();
      const round = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length + 1;
      const name = registered.workerName!;
      if (name.startsWith("conflict")) fs.writeFileSync(path.join(cwd, "shared.txt"), `${name}\n`);
      else {
        fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name} round ${round}\n`);
        fs.writeFileSync(path.join(cwd, `${name}-extra.txt`), `extra ${round}\n`);
      }
      manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture completed" }], api: "openai-completions", provider: "fixture", model: "offline",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      assert.ok(fs.existsSync(manager.getSessionFile()!));
      if (name === "theta") await new Promise<void>((resolve) => { releaseAbortedPrompt = resolve; notifyAbortedPrompt?.(); });
      return "fixture completed";
    } };
};
const orchestrator = await import("../../lib/parallel-agent/collaboration-orchestrator.ts");
const store = await import("../../lib/parallel-agent/collaboration-store.ts");
const createRoute = await import("../../app/api/agent-runs/route.ts");
const detailRoute = await import("../../app/api/agent-runs/[runId]/route.ts");
const diffRoute = await import("../../app/api/agent-runs/[runId]/diff/route.ts");
const applyRoute = await import("../../app/api/agent-runs/[runId]/apply/route.ts");
const resumeRoute = await import("../../app/api/agent-runs/[runId]/workers/[workerId]/resume/route.ts");
const discardRoute = await import("../../app/api/agent-runs/[runId]/discard/route.ts");
const eventsRoute = await import("../../app/api/agent-runs/[runId]/events/route.ts");
const { reconcileRuns } = await import("../../lib/parallel-agent/worktree-reconciler.ts");
const { getGitProcessStartMarker } = await import("../../lib/parallel-agent/git-lock.ts");
const { getIsolatedRunsRoot } = await import("../../lib/parallel-agent/worktree.ts");
const params = (runId: string) => ({ params: Promise.resolve({ runId }) });
const request = (body: unknown) => new Request("http://fixture.invalid/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function publicJson(response: Response) { const value = await response.json(); assertPublic(value); return value; }
async function detail(runId: string) { const response = await detailRoute.GET(new Request("http://fixture.invalid/api"), params(runId)); assert.equal(response.status, 200); return publicJson(response); }
async function apply(runId: string, payload: unknown) { const response = await applyRoute.POST(request(payload), params(runId)); return { status: response.status, body: await publicJson(response) }; }
async function discard(runId: string, payload: unknown) { const response = await discardRoute.POST(request(payload), params(runId)); return { status: response.status, body: await publicJson(response) }; }
async function create(name: string, workers: string[]) {
  const repo = makeRepository(root, name);
  const response = await createRoute.POST(request({ cwd: repo, message: "offline fixture task", mode: "isolated_coding", workers: workers.map((name) => ({ name, task: "write fixture files" })) }));
  assert.equal(response.status, 200); const first = await publicJson(response);
  if (workers[0] === "theta") { await abortedPromptStarted; assert.equal(await store.abortCollaborationRun(first.runId), true); }
  const state = await orchestrator.waitForCollaborationRun(first.runId);
  assert.equal(state.status, workers[0] === "theta" ? "aborted" : "complete", JSON.stringify({ status: state.status, error: state.error, workers: state.workers }));
  await new Promise((resolve) => setImmediate(resolve));
  const run = await detail(first.runId);
  if (workers[0] !== "theta") assert.equal(run.captureState, "captured"); assert.equal(run.workers.length, workers.length);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  for (const worker of state.workers) assert.equal(git(worker.worktreePath!, ["rev-parse", "HEAD"]).trim(), state.baseCommit);
  const controller = new AbortController();
  const stream = await eventsRoute.GET(new Request("http://fixture.invalid/events", { signal: controller.signal }), params(first.runId));
  const reader = stream.body!.getReader(); const event = await reader.read(); controller.abort(); await reader.cancel();
  const data = new TextDecoder().decode(event.value).trim().replace(/^data: /, ""); assertPublic(JSON.parse(data));
  return { runId: first.runId as string, repo, workerIds: run.workers.map((worker: { workerId: string }) => worker.workerId) as string[] };
}
type Case = Awaited<ReturnType<typeof create>>;
type Cases = { pid: number; partial: Case; full: Case; conflict: Case; continued: Case; restartContinue: Case; patchOnly: Case; aborted: Case; fullKey: string };
try {
  if (mode === "create") {
    const duplicateRepo = makeRepository(root, "duplicate-names");
    const beforeDuplicate = fs.existsSync(getIsolatedRunsRoot()) ? fs.readdirSync(getIsolatedRunsRoot()).sort() : [];
    const callsBeforeDuplicate = modelCalls;
    await assert.rejects(orchestrator.startCollaborationRun({ cwd: duplicateRepo, message: "duplicate test", mode: "isolated_coding", workers: [{ name: "same", task: "first" }, { name: "same", task: "second" }] }), /Worker names/);
    assert.equal(modelCalls, callsBeforeDuplicate);
    assert.deepEqual(fs.existsSync(getIsolatedRunsRoot()) ? fs.readdirSync(getIsolatedRunsRoot()).sort() : [], beforeDuplicate);
    assert.equal(git(duplicateRepo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    const partial = await create("partial", ["alpha", "beta"]);
    for (const workerId of partial.workerIds) {
      const summary = await diffRoute.GET(new Request(`http://fixture.invalid/diff?workerId=${workerId}&format=summary`), params(partial.runId));
      assert.equal(summary.status, 200); const body = await publicJson(summary); assert.equal(body.files.length, 2); assert.equal(body.artifact.available, true);
      const internalWorker = store.getCollaborationRun(partial.runId)!.workers.find((worker) => worker.workerId === workerId)!;
      for (const file of body.files) {
        assert.equal(file.changeKind, "new"); assert.equal(file.oldBytes, null); assert.equal(file.bytes, file.newBytes);
        assert.equal(file.bytes, fs.readFileSync(path.join(internalWorker.worktreePath!, file.path)).length);
        assert.equal(file.addedLines, 1); assert.equal(file.deletedLines, 0);
      }
      assert.equal((await detail(partial.runId)).workers.find((worker: { workerId: string }) => worker.workerId === workerId).changeStats.newFiles, 2);
      const patch = await diffRoute.GET(new Request(`http://fixture.invalid/diff?workerId=${workerId}&format=patch`), params(partial.runId));
      assert.equal(patch.status, 200); assert.match(await patch.text(), /diff --git/);
    }
    const selected = await apply(partial.runId, { workerIds: partial.workerIds, files: ["alpha.txt", "beta.txt"], idempotencyKey: randomUUID() });
    assert.equal(selected.status, 200); assert.deepEqual([...selected.body.files].sort(), ["alpha.txt", "beta.txt"]);
    assert.equal(fs.readFileSync(path.join(partial.repo, "alpha.txt"), "utf8"), "alpha round 1\n");
    assert.equal(fs.existsSync(path.join(partial.repo, "alpha-extra.txt")), false);
    assert.equal(fs.existsSync(path.join(store.getCollaborationRun(partial.runId)!.workers[0].worktreePath!, "alpha-extra.txt")), true);
    const retainedSummary = await diffRoute.GET(new Request(`http://fixture.invalid/diff?workerId=${partial.workerIds[0]}&format=summary`), params(partial.runId));
    assert.equal(retainedSummary.status, 200); assert.ok((await publicJson(retainedSummary)).files.some((file: { path: string }) => file.path === "alpha-extra.txt"));
    const retainedDownload = await diffRoute.GET(new Request(`http://fixture.invalid/diff?workerId=${partial.workerIds[0]}&download=1`), params(partial.runId));
    assert.equal(retainedDownload.status, 200); assert.match(retainedDownload.headers.get("Content-Disposition")!, /^attachment;/);
    assert.match(await retainedDownload.text(), /alpha-extra\.txt/); // V1's single Apply transaction still leaves unselected work downloadable.
    const full = await create("full", ["gamma", "delta"]); const fullKey = randomUUID();
    // Execute the real handler and deliberately never read its first response body.
    const lost = await applyRoute.POST(request({ workerIds: full.workerIds, idempotencyKey: fullKey }), params(full.runId)); assert.equal(lost.status, 200);
    const beforeReplay = treeDigest(full.repo);
    const replay = await apply(full.runId, { workerIds: full.workerIds, idempotencyKey: fullKey });
    assert.equal(replay.body.outcome, "applied"); assert.equal(treeDigest(full.repo), beforeReplay); assert.equal(replay.body.files.length, 4);
    for (const name of ["gamma", "delta"]) {
      assert.equal(fs.readFileSync(path.join(full.repo, `${name}.txt`), "utf8"), `${name} round 1\n`);
      assert.equal(fs.readFileSync(path.join(full.repo, `${name}-extra.txt`), "utf8"), "extra 1\n");
    }
    const conflict = await create("conflict", ["conflictA", "conflictB"]); const before = treeDigest(conflict.repo);
    const failed = await apply(conflict.runId, { workerIds: conflict.workerIds, idempotencyKey: randomUUID() });
    assert.equal(failed.status, 409); assert.equal(failed.body.outcome, "conflict"); assert.equal(treeDigest(conflict.repo), before);
    const continued = await create("continued", ["epsilon"]);
    const oldDigest = (await detail(continued.runId)).workers[0].patchSha256;
    const weakPreview = await discard(continued.runId, { mode: "preview", workerIds: continued.workerIds }); assert.equal(weakPreview.status, 200);
    assert.equal(weakPreview.body.requiresStrongConfirmation, true); assert.equal(weakPreview.body.confirmationToken, undefined);
    const preview = await discard(continued.runId, { mode: "preview", workerIds: continued.workerIds, strongConfirmation: "DISCARD_UNCAPTURED_CHANGES" }); assert.equal(preview.status, 200); assert.ok(preview.body.confirmationToken);
    const resumed = await resumeRoute.POST(request({ prompt: "second round" }), { params: Promise.resolve({ runId: continued.runId, workerId: continued.workerIds[0] }) });
    assert.equal(resumed.status, 200, JSON.stringify(await resumed.clone().json())); await publicJson(resumed);
    assert.notEqual((await detail(continued.runId)).workers[0].patchSha256, oldDigest);
    const invalidToken = await discard(continued.runId, { mode: "commit", confirmationToken: preview.body.confirmationToken }); assert.equal(invalidToken.status, 412);
    const again = await discard(continued.runId, { mode: "preview", workerIds: continued.workerIds, strongConfirmation: "DISCARD_UNCAPTURED_CHANGES" }); assert.equal(again.status, 200);
    const removed = await discard(continued.runId, { mode: "commit", confirmationToken: again.body.confirmationToken }); assert.equal(removed.status, 207); assert.equal(removed.body.complete, false);
    assert.ok(removed.body.workers[0].retainedResources.includes("worktree"), "Discard honestly retains a worktree without a reliable external writer freeze");
    const restartContinue = await create("restart-continue", ["zeta"]);
    const patchOnly = await create("patch-only", ["eta"]);
    const missingWorker = store.getCollaborationRun(patchOnly.runId)!.workers[0];
    git(patchOnly.repo, ["worktree", "remove", "--force", missingWorker.worktreePath!]);
    const aborted = await create("aborted", ["theta"]);
    const cases: Cases = { pid: process.pid, partial, full, conflict, continued, restartContinue, patchOnly, aborted, fullKey };
    fs.writeFileSync(path.join(root, "cases.json"), JSON.stringify(cases));
    console.log("E2E create/capture/diff/full+partial Apply/conflict/replay/Continue/Discard passed");
  } else {
    assert.equal(mode, "restart"); assert.equal(sessionCacheInitiallyEmpty, true);
    const cases: Cases = JSON.parse(fs.readFileSync(path.join(root, "cases.json"), "utf8"));
    assert.notEqual(cases.pid, process.pid);
    await reconcileRuns({ runsRoot: getIsolatedRunsRoot(), instanceId: `e2e-${process.pid}`, processStartIdentity: getGitProcessStartMarker(), isProcessAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } });
    const restored = await detail(cases.restartContinue.runId); const oldDigest = restored.workers[0].patchSha256;
    const oldSessionId = store.getCollaborationRun(cases.restartContinue.runId)!.workers[0].sessionId;
    const continued = await resumeRoute.POST(request({ prompt: "after actual process restart" }), { params: Promise.resolve({ runId: cases.restartContinue.runId, workerId: cases.restartContinue.workerIds[0] }) });
    assert.equal(continued.status, 200, JSON.stringify(await continued.clone().json())); await publicJson(continued);
    assert.notEqual((await detail(cases.restartContinue.runId)).workers[0].patchSha256, oldDigest);
    assert.equal(store.getCollaborationRun(cases.restartContinue.runId)!.workers[0].sessionId, oldSessionId);
    const applied = await apply(cases.restartContinue.runId, { workerIds: cases.restartContinue.workerIds, idempotencyKey: randomUUID() }); assert.equal(applied.status, 200);
    assert.equal(fs.readFileSync(path.join(cases.restartContinue.repo, "zeta.txt"), "utf8"), "zeta round 2\n", "the new runtime resumed the persisted session history");
    const noContinue = await resumeRoute.POST(request({}), { params: Promise.resolve({ runId: cases.patchOnly.runId, workerId: cases.patchOnly.workerIds[0] }) }); assert.equal(noContinue.status, 409); await publicJson(noContinue);
    const patchApplied = await apply(cases.patchOnly.runId, { workerIds: cases.patchOnly.workerIds, idempotencyKey: randomUUID() }); assert.equal(patchApplied.status, 200, JSON.stringify(patchApplied));
    assert.equal((await detail(cases.full.runId)).status, "applied", "startup must not downgrade the persisted Apply fact");
    git(cases.full.repo, ["commit", "-qm", "user commits previously applied work"]); fs.appendFileSync(path.join(cases.full.repo, "gamma.txt"), "later user edit\n");
    const before = treeDigest(cases.full.repo);
    const replay = await apply(cases.full.runId, { workerIds: cases.full.workerIds, idempotencyKey: cases.fullKey }); assert.equal(replay.status, 200, JSON.stringify(replay)); assert.equal(treeDigest(cases.full.repo), before);
    assert.equal((await detail(cases.aborted.runId)).status, "aborted");
    // Remove only fixture-owned, explicitly enumerated Git resources, then verify no unplanned refs/worktrees remain.
    for (const fixture of [cases.partial, cases.full, cases.conflict, cases.continued, cases.restartContinue, cases.patchOnly, cases.aborted]) {
      const manifestPath = path.join(getIsolatedRunsRoot(), fixture.runId, "worktree-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const worker of manifest.workers) {
        assert.ok(worker.worktreePath.startsWith(path.join(root, "tmp", "deerhux-runs") + path.sep));
        if (fs.existsSync(worker.worktreePath)) git(fixture.repo, ["worktree", "remove", "--force", worker.worktreePath]);
        if (git(fixture.repo, ["branch", "--list", worker.branch]).trim()) git(fixture.repo, ["branch", "-D", worker.branch]);
      }
      assert.equal(git(fixture.repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
      assert.equal(git(fixture.repo, ["branch", "--list"]).trim().split("\n").length, 1);
      assert.equal(fs.existsSync(path.join(fixture.repo, ".git", "index.lock")), false);
    }
    fs.writeFileSync(path.join(root, "restart.json"), JSON.stringify({ pid: process.pid, sessionCacheInitiallyEmpty, passed: true }));
    console.log("E2E fresh-process Store/session/manifest recovery + Continue/Apply + terminal facts passed");
  }
} finally { hooks.deregister(); }
