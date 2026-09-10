import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-remote-cold-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const originalListAll = SessionManager.listAll;
const { GET } = await import("../app/api/remote-connections/route.ts");
let scans = 0;
SessionManager.listAll = async () => { scans++; return []; };
try {
  const started = performance.now();
  const empty = await GET();
  console.log(`empty remote-connections cold request: ${(performance.now() - started).toFixed(1)}ms`);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).connections, []);
  assert.equal(scans, 0, "no bindings must not scan sessions, even without an index");

  await fs.mkdir(path.join(root, "wechat"), { recursive: true });
  await fs.writeFile(path.join(root, "wechat/user-sessions.json"), JSON.stringify({ user: "bound", missing: "missing" }));
  await fs.writeFile(path.join(root, "session-index.json"), JSON.stringify({
    version: 1, generatedAt: new Date(0).toISOString(), records: [{
      id: "bound", path: "/fixture/bound.jsonl", cwd: "/fixture", name: "Bound session",
      created: "2026-01-01", modified: "2026-01-01", messageCount: 3, firstMessage: "Hello",
      sizeBytes: 100, indexedAt: "2026-01-01",
    }],
  }));
  const indexed = await (await GET()).json();
  assert.equal(scans, 0, "bound sessions reuse the durable index after a restart");
  assert.equal(indexed.connections[0].session.id, "bound");
  assert.equal(indexed.connections[0].session.name, "Bound session");
  assert.equal(indexed.connections[1].session, null, "missing sessions remain visible as unlinked bindings");
  assert.equal(indexed.connections[0].session.sizeBytes, undefined, "index internals are not exposed");

  await fs.unlink(path.join(root, "session-index.json"));
  await GET();
  assert.equal(scans, 1, "bound sessions retain legacy fallback when no index exists");
  console.log("remote connections cold-start tests passed: empty bindings, indexed bindings, missing session and index fallback");
} finally {
  SessionManager.listAll = originalListAll;
  await fs.rm(root, { recursive: true, force: true });
}
