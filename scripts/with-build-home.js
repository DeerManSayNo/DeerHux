#!/usr/bin/env node
/**
 * Run build commands with an isolated HOME/USERPROFILE.
 *
 * Next's webpack trace can evaluate server-only modules during production builds.
 * On Windows, that may cause glob scans of protected user-profile junctions such
 * as "Application Data" or "Cookies". Keeping build-time home inside the repo
 * avoids those junctions without changing the packaged app's runtime home.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: node scripts/with-build-home.js <command> [...args]");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const buildHome = path.join(root, ".deerhux-build-home");
fs.mkdirSync(buildHome, { recursive: true });

const nodeOptions = process.env.NODE_OPTIONS || "";
const buildNodeOptions = nodeOptions.includes("--max-old-space-size")
  ? nodeOptions
  : `${nodeOptions} --max-old-space-size=8192`.trim();

const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    HOME: buildHome,
    USERPROFILE: buildHome,
    NODE_OPTIONS: buildNodeOptions,
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
