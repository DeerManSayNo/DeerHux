const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
// An explicit directory allows measuring/validating a copy without touching dev output.
const standaloneDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, process.env.DEERHUX_BUILD_DIR || ".next", "standalone");

let removedBytes = 0;
let removedCount = 0;

function dirSize(p) {
  let total = 0;
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return stat.size;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      total += dirSize(path.join(p, entry.name));
    }
  } catch {}
  return total;
}

function remove(p) {
  if (!fs.existsSync(p)) return;
  const size = dirSize(p);
  fs.rmSync(p, { recursive: true, force: true });
  removedBytes += size;
  removedCount++;
}

console.log("Pruning standalone bundle...");

// ── 1. Build artifacts leaked into the Next.js trace ─────────────────────────
remove(path.join(standaloneDir, "src-tauri", "target"));

// ── 2. Unused runtime packages ──────────────────────────────────────────────
// sharp + @img/* ship the native libvips binaries (~16M). They are pulled in
// by Next.js as optionalDependencies for next/image optimization, which
// DeerHux never uses (no next/image components). Safe to drop — if Next ever
// tries to require sharp at runtime it falls back to the original image.
const nodeModules = path.join(standaloneDir, "node_modules");
remove(path.join(nodeModules, "sharp"));
remove(path.join(nodeModules, "@img"));

// caniuse-lite (~600 files) is browserslist compatibility data used only at
// build time (autoprefixer / JS transform targets). The standalone runtime
// never queries it. Verified by booting the pruned bundle and probing /,
// /file-preview, /api/sessions, /api/models, /api/skills — all 200. Removing
// it cuts Windows cold-start file I/O: every small file the process would
// touch is one more potential real-time antivirus scan.
remove(path.join(nodeModules, "caniuse-lite"));

// ── 3. Dev-only files across all nested node_modules ─────────────────────────
// These are never read at runtime by Node.js.
const stripExts = new Set([
  ".d.ts",
  ".js.map",
  ".cjs.map",
  ".mjs.map",
  ".css.map",
  ".flow",
]);
const stripNames = new Set([
  "README.md",
  "readme.md",
  "README",
  "readme",
  "CHANGELOG.md",
  "CHANGELOG",
  "HISTORY.md",
  "changelog.md",
  "LICENSE",
  "LICENSE.md",
  "licence",
  "LICENCE",
  "AUTHORS",
  "CONTRIBUTORS",
]);

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      // *.nft.json are build-time module traces Next uses to assemble the
      // standalone output (~20MB total). Nothing reads them at runtime.
      const isNftTrace = entry.name.endsWith(".nft.json");
      if (isNftTrace || [...stripExts].some((suffix) => entry.name.endsWith(suffix)) || stripNames.has(entry.name)) {
        remove(full);
      }
    } else if (entry.isDirectory()) {
      walk(full);
    }
  }
}

// Copy spawned dependencies before pruning so their maps/types are stripped too.
require("./bundle-codegraph.js").bundleCodeGraph(repoRoot, standaloneDir);

walk(standaloneDir);

console.log(
  `✅ Removed ${removedCount} items, freed ${(removedBytes / 1024 / 1024).toFixed(1)}MB ` +
    `from ${path.relative(repoRoot, standaloneDir)}`
);

// Built-in skills are read on demand; import tracing does not include Markdown.
for (const name of ["create-role", "create-skill", "webcmd-browser", "tavily-search", "create-scheduler"]) {
  const skillDir = path.join("lib", "builtin-skills", name);
  fs.cpSync(path.join(repoRoot, skillDir), path.join(standaloneDir, skillDir), { recursive: true });
}
