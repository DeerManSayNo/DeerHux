import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWorktreeEnvironmentConfig, prepareWorktreeEnvironment, validateSyntheticPaths,
  WorktreeEnvironmentError, type WorktreeEnvironmentConfig, type WorktreeEnvironmentErrorCode,
} from "../lib/parallel-agent/worktree-environment.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(script = "process.stdout.write(JSON.stringify({syntheticPaths:[]}));") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-env-test-")));
  const repo = path.join(root, "repo");
  const worker = path.join(root, "worker");
  const agentDir = path.join(root, "trusted-agent");
  fs.mkdirSync(repo);
  fs.mkdirSync(agentDir);
  fs.mkdirSync(path.join(repo, "scripts"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Environment Test"]);
  git(repo, ["config", "user.email", "environment@example.invalid"]);
  fs.writeFileSync(path.join(repo, "scripts", "prepare.cjs"), script);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "source\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\nnode_modules/\n*.sqlite\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, ".env"), "TEST_FIXTURE_ONLY=never-copy\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "main.txt"), "main dependency\n");
  git(repo, ["worktree", "add", "-q", "--detach", worker, baseCommit]);
  const options = { repoRoot: repo, worktreePath: worker, agentCwd: worker, baseCommit, workerId: "worker-env-test" };
  return { root, repo, worker, agentDir, baseCommit, options,
    dispose() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}
async function rejectsCode(operation: Promise<unknown>, code: WorktreeEnvironmentErrorCode) {
  await assert.rejects(operation, (error: unknown) => error instanceof WorktreeEnvironmentError && error.code === code && error.message === code);
}
const hookConfig: WorktreeEnvironmentConfig = { mode: "hook", script: "scripts/prepare.cjs" };

{
  const f = fixture();
  try {
    assert.deepEqual(await loadWorktreeEnvironmentConfig(f.repo, { agentDir: f.agentDir }), { mode: "none" });
    const none = await prepareWorktreeEnvironment({ ...f.options, config: { mode: "none" } });
    assert.deepEqual(none, { mode: "none", syntheticPaths: [], syntheticIdentities: [] });
    assert.equal(fs.existsSync(path.join(f.worker, ".env")), false);
    assert.equal(fs.existsSync(path.join(f.worker, "node_modules")), false);
    fs.writeFileSync(path.join(f.repo, "worktree-environments.json"), JSON.stringify({ version: 1, repositories: { [f.repo]: hookConfig } }));
    assert.equal((await loadWorktreeEnvironmentConfig(f.repo, { agentDir: f.agentDir })).mode, "none", "repo-local config cannot enable execution");
    await rejectsCode(loadWorktreeEnvironmentConfig(f.repo, { configPath: path.join(f.repo, "worktree-environments.json"), agentDir: f.agentDir }), "ENV_CONFIG_INVALID");
    fs.writeFileSync(path.join(f.agentDir, "worktree-environments.json"), JSON.stringify({ version: 1, repositories: { [f.repo]: hookConfig } }));
    const alias = path.join(f.root, "repo-alias");
    fs.symlinkSync(f.repo, alias);
    assert.equal((await loadWorktreeEnvironmentConfig(alias, { agentDir: f.agentDir })).mode, "hook", "configuration uses canonical repository identity");
    await rejectsCode(loadWorktreeEnvironmentConfig(f.repo, { config: { mode: "isolated-install" } }), "ENV_MODE_UNSUPPORTED");
    await rejectsCode(prepareWorktreeEnvironment({ ...f.options, config: { mode: "isolated-install" } }), "ENV_MODE_UNSUPPORTED");
    for (const script of ["../escape.cjs", "/absolute.cjs", "scripts/link.ts", ".git/hook.cjs", "scripts\\prepare.cjs"]) {
      await rejectsCode(loadWorktreeEnvironmentConfig(f.repo, { config: { mode: "hook", script } }), "ENV_CONFIG_INVALID");
    }
    for (const name of ["OPENAI_API_KEY", "SIGNING_KEY", "REDIS_URL", "DEERHUX_TEST_SECRET", "NODE_OPTIONS", "PATH", "GIT_CONFIG_COUNT", "SSH_AUTH_SOCK"]) {
      await rejectsCode(loadWorktreeEnvironmentConfig(f.repo, { config: { ...hookConfig, envAllowlist: [name] } }), "ENV_CONFIG_INVALID");
    }
    assert.equal(git(f.worker, ["status", "--porcelain"]), "");
  } finally { f.dispose(); }
}

