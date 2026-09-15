import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = await fs.mkdtemp(path.resolve(".rename-test-"));
process.env.DEERHUX_CODING_AGENT_DIR = root;
process.env.PI_CODING_AGENT_DIR = root;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { cacheSessionPath } = await import("../lib/session-reader.ts");
const { listSessionsFromIndex, forceRebuildSessionIndex } = await import("../lib/session/session-index.ts");
const { PATCH } = await import("../app/api/sessions/[id]/route.ts");
const id = "rename-regression";
const dir = path.join(root, "sessions", "test");
const file = path.join(dir, "test.jsonl");
try {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date().toISOString() }) + "\n");
  cacheSessionPath(id, file);
  await forceRebuildSessionIndex("test-seed");
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  SessionManager.listAll = async (...args) => {
    scans++;
    return originalListAll.apply(SessionManager, args);
  };
  for (const name of ["Updated title", "Second title", ""]) {
    const response = await PATCH(new Request("http://localhost/api/sessions/" + id, {
      method: "PATCH", body: JSON.stringify({ name }),
      headers: { "Content-Type": "application/json" },
    }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    assert.equal(SessionManager.open(file).getSessionName(), name || undefined);
    const list = await listSessionsFromIndex();
    assert.equal(list.sessions.find((session) => session.id === id)?.name, name || undefined);
  }
  assert.equal(scans, 0, "renaming must not scan all session histories");
  SessionManager.listAll = originalListAll;
  console.log("session rename passed: persistence, repeated rename, clear name, immediate index read, no full scan");
} finally {
  // Allow the invalidation debounce to finish before removing its isolated directory.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await fs.rm(root, { recursive: true, force: true });
}
