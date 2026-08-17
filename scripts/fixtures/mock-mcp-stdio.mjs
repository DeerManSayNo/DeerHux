#!/usr/bin/env node

const requestedMode = process.argv[2];
const mode = requestedMode === "content-length" || requestedMode === "content-length-split" || requestedMode === "content-length-burst"
  ? "content-length"
  : "newline";
const splitHeader = requestedMode === "content-length-split";
const burstFrames = requestedMode === "content-length-burst";
if (process.argv.includes("--ignore-term")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (mode === "newline") parseLines();
  else parseContentLength();
});

function parseLines() {
  while (true) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    buffer = buffer.subarray(newline + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* newline-only server ignores invalid frames */ }
  }
}

function parseContentLength() {
  while (true) {
    const text = buffer.toString("utf8");
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const headerBytes = Buffer.byteLength(text.slice(0, headerEnd + 4), "utf8");
    const match = /content-length:\s*(\d+)/i.exec(text.slice(0, headerEnd));
    if (!match) {
      buffer = buffer.subarray(headerBytes);
      continue;
    }
    const bodyBytes = Number(match[1]);
    if (buffer.length < headerBytes + bodyBytes) return;
    const body = buffer.subarray(headerBytes, headerBytes + bodyBytes).toString("utf8");
    buffer = buffer.subarray(headerBytes + bodyBytes);
    try { handle(JSON.parse(body)); } catch { /* ignore malformed JSON */ }
  }
}

function handle(message) {
  if (typeof message.id !== "number") return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: `mock-${mode}`, version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "echo", description: "中文 echo 🚀", inputSchema: { type: "object", properties: {} } }] }
      : message.method === "tools/call"
        ? { content: [{ type: "text", text: "ok" }] }
        : {};
  send({ jsonrpc: "2.0", id: message.id, result });
}

function frame(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function send(message) {
  const json = JSON.stringify(message);
  if (burstFrames && message.id === 1) {
    const padding = "x".repeat(40_000);
    const extras = [97, 98, 99].map((id) => frame({ jsonrpc: "2.0", id, result: { padding } })).join("");
    process.stdout.write(`${extras}${frame(message)}`);
    return;
  }
  if (mode === "newline") process.stdout.write(`${json}\n`);
  else {
    const encoded = frame(message);
    if (!splitHeader) process.stdout.write(encoded);
    else {
      process.stdout.write(encoded.slice(0, 4));
      setTimeout(() => process.stdout.write(encoded.slice(4)), 5);
    }
  }
}
