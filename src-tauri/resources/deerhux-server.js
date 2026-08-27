#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const resourceDir = process.env.DEERHUX_RESOURCE_DIR;
const port = process.env.PORT || "30141";
if (!resourceDir) {
  console.error("DEERHUX_RESOURCE_DIR is not set");
  process.exit(1);
}

// Set env before requiring server.js so it picks up correct config
process.env.HOSTNAME = "127.0.0.1";
process.env.NODE_ENV = "production";
process.env.PORT = port;

// Point agent data to DeerHux directory
const home = process.env.HOME || require("os").homedir();
const deerhuxAgentDir = require("path").join(home, ".deerhux", "agent");
if (!process.env.DEERHUX_CODING_AGENT_DIR) {
  process.env.DEERHUX_CODING_AGENT_DIR = deerhuxAgentDir;
}
// Backward-compatible fallback for unpatched @earendil-works/pi-coding-agent builds.
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = deerhuxAgentDir;
}

// Enable the V8 compile cache so every launch after the first skips parsing
// and compiling ~25MB of bundled JS (Node >= 22.8). The desktop host also sets
// NODE_COMPILE_CACHE before spawn; this call covers the same directory when
// the launcher is started without it (e.g. manual runs). Harmless no-op on
// older Node.
try {
  const cacheDir =
    process.env.NODE_COMPILE_CACHE || path.join(home, ".deerhux", "node-compile-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  require("module").enableCompileCache?.(cacheDir);
} catch {}

// Graceful shutdown: the desktop host holds our stdin pipe and closes it when
// the app quits. Windows offers no deliverable signal to child processes
// (TerminateProcess skips exit hooks), so stdin EOF is the only way to reach
// a normal process.exit(0) — which is also when Node flushes the compile
// cache above to disk. If stdin is absent (manual runs), this is a no-op.
try {
  if (process.stdin && !process.stdin.isTTY) {
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => {});
  }
} catch {}

const bundledStandaloneDir = path.join(resourceDir, "app", "standalone");
const standaloneDir = fs.existsSync(path.join(bundledStandaloneDir, "server.js"))
  ? bundledStandaloneDir
  : path.join(resourceDir, ".next", "standalone");

process.chdir(standaloneDir);
require(path.join(standaloneDir, "server.js"));
