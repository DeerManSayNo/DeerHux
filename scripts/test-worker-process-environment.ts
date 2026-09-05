import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStandardCodingTools } from "../lib/engine/coding-tools.ts";
import { buildWorkerProcessEnvironment, WORKER_PROCESS_ENV_ALLOWLIST } from "../lib/engine/worker-process-environment.ts";

const secrets = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "DATABASE_URL",
  "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "BASH_ENV", "ENV", "HOME", "DEERHUX_TEST_SECRET"];
const source = { PATH: process.env.PATH, LANG: "C", ...Object.fromEntries(secrets.map((name) => [name, "fixture-secret-only"])) };
const environment = buildWorkerProcessEnvironment(source);
assert.equal(Object.isFrozen(environment), true);
assert.equal(Object.isFrozen(WORKER_PROCESS_ENV_ALLOWLIST), true);
assert.equal(environment.LANG, "C");
assert.equal(environment.CI, "true");
for (const name of secrets) assert.equal(environment[name], undefined);
source.LANG = "changed-after-snapshot";
assert.equal(environment.LANG, "C");
assert.equal(buildWorkerProcessEnvironment({ TMPDIR: "bad\0path" }).TMPDIR, undefined);

// A real shell child verifies the tool's spawn wiring, without printing any real secret.
const previous = process.env.DEERHUX_TEST_SECRET;
process.env.DEERHUX_TEST_SECRET = "fixture-secret-only";
try {
  const script = `process.stdout.write(JSON.stringify({leaked:${JSON.stringify(secrets)}.filter(k=>process.env[k] === "fixture-secret-only"),ci:process.env.CI}))`;
  const command = `${JSON.stringify(process.execPath)} -e '${script}'`;
  const execute = async (worker: boolean) => {
    const bash = createStandardCodingTools(process.cwd(), worker ? { processEnv: environment } : undefined)
      .find((tool) => tool.name === "bash")!;
    const result = await bash.execute("worker-env-test", { command }, new AbortController().signal, undefined, undefined as never);
    return (result.details as { stdout: string }).stdout;
  };
  const worker = JSON.parse(await execute(true));
  assert.deepEqual(worker.leaked, []);
  assert.equal(worker.ci, "true");
  const main = JSON.parse(await execute(false));
  assert.ok(main.leaked.includes("DEERHUX_TEST_SECRET"), "main session retains its existing environment contract");
} finally {
  if (previous === undefined) delete process.env.DEERHUX_TEST_SECRET;
  else process.env.DEERHUX_TEST_SECRET = previous;
}
const composition = readFileSync(new URL("../lib/engine/deer-loop-composition.ts", import.meta.url), "utf8");
assert.match(composition, /options\.requestKind === "subagent" \? buildWorkerProcessEnvironment\(\) : undefined/);
console.log("worker process environment tests passed (allowlist, immutable snapshot, real bash, main-session compatibility)");
