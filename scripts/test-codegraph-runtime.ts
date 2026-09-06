import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveCodeGraphRuntime, runCodeGraph } from "../lib/codegraph/cli.ts";
import { createCodeGraphTools } from "../lib/codegraph/tools.ts";
import { ensureCodeGraphInitialized } from "../lib/codegraph/detect.ts";

const require = createRequire(import.meta.url);
const { bundleCodeGraph } = require("./bundle-codegraph.js");
const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-codegraph-runtime-"));
const standalone = path.join(scratch, "standalone app");
const project = path.join(scratch, "project with spaces");
const oldPath = process.env.PATH;
const oldWarn = console.warn;
try {
  assert.throws(() => bundleCodeGraph(root, standalone, "missing-platform"), /Missing.*optional dependency/);
  bundleCodeGraph(root, standalone);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "math.ts"), "export function sum(a: number, b: number) { return a + b; }\nexport function twice(a: number) { return sum(a, a); }\n");
  process.chdir(standalone);
  // No npm .bin links, global CLI, system node, or developer repo in PATH.
  process.env.PATH = "";
  assert.ok(resolveCodeGraphRuntime().command.startsWith(fs.realpathSync(standalone)));
  const tools = await createCodeGraphTools(project);
  assert.deepEqual(tools.map(t => t.name), ["codegraph"]);
  const signal = new AbortController().signal;
  const result = await tools[0].execute("search", { action: "search", query: "sum" }, signal, undefined, {} as never);
  assert.match(JSON.stringify(result), /math\.ts/);
  const callers = await tools[0].execute("callers", { action: "callers", symbol: "sum" }, signal, undefined, {} as never);
  assert.match(JSON.stringify(callers), /twice/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runCodeGraph(["status", "--json"], { cwd: project, signal: abort.signal }), { name: "AbortError" });
  const runtime = resolveCodeGraphRuntime();
  fs.renameSync(runtime.command, `${runtime.command}.missing`);
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  assert.equal(await ensureCodeGraphInitialized(project), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tool initialization.*CodeGraph runtime missing/);
  console.log("CodeGraph packaged runtime: indexing, registration, search, callers, cancellation, and missing-runtime diagnostics passed");
} finally {
  console.warn = oldWarn;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  process.chdir(root);
  fs.rmSync(scratch, { recursive: true, force: true });
}
