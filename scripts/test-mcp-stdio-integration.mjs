#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const port = Number(process.env.DEERHUX_MCP_TEST_PORT ?? 30142);
const baseUrl = `http://127.0.0.1:${port}`;
const nextBin = path.join(cwd, "node_modules", ".bin", "next");
const fixture = path.join(cwd, "scripts", "fixtures", "mock-mcp-stdio.mjs");
const child = spawn(nextBin, ["dev", "-p", String(port)], {
  cwd,
  env: { ...process.env, DEERHUX_MCP_FRAMING_PROBE_MS: "500", DEERHUX_MCP_MAX_INBOUND_BYTES: "65536" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let logs = "";
child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });
child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20_000); });

try {
  await waitForServer();
  const newline = await testServer("newline", "newline");
  const legacy = await testServer("legacy", "content-length");
  const splitLegacy = await testServer("split-legacy", "content-length-split");
  const burstLegacy = await testServer("burst-legacy", "content-length-burst");
  const stubborn = await testServer("stubborn", "newline", ["--ignore-term"]);
  if (newline.statuses?.[0]?.stdioFraming !== "newline") throw new Error(`newline failed: ${JSON.stringify(newline)}`);
  if (legacy.statuses?.[0]?.stdioFraming !== "content-length") throw new Error(`legacy failed: ${JSON.stringify(legacy)}`);
  if (splitLegacy.statuses?.[0]?.stdioFraming !== "content-length") throw new Error(`split legacy failed: ${JSON.stringify(splitLegacy)}`);
  if (burstLegacy.statuses?.[0]?.stdioFraming !== "content-length") throw new Error(`burst legacy failed: ${JSON.stringify(burstLegacy)}`);
  if (newline.toolCount !== 1 || legacy.toolCount !== 1 || splitLegacy.toolCount !== 1 || burstLegacy.toolCount !== 1 || stubborn.toolCount !== 1) throw new Error("mock tools were not discovered");
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const diagnostics = await getJson(`${baseUrl}/api/runtime/diagnostics`);
  if (diagnostics.mcp.activeProcesses !== 0) throw new Error(`MCP process leak: ${JSON.stringify(diagnostics.mcp)}`);
  if (diagnostics.mcp.initializeFallbacks < 1) throw new Error("legacy framing did not exercise fallback");
  if (diagnostics.mcp.forcedKills < 1) throw new Error("stubborn MCP server did not exercise SIGKILL escalation");
  if (diagnostics.mcp.abnormalExits !== 0) throw new Error(`expected shutdown counted as abnormal: ${diagnostics.mcp.abnormalExits}`);
  if (diagnostics.mcp.requestTimeouts !== 0) throw new Error(`probe polluted request timeouts: ${diagnostics.mcp.requestTimeouts}`);
  if (diagnostics.eventLoop.samples < 1) throw new Error("event-loop sampler produced no samples");
  console.log("MCP stdio integration tests passed");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  stopChild();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/runtime/diagnostics`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev server did not start on ${baseUrl}`);
}

async function testServer(id, mode, extraArgs = []) {
  const response = await fetch(`${baseUrl}/api/mcp-config/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      servers: [{
        id,
        name: id,
        enabled: true,
        transport: "stdio",
        stdioFraming: "auto",
        command: process.execPath,
        args: [fixture, mode, ...extraArgs],
      }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`MCP test HTTP ${response.status}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { child.kill("SIGTERM"); }
}
