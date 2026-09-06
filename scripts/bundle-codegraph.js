const fs = require("node:fs");
const path = require("node:path");

function buildTarget() {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (!triple) return `${process.platform}-${process.arch}`;
  const platform = triple.includes("windows") ? "win32" : triple.includes("apple-darwin") ? "darwin" : triple.includes("linux") ? "linux" : null;
  const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : null;
  if (!platform || !arch) throw new Error(`Unsupported CodeGraph target: ${triple}`);
  return `${platform}-${arch}`;
}

// CodeGraph is spawned, so Next's import tracing cannot discover this package.
// Preserve the complete self-contained platform bundle (runtime, SQLite,
// tree-sitter grammars, nested dependencies) instead of relying on .bin links.
function bundleCodeGraph(repoRoot, standaloneDir, target = buildTarget()) {
  const scope = path.join("node_modules", "@colbymchenry");
  const name = `codegraph-${target}`;
  const source = path.join(repoRoot, scope, name);
  const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, scope, "codegraph", "package.json"), "utf8"));
  const manifestPath = path.join(source, "package.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing @colbymchenry/${name}. Install the CodeGraph optional dependency for ${target} before packaging.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== meta.optionalDependencies?.[`@colbymchenry/${name}`]) {
    throw new Error(`CodeGraph platform version mismatch: ${manifest.version}`);
  }
  for (const relative of [target.startsWith("win32-") ? "node.exe" : "node", "lib/dist/bin/codegraph.js"]) {
    if (!fs.existsSync(path.join(source, relative))) throw new Error(`Incomplete CodeGraph bundle: ${relative}`);
  }
  const destination = path.join(standaloneDir, scope, name);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
  console.log(`Bundled CodeGraph ${manifest.version} (${target})`);
  return destination;
}

module.exports = { bundleCodeGraph, buildTarget };
