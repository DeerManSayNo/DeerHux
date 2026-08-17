import assert from "node:assert/strict";
import {
  detectMcpResponseFraming,
  encodeMcpMessage,
  selectFramingAttempts,
} from "../lib/mcp/stdio-framing.ts";

const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { name: "测试" } };
const json = JSON.stringify(request);
assert.equal(encodeMcpMessage(request, "line"), `${json}\n`);
assert.equal(
  encodeMcpMessage(request, "cl"),
  `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
);
assert.deepEqual(selectFramingAttempts("auto"), ["line", "cl"]);
assert.deepEqual(selectFramingAttempts("auto", "cl"), ["cl", "line"]);
assert.deepEqual(selectFramingAttempts("auto", "line"), ["line", "cl"]);
assert.deepEqual(selectFramingAttempts("newline", "cl"), ["line"]);
assert.deepEqual(selectFramingAttempts("content-length", "line"), ["cl"]);
assert.equal(detectMcpResponseFraming("Cont"), null);
assert.equal(detectMcpResponseFraming("Content-Length"), null);
assert.equal(detectMcpResponseFraming('{"jsonrpc":"2.0"}\n'), "line");
assert.equal(detectMcpResponseFraming("Content-Length: 2\r\n\r\n{}"), "cl");
assert.equal(detectMcpResponseFraming("content-length: 2\r\n\r\n{}"), "cl");
console.log("MCP stdio framing tests passed");