{
  const script = `const fs=require('node:fs');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
    const input=JSON.parse(data);fs.mkdirSync('node_modules');fs.writeFileSync('node_modules/info.json',JSON.stringify({input,env:process.env}));
    fs.writeFileSync('node_modules/main.txt','worker dependency');process.stdout.write(JSON.stringify({syntheticPaths:['node_modules']}));
  });`;
  const f = fixture(script);
  const savedValue = process.env.DEERHUX_TEST_VALUE;
  const savedSecret = process.env.DEERHUX_TEST_SECRET;
  process.env.DEERHUX_TEST_VALUE = "allowed-test-value";
  process.env.DEERHUX_TEST_SECRET = "blocked-test-secret";
  try {
    const prepared = await prepareWorktreeEnvironment({ ...f.options, config: { ...hookConfig, envAllowlist: ["DEERHUX_TEST_VALUE"] } });
    assert.deepEqual(prepared.syntheticPaths, ["node_modules"]);
    const info = JSON.parse(fs.readFileSync(path.join(f.worker, "node_modules/info.json"), "utf8"));
    assert.deepEqual(info.input, { repoRoot: f.repo, worktreePath: f.worker, agentCwd: f.worker, baseCommit: f.baseCommit, workerId: f.options.workerId });
    assert.equal(info.env.DEERHUX_TEST_VALUE, "allowed-test-value");
    assert.equal(info.env.DEERHUX_TEST_SECRET, undefined);
    assert.equal(info.env.NODE_OPTIONS, undefined);
    assert.equal(info.env.HOME, f.worker);
    assert.equal(fs.readFileSync(path.join(f.repo, "node_modules/main.txt"), "utf8"), "main dependency\n");
    assert.equal(fs.existsSync(path.join(f.worker, ".env")), false);
    assert.equal(fs.readdirSync(path.join(f.worker, "scripts")).some((name) => name.startsWith(".deerhux-environment-")), false, "private execution snapshot is removed by exact identity");
    assert.deepEqual(await validateSyntheticPaths({ worktreePath: f.worker, baseCommit: f.baseCommit, paths: prepared.syntheticPaths, expectedIdentities: prepared.syntheticIdentities }), prepared.syntheticIdentities);
    fs.renameSync(path.join(f.worker, "node_modules"), path.join(f.worker, "original-dependencies"));
    fs.mkdirSync(path.join(f.worker, "node_modules"));
    await rejectsCode(validateSyntheticPaths({ worktreePath: f.worker, baseCommit: f.baseCommit, paths: prepared.syntheticPaths, expectedIdentities: prepared.syntheticIdentities }), "ENV_SYNTHETIC_INVALID");
    assert.equal(fs.existsSync(path.join(f.worker, "original-dependencies/info.json")), true, "validation must never delete replacement or original data");
  } finally {
    if (savedValue === undefined) delete process.env.DEERHUX_TEST_VALUE; else process.env.DEERHUX_TEST_VALUE = savedValue;
    if (savedSecret === undefined) delete process.env.DEERHUX_TEST_SECRET; else process.env.DEERHUX_TEST_SECRET = savedSecret;
    f.dispose();
  }
}

for (const change of ["changed", "symlink", "untracked", "parent-symlink"] as const) {
  const f = fixture();
  try {
    if (change === "changed") fs.writeFileSync(path.join(f.worker, "scripts/prepare.cjs"), "process.stdout.write('changed');");
    if (change === "symlink") {
      fs.unlinkSync(path.join(f.worker, "scripts/prepare.cjs"));
      fs.symlinkSync(path.join(f.repo, "scripts/prepare.cjs"), path.join(f.worker, "scripts/prepare.cjs"));
    }
    if (change === "untracked") fs.writeFileSync(path.join(f.worker, "scripts/untracked.cjs"), "process.stdout.write('{}');");
    if (change === "parent-symlink") {
      fs.renameSync(path.join(f.worker, "scripts"), path.join(f.worker, "original-scripts"));
      fs.symlinkSync(path.join(f.worker, "original-scripts"), path.join(f.worker, "scripts"));
    }
    await rejectsCode(prepareWorktreeEnvironment({ ...f.options, config: change === "untracked" ? { mode: "hook", script: "scripts/untracked.cjs" } : hookConfig }),
      change === "changed" ? "ENV_HOOK_CHANGED" : change === "untracked" ? "ENV_HOOK_NOT_TRACKED" : "ENV_HOOK_INVALID");
  } finally { f.dispose(); }
}

{
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.worker, "generated"));
    fs.writeFileSync(path.join(f.worker, "generated/value.txt"), "keep me\n");
    const options = { worktreePath: f.worker, baseCommit: f.baseCommit, paths: ["generated"] };
    const identities = await validateSyntheticPaths(options);
    if (fs.existsSync(path.join(f.worker, "TRACKED.TXT"))) {
      await rejectsCode(validateSyntheticPaths({ ...options, paths: ["TRACKED.TXT"] }), "ENV_SYNTHETIC_INVALID");
      await rejectsCode(validateSyntheticPaths({ ...options, paths: ["GENERATED"] }), "ENV_SYNTHETIC_INVALID");
    }
    for (const entry of [".", "..", "../outside", ".git", ".GIT", "scripts", "tracked.txt", "scripts/prepare.cjs", "/tmp/outside", "generated/../tracked.txt"]) {
      await rejectsCode(validateSyntheticPaths({ ...options, paths: [entry] }), "ENV_SYNTHETIC_INVALID");
    }
    git(f.worker, ["add", "generated/value.txt"]);
    await rejectsCode(validateSyntheticPaths(options), "ENV_SYNTHETIC_INVALID");
    git(f.worker, ["restore", "--staged", "generated/value.txt"]);
    fs.renameSync(path.join(f.worker, "generated"), path.join(f.worker, "original-generated"));
    assert.deepEqual(await validateSyntheticPaths({ ...options, expectedIdentities: identities, allowMissing: true }), []);
    fs.symlinkSync(path.join(f.worker, "original-generated"), path.join(f.worker, "generated"));
    await rejectsCode(validateSyntheticPaths({ ...options, expectedIdentities: identities, allowMissing: true }), "ENV_SYNTHETIC_INVALID");
    assert.equal(fs.readFileSync(path.join(f.worker, "original-generated/value.txt"), "utf8"), "keep me\n");
  } finally { f.dispose(); }
}

