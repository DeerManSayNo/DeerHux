#!/usr/bin/env node
/*
 * Patch @earendil-works/pi-coding-agent so DeerHux uses DeerHux config paths:
 * - global agent dir: ~/.deerhux/agent
 * - project config dir: .deerhux
 *
 * This is needed because the upstream package defaults to the legacy config paths.
 *
 * Reliability hardening:
 * - Atomic write (temp file + rename) to avoid truncated package.json on interrupt
 * - Post-write verification: re-reads and asserts piConfig values
 * - Generic error messages (no sensitive data leakage)
 */
const fs = require("fs");
const path = require("path");

const nodeModulesRoot = path.join(__dirname, "..", "node_modules", "@earendil-works");
const pkgPath = path.join(nodeModulesRoot, "pi-coding-agent", "package.json");

if (!fs.existsSync(pkgPath)) {
  console.warn("[patch-deerhux-core] package not found:", pkgPath);
  process.exit(0);
}

function fail(msg) {
  console.error("[patch-deerhux-core] FAILED:", msg);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (_error) {
  fail("cannot parse target package.json");
}

pkg.piConfig = {
  ...(pkg.piConfig || {}),
  name: "deerhux",
  configDir: ".deerhux",
};

// Atomic write: temp file in same dir, then rename
const tmpPath = pkgPath + "." + process.pid + "." + Date.now() + ".tmp";
try {
  fs.writeFileSync(tmpPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, pkgPath);
} catch (_error) {
  try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort cleanup */ }
  fail("atomic write failed");
}

// Post-write verification
try {
  const verify = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (verify.piConfig?.name !== "deerhux" || verify.piConfig?.configDir !== ".deerhux") {
    fail("post-write verification failed: piConfig mismatch");
  }
} catch (_error) {
  fail("post-write verification failed: cannot re-read");
}

console.log("[patch-deerhux-core] patched @earendil-works/pi-coding-agent piConfig -> deerhux/.deerhux");

// pi-ai <= 0.75.x drops Responses API output_tokens_details.reasoning_tokens.
// Newer pi-ai releases preserve it as Usage.reasoning; keep the patch idempotent
// so upgrading to a release with native support becomes a no-op.
const piAiRoot = path.join(nodeModulesRoot, "pi-ai", "dist");
const responsesCandidates = [
  path.join(piAiRoot, "providers", "openai-responses-shared.js"),
  path.join(piAiRoot, "api", "openai-responses-shared.js"),
];
const responsesPath = responsesCandidates.find((candidate) => fs.existsSync(candidate));
const typesPath = path.join(piAiRoot, "types.d.ts");

if (!responsesPath || !fs.existsSync(typesPath)) {
  fail("cannot find pi-ai Responses runtime or type declarations");
}

function patchTextFile(filePath, patchName, transform, verify) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    fail(`cannot read ${patchName}`);
  }

  const updated = transform(source);
  if (!verify(updated)) {
    fail(`${patchName} verification failed`);
  }
  if (updated === source) return false;

  const tempPath = filePath + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    fs.writeFileSync(tempPath, updated, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (_) {
    try { fs.unlinkSync(tempPath); } catch (_) { /* best effort cleanup */ }
    fail(`cannot write ${patchName}`);
  }
  return true;
}

const reasoningRuntimeNeedle = "reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,";
patchTextFile(
  responsesPath,
  "pi-ai Responses reasoning usage runtime",
  (source) => {
    if (source.includes(reasoningRuntimeNeedle)) return source;
    const anchor = "output: response.usage.output_tokens || 0,\n                    cacheRead:";
    if (!source.includes(anchor)) return source;
    return source.replace(
      anchor,
      `output: response.usage.output_tokens || 0,\n                    ${reasoningRuntimeNeedle}\n                    cacheRead:`,
    );
  },
  (source) => source.includes(reasoningRuntimeNeedle),
);

patchTextFile(
  typesPath,
  "pi-ai Usage.reasoning declaration",
  (source) => {
    if (/\breasoning\?: number;/.test(source)) return source;
    const anchor = "    output: number;\n    cacheRead: number;";
    if (!source.includes(anchor)) return source;
    return source.replace(
      anchor,
      "    output: number;\n    /** Reasoning tokens reported by the provider; already included in output. */\n    reasoning?: number;\n    cacheRead: number;",
    );
  },
  (source) => /\breasoning\?: number;/.test(source),
);

console.log("[patch-deerhux-core] ensured pi-ai Responses reasoning token usage support");
