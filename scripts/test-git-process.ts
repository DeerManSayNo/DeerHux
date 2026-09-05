import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GitProcessError,
  redactGitArgv,
  runGit,
  type GitProcessErrorCode,
} from "../lib/parallel-agent/git-process.ts";

function expectCode(code: GitProcessErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof GitProcessError && error.code === code;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux git ;$ test "));
try {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Git Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "git@example.invalid"], { cwd: root });
  const hostileName = "space ; $(touch SHOULD_NOT_EXIST) [x].txt";
  fs.writeFileSync(path.join(root, hostileName), "content\n");
  await runGit({ cwd: root, args: ["add", "--", hostileName] });
  const status = await runGit({ cwd: root, args: ["status", "--porcelain=v1", "-z"] });
  assert.equal(status.exitCode, 0);
  assert.ok(status.stdout.includes(hostileName));
  assert.equal(fs.existsSync(path.join(root, "SHOULD_NOT_EXIST")), false, "argv must never be interpreted by a shell");

  await assert.rejects(
    runGit({ cwd: root, args: ["rev-parse", "--verify", "does-not-exist"] }),
    expectCode("GIT_REF_NOT_FOUND"),
  );

  const blob = Buffer.alloc(64 * 1024, 0x61);
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: blob, encoding: "utf8" }).trim();
  await assert.rejects(
    runGit({ cwd: root, args: ["cat-file", "blob", oid], maxStdoutBytes: 1024 }),
    (error) => error instanceof GitProcessError
      && error.code === "GIT_OUTPUT_LIMIT"
      && Buffer.byteLength(error.stdout) <= 1024,
  );
  await assert.rejects(
    runGit({
      cwd: root,
      args: ["-c", "alias.noisy=!node -e 'process.stderr.write(\"x\".repeat(65536))'", "noisy"],
      maxStderrBytes: 1024,
    }),
    (error) => error instanceof GitProcessError
      && error.code === "GIT_OUTPUT_LIMIT"
      && Buffer.byteLength(error.stderr) <= 1024,
  );

  await assert.rejects(
    runGit({ cwd: root, args: ["status"], env: { PATH: "" } }),
    expectCode("GIT_SPAWN_FAILED"),
  );

  await assert.rejects(
    runGit({
      cwd: root,
      args: ["-c", "alias.wait=!node -e 'setTimeout(() => {}, 10000)'", "wait"],
      timeoutMs: 40,
      readTimeoutMs: 2_000,
    }),
    expectCode("GIT_TIMEOUT"),
  );
  await assert.rejects(
    runGit({
      cwd: root,
      args: ["-c", "alias.wait=!node -e 'setTimeout(() => {}, 10000)'", "wait"],
      timeoutMs: 2_000,
      readTimeoutMs: 40,
    }),
    expectCode("GIT_READ_TIMEOUT"),
  );
  await assert.rejects(
    runGit({
      cwd: root,
      args: ["-c", "alias.block=!node -e 'setTimeout(() => {}, 10000)'", "block"],
      stdin: Buffer.alloc(8 * 1024 * 1024),
      timeoutMs: 2_000,
      readTimeoutMs: 2_000,
      writeTimeoutMs: 40,
    }),
    expectCode("GIT_WRITE_TIMEOUT"),
  );

  const controller = new AbortController();
  const aborted = runGit({
    cwd: root,
    args: ["-c", "alias.wait=!node -e 'setTimeout(() => {}, 10000)'", "wait"],
    signal: controller.signal,
    timeoutMs: 2_000,
    readTimeoutMs: 2_000,
  });
  setTimeout(() => controller.abort(new Error("test cancellation")), 20);
  await assert.rejects(aborted, expectCode("GIT_ABORTED"));

  const events: unknown[] = [];
  await runGit({
    cwd: root,
    args: ["-c", "http.example.invalid.extraHeader=Authorization: secret-value", "status"],
    logger: (event) => events.push(event),
  });
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes("secret-value"), false, "logs must redact config credentials");
  assert.deepEqual(redactGitArgv(["-c", "http.extraHeader=Authorization: secret"]), ["git", "-c", "<redacted>"]);
  assert.equal(serializedEvents.includes(root), false, "logs must not include the repository path");
  assert.deepEqual(
    redactGitArgv(["diff", `--output=${path.join(root, "secret.patch")}`]),
    ["git", "diff", "--output=<path>"],
  );
  assert.equal((await runGit({
    cwd: root,
    args: ["status", "--porcelain"],
    logger: () => { throw new Error("broken logger"); },
  })).exitCode, 0, "logging failures must not affect Git execution");
  assert.deepEqual(
    redactGitArgv(["fetch", "https://user:token@example.invalid/repo.git"]),
    ["git", "fetch", "https://<redacted>@example.invalid/repo.git"],
  );

  console.log("git process tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