for (const [script, config, errorCode] of [
  ["require('node:fs').writeFileSync('preserved.txt','keep');process.stderr.write('test-secret-not-public');process.exit(7);", hookConfig, "ENV_HOOK_FAILED"],
  ["require('node:fs').writeFileSync('preserved.txt','keep');process.stdout.write('x'.repeat(4096));", { ...hookConfig, maxOutputBytes: 512 }, "ENV_HOOK_OUTPUT_LIMIT"],
  ["require('node:fs').writeFileSync('preserved.txt','keep');setInterval(()=>{},10);", { ...hookConfig, timeoutMs: 300 }, "ENV_HOOK_TIMEOUT"],
  ["process.stdout.write('not json');", hookConfig, "ENV_OUTPUT_INVALID"],
  ["process.stdout.write(JSON.stringify({syntheticPaths:['tracked.txt']}));", hookConfig, "ENV_SYNTHETIC_INVALID"],
] as const) {
  const f = fixture(script);
  try {
    await rejectsCode(prepareWorktreeEnvironment({ ...f.options, config }), errorCode);
    if (script.includes("preserved.txt")) assert.equal(fs.readFileSync(path.join(f.worker, "preserved.txt"), "utf8"), "keep");
    assert.equal(fs.readdirSync(path.join(f.worker, "scripts")).some((name) => name.startsWith(".deerhux-environment-")), false);
  } finally { f.dispose(); }
}

{
  const f = fixture("require('node:fs').writeFileSync('started.txt','preserve');setInterval(()=>{},10);");
  const controller = new AbortController();
  const result = prepareWorktreeEnvironment({ ...f.options, config: hookConfig, signal: controller.signal });
  try {
    for (let attempt = 0; attempt < 200 && !fs.existsSync(path.join(f.worker, "started.txt")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(path.join(f.worker, "started.txt")), true);
    controller.abort(new Error("private cancellation reason"));
    await rejectsCode(result, "ENV_ABORTED");
    assert.equal(fs.readFileSync(path.join(f.worker, "started.txt"), "utf8"), "preserve");
  } finally { controller.abort(); await result.catch(() => undefined); f.dispose(); }
}

if (process.platform !== "win32") {
  for (const success of [false, true]) {
    const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ticks.txt','x');fs.writeFileSync('grandchild-ready.txt',String(process.pid));setInterval(()=>fs.appendFileSync('ticks.txt','x'),10);`;
    const script = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}).unref();
      const timer=setInterval(()=>{if(!fs.existsSync('grandchild-ready.txt'))return;clearInterval(timer);
      process.stdout.write(${JSON.stringify(success ? JSON.stringify({ syntheticPaths: ["grandchild-ready.txt", "ticks.txt"] }) : "x".repeat(4096))});},10);`;
    const f = fixture(script);
    try {
      const operation = prepareWorktreeEnvironment({ ...f.options, config: { ...hookConfig, maxOutputBytes: success ? 4096 : 512 } });
      if (success) assert.equal((await operation).mode, "hook");
      else await rejectsCode(operation, "ENV_HOOK_OUTPUT_LIMIT");
      const ticks = fs.readFileSync(path.join(f.worker, "ticks.txt"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(fs.readFileSync(path.join(f.worker, "ticks.txt"), "utf8"), ticks,
        "parent close must not leave a SIGTERM-ignoring, detached-stdio grandchild writing");
    } finally {
      const pidFile = path.join(f.worker, "grandchild-ready.txt");
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* expected already gone */ } }
      }
      f.dispose();
    }
  }
}

{
  const f = fixture("const fs=require('node:fs');fs.renameSync(__filename,'original-snapshot.cjs');fs.writeFileSync(__filename,'replacement data');process.stdout.write(JSON.stringify({syntheticPaths:[]}));");
  try {
    await rejectsCode(prepareWorktreeEnvironment({ ...f.options, config: hookConfig }), "ENV_HOOK_CHANGED");
    const replacement = fs.readdirSync(path.join(f.worker, "scripts")).find((name) => name.startsWith(".deerhux-environment-"));
    assert.ok(replacement, "changed-identity execution snapshot must not be silently deleted");
    assert.equal(fs.readFileSync(path.join(f.worker, "scripts", replacement), "utf8"), "replacement data");
  } finally { f.dispose(); }
}

console.log("worktree environment tests passed");
