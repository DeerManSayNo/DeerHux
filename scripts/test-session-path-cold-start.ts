import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-cold-path-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { resolveSessionPath } = await import("../lib/session-reader.ts");
const originalListAll = SessionManager.listAll;
let scans = 0;
const target = path.join(root, "target.jsonl");
const recovered = path.join(root, "recovered.jsonl");
SessionManager.listAll = async () => {
  scans++;
  return [{ id: "target", path: recovered, cwd: root, created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" }];
};
function cold() {
  globalThis.__deerhuxSessionPathCache = undefined;
  globalThis.__deerhuxSessionListCache = undefined;
  globalThis.__deerhuxSessionIndexCache = undefined;
}
try {
  await fs.writeFile(target, JSON.stringify({ type: "session", id: "target" }) + "\n");
  await fs.writeFile(path.join(root, "session-index.json"), JSON.stringify({
    version: 1, generatedAt: new Date(0).toISOString(), records: [{ id: "target", path: target }],
  }));
  cold();
  assert.equal(await resolveSessionPath("target"), target);
  assert.equal(scans, 0, "cold open must not scan all sessions, even with an old index");
  assert.equal(await resolveSessionPath("target"), target);
  assert.equal(scans, 0, "warm open reuses the path cache");

  cold();
  await fs.writeFile(target, JSON.stringify({ type: "session", id: "replaced" }) + "\n");
  assert.equal(await resolveSessionPath("target"), recovered);
  assert.equal(scans, 1, "a replaced file must fall back to the source scan");

  cold();
  await fs.unlink(target);
  assert.equal(await resolveSessionPath("target"), recovered);
  assert.equal(scans, 2, "a missing indexed file must fall back");

  cold();
  await fs.unlink(path.join(root, "session-index.json"));
  assert.equal(await resolveSessionPath("target"), recovered);
  assert.equal(scans, 3, "a missing index must retain the original lookup");

  cold();
  assert.equal(await resolveSessionPath("unknown"), null);
  assert.equal(scans, 4);

  cold();
  process.env.DEERHUX_SESSION_INDEX = "0";
  await fs.writeFile(target, JSON.stringify({ type: "session", id: "target" }) + "\n");
  await fs.writeFile(path.join(root, "session-index.json"), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), records: [{ id: "target", path: target }],
  }));
  assert.equal(await resolveSessionPath("target"), recovered);
  assert.equal(scans, 5, "the index rollback flag must still bypass the index");
  console.log("session cold-path tests passed: indexed lookup, warm cache, stale/missing targets, missing index, unknown ID, rollback");
} finally {
  SessionManager.listAll = originalListAll;
  await fs.rm(root, { recursive: true, force: true });
}
