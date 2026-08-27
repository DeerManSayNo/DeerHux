const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const standaloneDir = path.join(repoRoot, ".next", "standalone");

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
      const ext = path.extname(entry.name);
      // *.nft.json are build-time module traces Next uses to assemble the
      // standalone output (~20MB total). Nothing reads them at runtime.
      const isNftTrace = entry.name.endsWith(".nft.json");
      if (isNftTrace || stripExts.has(ext) || stripNames.has(entry.name)) {
        remove(full);
      }
    } else if (entry.isDirectory()) {
      walk(full);
    }
  }
}

walk(standaloneDir);

console.log(
  `✅ Removed ${removedCount} items, freed ${(removedBytes / 1024 / 1024).toFixed(1)}MB ` +
    `from ${path.relative(repoRoot, standaloneDir)}`
);
