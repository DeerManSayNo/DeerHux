import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-handler-e2e-")));
for (const name of ["tmp", "agent"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
async function phase(mode: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--loader", fileURLToPath(new URL("./typescript-test-loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/worktree-e2e-child.ts", import.meta.url)), mode, root], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
        SUBAGENT_WORKTREE_V2: mode === "create" ? "1" : "0",
        DEERHUX_CODING_AGENT_DIR: path.join(root, "agent"), PI_CODING_AGENT_DIR: path.join(root, "agent"),
        GIT_CONFIG_GLOBAL: path.join(root, "absent-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`E2E ${mode} timeout\n${output.slice(-12000)}`)); }, 60_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); if (code === 0) { process.stdout.write(output); resolve(); } else reject(new Error(`E2E ${mode} failed (${code})\n${output.slice(-16000)}`)); });
  });
}
try {
  await phase("create");
  const created = JSON.parse(fs.readFileSync(path.join(root, "cases.json"), "utf8"));
  await phase("restart");
  const restarted = JSON.parse(fs.readFileSync(path.join(root, "restart.json"), "utf8"));
  assert.notEqual(created.pid, restarted.pid, "recovery runs in a genuinely new Node process");
  assert.equal(restarted.sessionCacheInitiallyEmpty, true);
  assert.equal(restarted.passed, true);
  console.log("worktree real-handler + fresh-process E2E passed (model execution stubbed; no HTTP/browser claim)");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
