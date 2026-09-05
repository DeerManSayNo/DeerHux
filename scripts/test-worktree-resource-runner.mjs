import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-resource-runner-selftest-")));
const runner = fileURLToPath(new URL("./run-worktree-resource-test.mjs", import.meta.url));
const prelude = 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");';
function run(source, success) {
  const child = spawnSync(process.execPath, [runner, "-e", prelude + source], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status === 0, success, child.stderr);
  if (!success) assert.match(child.stderr, /Unexpected|Refusing/);
  assert.deepEqual(fs.readdirSync(root), [], "launcher must clean its exact private root even when its exit assertion fails");
}
try {
  run("", true);
  run('fs.mkdirSync(path.join(os.tmpdir(),"deerhux-runs"));fs.mkdirSync(path.join(process.env.DEERHUX_CODING_AGENT_DIR,"tasks"));', true);
  for (const name of ["unexpected-repo", "deerhux-atomic-apply-leak", "deerhux-runs/run-leak"]) {
    run(`fs.mkdirSync(path.join(os.tmpdir(),${JSON.stringify(name)}),{recursive:true});`, false);
  }
  for (const name of ["index.lock", "deerhux-operation.lock", "deerhux-git-1.start"]) {
    run(`fs.writeFileSync(path.join(os.tmpdir(),${JSON.stringify(name)}),"leak");`, false);
  }
  run('fs.mkdirSync(path.join(process.env.DEERHUX_CODING_AGENT_DIR,"tasks"));fs.writeFileSync(path.join(process.env.DEERHUX_CODING_AGENT_DIR,"tasks","unexpected.json"),"{}");', false);
  // A symlink cannot turn the allowed empty shell into a directory to follow.
  run('fs.symlinkSync(process.cwd(),path.join(os.tmpdir(),"deerhux-runs"),"dir");', false);
  run('const p=os.tmpdir();fs.rmdirSync(p);fs.symlinkSync(process.cwd(),p,"dir");', false);
  console.log("TST-1205 resource launcher tests passed (private namespace, strict whitelist, failure cleanup, no symlink traversal)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
