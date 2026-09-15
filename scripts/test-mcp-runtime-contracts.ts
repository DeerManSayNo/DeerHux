import assert from "node:assert/strict";
import { DeferredMcpReload } from "../lib/mcp/deferred-reload.ts";
import { mapMcpToolResult } from "../lib/mcp/tool-result.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const gate = () => {
  let resolve!: (value: { ok: boolean; skipped?: boolean }) => void;
  const promise = new Promise<{ ok: boolean; skipped?: boolean }>(done => { resolve = done; });
  return { promise, resolve };
};
let ready = false;
let calls = 0;
const errors: unknown[] = [];
const queue = new DeferredMcpReload(() => ready, async () => { calls++; return { ok: true }; }, e => errors.push(e), 5);
assert.deepEqual(await queue.request(), { ok: false, skipped: true });
await queue.request();
await pause();
assert.equal(calls, 0);
ready = true;
await pause();
assert.equal(calls, 1, "busy saves coalesce");
await pause();
assert.equal(calls, 1);
queue.dispose();

const pending = gate();
let concurrentCalls = 0;
const concurrent = new DeferredMcpReload(() => true, async () => {
  concurrentCalls++;
  return concurrentCalls === 1 ? pending.promise : { ok: true };
}, e => errors.push(e), 5);
const first = concurrent.request();
await concurrent.request();
await pause();
assert.equal(concurrentCalls, 1, "no overlapping reloads");
pending.resolve({ ok: true });
await first;
await pause();
assert.equal(concurrentCalls, 2, "save during acquisition is not lost");
concurrent.dispose();

let raceCalls = 0;
const race = new DeferredMcpReload(() => true, async () => ({ ok: ++raceCalls > 1, skipped: raceCalls === 1 }), e => errors.push(e), 5);
await race.request();
await pause();
assert.equal(raceCalls, 2, "new turn winning acquisition is retried");
race.dispose();

ready = false;
const destroyed = new DeferredMcpReload(() => ready, async () => { throw new Error("must not run"); }, e => errors.push(e), 5);
await destroyed.request();
destroyed.dispose();
ready = true;
await pause();
assert.equal(errors.length, 0);

ready = false;
let failures = 0;
const failing = new DeferredMcpReload(() => ready, async () => { failures++; throw new Error("install failed"); }, e => errors.push(e), 5);
await failing.request();
ready = true;
await pause();
await pause();
assert.equal(failures, 1, "failure does not create an infinite retry loop");
assert.equal(errors.length, 1);
failing.dispose();

const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
assert.deepEqual(mapMcpToolResult({ content: [{ type: "text", text: "ok" }] }).content, [{ type: "text", text: "ok" }]);
const mixed = mapMcpToolResult({ isError: true, content: [{ type: "text", text: "denied" }, image] });
assert.equal(mixed.isError, true);
assert.deepEqual(mixed.content, [{ type: "text", text: "denied" }, image]);
assert.equal(mixed.bytes, 14);
assert.ok(mapMcpToolResult({ content: [image] }, false).content.every(x => x.type === "text"));
assert.ok(!JSON.stringify(mapMcpToolResult({ content: [image] }, false)).includes(image.data));
assert.match(JSON.stringify(mapMcpToolResult({ content: [{ ...image, data: "bad!" }] })), /invalid image/);
assert.match(JSON.stringify(mapMcpToolResult({ content: [{ ...image, data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] })), /budget exceeded/);
assert.equal(mapMcpToolResult({ isError: true, content: [] }).isError, true);
assert.deepEqual(mapMcpToolResult("plain").content, [{ type: "text", text: "plain" }]);
console.log("MCP reload and result contracts passed");
