import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windows = ["pending", "created", "written", "SIGTERM", "SIGKILL"] as const;
type CrashWindow = typeof windows[number];
const [mode, root, windowName] = process.argv.slice(2);
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
  cwd, encoding: "utf8", stdio: "pipe", timeout: 10_000,
  env: { PATH: process.env.PATH, NODE_ENV: "test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

if (mode === "crash" || mode === "verify") {
  assert.ok(root && fs.realpathSync(root) === root);
  assert.ok(windows.includes(windowName as CrashWindow));
  assert.equal(process.env.TMPDIR, path.join(root, "tmp"));
  assert.equal(process.env.DEERHUX_CODING_AGENT_DIR, path.join(root, "agent"));
  globalThis.fetch = async () => { throw new Error("CRASH_FIXTURE_NETWORK_FORBIDDEN"); };
  net.Socket.prototype.connect = (() => { throw new Error("CRASH_FIXTURE_NETWORK_FORBIDDEN"); }) as typeof net.Socket.prototype.connect;
  const runId = `crash_${windowName}`;
  const repo = path.join(root, "repo");
  const runsRoot = path.join(root, "tmp", "deerhux-runs");
  const manifestPath = path.join(runsRoot, runId, "worktree-manifest.json");
  if (mode === "crash") {
    const { setupIsolatedWorkspace } = await import("../lib/parallel-agent/worktree.ts");
    try {
      const setup = await setupIsolatedWorkspace(repo, runId, "crash-fixture", [{ workerId: "worker", displayName: "Worker" }], {
        environmentConfig: { mode: "none" },
        onManifestWrite(index) {
          // The first planning manifest is already durable; exit before writing setting_up.
          if (windowName === "pending" && index === 1) process.exit(71);
        },
        onStep(step) {
          // Real Git worktree add completed, but no Worker started and no settled state was written.
          if (windowName === "created" && step === "after_add") process.exit(72);
        },
      });
      assert.ok(["written", "SIGTERM", "SIGKILL"].includes(windowName));
      const worker = setup.worktrees.get("worker")!;
      // Stand-in Worker writes, with no model, hook or capture invocation.
      fs.writeFileSync(path.join(worker, "source.txt"), "uncaptured tracked output\n");
      fs.writeFileSync(path.join(worker, "new-output.bin"), Buffer.from([0, 255, 3, 128]));
      if (windowName === "SIGTERM" || windowName === "SIGKILL") {
        // The parent delivers a real OS signal only after all uncaptured bytes exist.
        process.stdout.write("SIGNAL_READY\n");
        await new Promise<void>(() => { setInterval(() => {}, 1_000); });
      }
      process.exit(73);
    } finally {
      fs.writeFileSync(path.join(root, "unexpected-finally"), "exception-style cleanup ran");
    }
  } else {
    const { readWorktreeManifest } = await import("../lib/parallel-agent/worktree-manifest.ts");
    const { reconcileRuns } = await import("../lib/parallel-agent/worktree-reconciler.ts");
    const beforeRead = readWorktreeManifest(manifestPath); assert.equal(beforeRead.kind, "ok");
    if (beforeRead.kind !== "ok") throw new Error("crash did not leave a valid durable manifest");
    const before = beforeRead.manifest;
    const worker = before.workers[0];
    assert.throws(() => process.kill(before.ownerPid, 0), "the crashed owner must really be gone");
    assert.equal(fs.existsSync(path.join(root, "unexpected-finally")), false, "process.exit bypassed catch/finally rollback");
    assert.equal(before.activeOperation, ["written", "SIGTERM", "SIGKILL"].includes(windowName) ? "running" : "setup");
    assert.equal(before.state, windowName === "pending" ? "planning" : windowName === "created" ? "setting_up" : "running");
    assert.equal(worker.capture, null, "the fixture never fabricated or captured an artifact");
    const expectedWorktree = windowName !== "pending";
    assert.equal(fs.existsSync(worker.worktreePath), expectedWorktree);
    const beforeRefs = git(repo, ["show-ref"]);
    const beforeList = git(repo, ["worktree", "list", "--porcelain"]);
    const beforeIndex = fs.readFileSync(path.join(repo, ".git", "index"));
    const base = git(repo, ["rev-parse", "HEAD"]);
    const result = await reconcileRuns({ runsRoot, instanceId: `verifier-${process.pid}`, processStartIdentity: "crash-test-verifier",
      isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } } });
    assert.equal(result.issues.length, 0);
    assert.ok(result.recovered.some((run) => run.runId === runId));
    const afterRead = readWorktreeManifest(manifestPath); assert.equal(afterRead.kind, "ok");
    if (afterRead.kind !== "ok") throw new Error("recovery lost the manifest");
    assert.equal(afterRead.manifest.state, expectedWorktree ? "preserved" : "cleanup_error");
    assert.equal(afterRead.manifest.activeOperation, null);
    assert.equal(afterRead.manifest.baseCommit, before.baseCommit);
    assert.equal(afterRead.manifest.workers[0].capture, null);
    assert.equal(fs.existsSync(worker.worktreePath), expectedWorktree);
    assert.equal(git(repo, ["show-ref"]), beforeRefs, "recovery cannot delete or rewrite unfinished branches");
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]), beforeList);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), base);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), beforeIndex);
    assert.equal(fs.readFileSync(path.join(repo, "source.txt"), "utf8"), "base\n");
    if (expectedWorktree) assert.equal(git(repo, ["rev-parse", `refs/heads/${worker.branch}`]), base);
    if (["written", "SIGTERM", "SIGKILL"].includes(windowName)) {
      assert.equal(fs.readFileSync(path.join(worker.worktreePath, "source.txt"), "utf8"), "uncaptured tracked output\n");
      assert.deepEqual(fs.readFileSync(path.join(worker.worktreePath, "new-output.bin")), Buffer.from([0, 255, 3, 128]));
    }
    assert.ok(result.plans.flatMap((plan) => plan.workers).every((entry) => entry.decision === "retain"));
    assert.equal(fs.existsSync(path.join(repo, ".git", "index.lock")), false);
    console.log(`real setup process exit verified: ${windowName}`);
  }
} else {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-setup-crash-")));
  async function child(childMode: "crash" | "verify", caseRoot: string, phase: CrashWindow): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, ["--no-warnings", "--loader", fileURLToPath(new URL("./typescript-test-loader.mjs", import.meta.url)),
        fileURLToPath(import.meta.url), childMode, caseRoot, phase], {
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, NODE_ENV: "test", SUBAGENT_WORKTREE_V2: "1", TMPDIR: path.join(caseRoot, "tmp"), TMP: path.join(caseRoot, "tmp"), TEMP: path.join(caseRoot, "tmp"),
          DEERHUX_CODING_AGENT_DIR: path.join(caseRoot, "agent"), PI_CODING_AGENT_DIR: path.join(caseRoot, "agent"),
          GIT_CONFIG_GLOBAL: path.join(caseRoot, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" },
      });
      let output = "";
      let signalSent = false;
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_000);
        if (childMode === "crash" && (phase === "SIGTERM" || phase === "SIGKILL") && !signalSent && output.includes("SIGNAL_READY\n")) {
          signalSent = true;
          processChild.kill(phase);
        }
      };
      processChild.stdout.on("data", append); processChild.stderr.on("data", append);
      const timer = setTimeout(() => {
        try { process.kill(process.platform === "win32" ? processChild.pid! : -processChild.pid!, "SIGKILL"); } catch { /* already exited */ }
        reject(new Error(`setup crash ${phase}/${childMode} timeout\n${output}`));
      }, 30_000);
      processChild.on("error", (error) => { clearTimeout(timer); reject(error); });
      processChild.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (childMode === "verify" && code !== 0) { reject(new Error(output)); return; }
        if (childMode === "crash" && (phase === "SIGTERM" || phase === "SIGKILL") && (!signalSent || signal !== phase || code !== null)) {
          reject(new Error(`expected actual ${phase} termination; code=${code}, signal=${signal}\n${output}`)); return;
        }
        process.stdout.write(output); resolve(code);
      });
    });
  }
  try {
    for (const [index, phase] of windows.entries()) {
      const caseRoot = path.join(sandbox, phase); fs.mkdirSync(caseRoot, { mode: 0o700 });
      for (const name of ["repo", "tmp", "agent"]) fs.mkdirSync(path.join(caseRoot, name), { mode: 0o700 });
      const repo = path.join(caseRoot, "repo"); git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "Setup Crash"]); git(repo, ["config", "user.email", "crash@example.invalid"]);
      fs.writeFileSync(path.join(repo, "source.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
      assert.equal(await child("crash", caseRoot, phase), phase.startsWith("SIG") ? null : 71 + index, "the selected process exit/signal point must be reached");
      assert.equal(await child("verify", caseRoot, phase), 0);
    }
    console.log("real setup crash windows passed (pending / created / written / actual SIGTERM / actual SIGKILL)");
  } finally {
    // The entire repo, refs, run directories, session roots and dead-owner locks are owned by this exact fixture root.
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
