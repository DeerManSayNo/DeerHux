import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// TST-1205: give one existing test (and its descendants) a registered private
// resource namespace. Never inspect the host tmp directory or user agent data.
const args = process.argv.slice(2);
assert.ok(args.length, "Pass the existing Node flags and test script to this launcher");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-resource-test-")));
const identity = fs.lstatSync(root);
const temporary = path.join(root, "tmp");
const agent = path.join(root, "agent");
fs.mkdirSync(temporary, { mode: 0o700 });
fs.mkdirSync(agent, { mode: 0o700 });
const childIdentities = new Map([temporary, agent].map((directory) => [directory, fs.lstatSync(directory)]));

function assertOwnedRoot() {
  const current = fs.lstatSync(root);
  assert.ok(current.isDirectory() && !current.isSymbolicLink()
    && current.dev === identity.dev && current.ino === identity.ino,
  "Refusing to inspect or remove a replaced resource-test root");
}

function assertNoUnexpectedResources() {
  assertOwnedRoot();
  for (const [directory, expected] of childIdentities) {
    const current = fs.lstatSync(directory);
    assert.ok(current.isDirectory() && !current.isSymbolicLink()
      && current.dev === expected.dev && current.ino === expected.ino,
    "Refusing to inspect a replaced private resource directory");
  }
  // Only an empty managed-runs shell is allowed in tmp. No process marker,
  // lock, repository, Worktree, run artifact or Apply scratch is exempted.
  for (const name of fs.readdirSync(temporary)) {
    const target = path.join(temporary, name);
    const stat = fs.lstatSync(target);
    assert.ok(name === "deerhux-runs" && stat.isDirectory() && !stat.isSymbolicLink()
      && fs.readdirSync(target).length === 0, `Unexpected test resource remains: tmp/${name}`);
  }
  // Persistence removes the registered task files, but keeps its empty shell.
  for (const name of fs.readdirSync(agent)) {
    const target = path.join(agent, name);
    const stat = fs.lstatSync(target);
    assert.ok(name === "tasks" && stat.isDirectory() && !stat.isSymbolicLink()
      && fs.readdirSync(target).length === 0, `Unexpected private agent resource remains: agent/${name}`);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ["agent", "tmp"], "Unexpected resource-test root entry remains");
}

let child;
const signals = new Map();
try {
  const result = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        DEERHUX_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
      },
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => child.kill(signal);
      signals.set(signal, handler);
      process.on(signal, handler);
    }
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assertNoUnexpectedResources();
  assert.equal(result.code, 0, `Child test failed: code=${result.code}, signal=${result.signal}`);
  console.log(`TST-1205 private resource exit check passed: ${args.find((arg) => /scripts\/test-[^/]+\.[cm]?[jt]s$/.test(arg)) ?? "child"}`);
} finally {
  for (const [signal, handler] of signals) process.off(signal, handler);
  assertOwnedRoot();
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false, "Private resource-test root was not removed");
}
