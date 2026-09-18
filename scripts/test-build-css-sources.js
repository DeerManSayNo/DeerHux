// Check the actual PostCSS dependency messages consumed by Next's loader.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");

async function main() {
  const root = path.resolve(__dirname, "..");
  const file = path.join(root, "app/globals.css");
  const result = await postcss([tailwind({ base: root })]).process(fs.readFileSync(file, "utf8"), { from: file });
  const allowed = ["app", "components", "hooks", "lib"];
  const dirs = result.messages.filter(message => message.type === "dir-dependency")
    .map(message => path.relative(root, message.dir).replaceAll(path.sep, "/"));
  for (const dir of dirs) {
    assert(allowed.some(base => dir === base || dir.startsWith(`${base}/`)),
      `Unbounded webpack directory snapshot: ${dir || "repository root"}`);
  }
  for (const base of allowed) assert(dirs.includes(base), `Missing UI source: ${base}`);
  console.log(`CSS source boundaries verified: ${dirs.length} directories, all within UI source.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
