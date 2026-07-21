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

const pkgPath = path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

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
} catch (e) {
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
} catch (e) {
  try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort cleanup */ }
  fail("atomic write failed");
}

// Post-write verification
try {
  const verify = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (verify.piConfig?.name !== "deerhux" || verify.piConfig?.configDir !== ".deerhux") {
    fail("post-write verification failed: piConfig mismatch");
  }
} catch (e) {
  fail("post-write verification failed: cannot re-read");
}

console.log("[patch-deerhux-core] patched @earendil-works/pi-coding-agent piConfig -> deerhux/.deerhux");
