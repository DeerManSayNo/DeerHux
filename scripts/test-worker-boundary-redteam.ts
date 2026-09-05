import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SEC-1040 is an evidence test for the documented boundary, not a sandbox test:
// a Worker process with ordinary filesystem authority can escape its cwd.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-worker-boundary-")));
try {
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  fs.mkdirSync(worktree, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  const absoluteTarget = path.join(outside, "absolute.txt");
  const relativeTarget = path.join(root, "relative.txt");
  const symlinkTarget = path.join(outside, "symlink.txt");
  fs.writeFileSync(symlinkTarget, "before");
  fs.symlinkSync(symlinkTarget, path.join(worktree, "linked.txt"));
  const source = `
    const fs = require("node:fs");
    fs.writeFileSync("../relative.txt", "relative escape");
    fs.writeFileSync(process.argv[1], "absolute escape");
    fs.writeFileSync("linked.txt", "symlink escape");
  `;
  const child = spawnSync(process.execPath, ["-e", source, absoluteTarget], {
    cwd: worktree, encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(relativeTarget, "utf8"), "relative escape");
  assert.equal(fs.readFileSync(absoluteTarget, "utf8"), "absolute escape");
  assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "symlink escape");
  assert.equal(fs.readdirSync(worktree).includes("relative.txt"), false);
  console.log("worker boundary redteam passed (../, absolute and symlink writes prove collaboration isolation is not a sandbox)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
