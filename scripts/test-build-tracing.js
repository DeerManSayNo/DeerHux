// Reproduce NFT's dynamic-skill glob against a tiny old-bundle fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
const picomatch = require("next/dist/compiled/picomatch");
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_BUILD } = require("next/constants");

async function main() {
  const config = await loadConfig(PHASE_PRODUCTION_BUILD, path.resolve(__dirname, ".."));
  class TraceEntryPointsPlugin { traceIgnores = []; }
  const tracer = new TraceEntryPointsPlugin();
  const webpack = { plugins: [tracer], cache: { type: "filesystem" } };
  config.webpack(webpack, { dev: false, isServer: true, nextRuntime: "nodejs" });
  assert.equal(webpack.cache.type, "filesystem", "keep persistent caching");
  assert.throws(() => config.webpack({ plugins: [] }, {
    dev: false, isServer: true, nextRuntime: "nodejs",
  }), /trace plugin changed/, "Next upgrades must not silently restore unbounded tracing");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-trace-regression-"));
  const originalLog = console.log;
  try {
    for (const dir of ["src-tauri/target/old-bundle/skill", "lib/builtin-skills/example"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "SKILL.md"), "fixture");
    }
    fs.writeFileSync(path.join(root, "entry.js"),
      'const fs=require("fs"),path=require("path"); fs.readFileSync(path.join(process.cwd(),process.argv[2],"SKILL.md"),"utf8");');
    let messages = [];
    console.log = (...args) => messages.push(args.join(" "));
    const options = { base: root, processCwd: root, log: true };
    const before = await nodeFileTrace([path.join(root, "entry.js")], options);
    assert([...before.fileList].some(file => file.includes("src-tauri/target")), "fixture must reproduce discovery of old bundles");
    assert(messages.some(message => message.includes("Globbing")));
    for (const ignores of [tracer.traceIgnores, config.outputFileTracingExcludes["next-server"]]) {
      messages = [];
      const after = await nodeFileTrace([path.join(root, "entry.js")], {
        ...options,
        ignore: picomatch(ignores, { contains: true, dot: true }),
      });
      assert(!messages.some(message => message.includes("Globbing")), "skip the glob itself in both tracing phases, not just its results");
      assert(![...after.fileList].some(file => file.endsWith("SKILL.md")));
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Build tracing regression passed: old skill bundles are not traversed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
