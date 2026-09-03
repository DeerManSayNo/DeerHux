#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { parseArgs } = require("util");

const { values } = parseArgs({
  options: {
    node: { type: "string" },
    timeout: { type: "string", default: "60000" },
  },
});

const repoRoot = path.resolve(__dirname, "..");
const nodeBinary = path.resolve(values.node || process.execPath);
const launcher = path.join(repoRoot, "src-tauri", "resources", "deerhux-server.js");
const standaloneServer = path.join(repoRoot, ".next", "standalone", "server.js");
const timeoutMs = Number(values.timeout);

function assertInput() {
  if (!fs.existsSync(nodeBinary)) throw new Error(`Node binary not found: ${nodeBinary}`);
  if (!fs.existsSync(launcher)) throw new Error(`Desktop launcher not found: ${launcher}`);
  if (!fs.existsSync(standaloneServer)) {
    throw new Error(`Standalone build not found: ${standaloneServer}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid --timeout value");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Failed to reserve a local port"));
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill();
    }),
  ]);
}

async function main() {
  assertInput();
  const port = await reservePort();
  const child = spawn(nodeBinary, [launcher], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DEERHUX_RESOURCE_DIR: repoRoot,
      PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  const appendOutput = (chunk) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  const deadline = Date.now() + timeoutMs;
  let lastReadinessFailure = "";
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Standalone exited early (${child.exitCode})\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.text();
        if (response.ok) {
          const readiness = JSON.parse(body);
          if (response.headers.get("x-deerhux-ready") !== "1" || readiness.ready !== true) {
            throw new Error(`Invalid readiness response: ${body}`);
          }
          console.log(
            `Standalone readiness passed with ${path.basename(nodeBinary)} ` +
              `(Node v${readiness.nodeVersion}, ${readiness.modelCount} models)`,
          );
          return;
        }
        if (response.status === 503) lastReadinessFailure = body;
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
      }
      await delay(250);
    }
    throw new Error(
      `Standalone readiness timed out after ${timeoutMs}ms` +
        `${lastReadinessFailure ? `\nLast readiness failure: ${lastReadinessFailure}` : ""}\n${output}`,
    );
  } finally {
    await stopChild(child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
