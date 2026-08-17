import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionAdapter } from "../lib/session/pi-session-adapter.ts";

const dir = mkdtempSync(path.join(tmpdir(), "deerhux-session-port-"));
try {
  const manager = SessionManager.create(dir, dir);
  const sourceFile = manager.getSessionFile();
  assert.ok(sourceFile);
  const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  const assistantId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const port = new PiSessionAdapter(manager);

  const emptyFork = port.fork(rootId);
  assert.ok(emptyFork);
  assert.notEqual(emptyFork.sessionId, port.id);
  const emptyHeader = JSON.parse(readFileSync(emptyFork.sessionFile, "utf8").split("\n")[0]);
  assert.equal(emptyHeader.parentSession, sourceFile);
  assert.deepEqual(SessionManager.open(emptyFork.sessionFile, dir).getEntries(), []);

  const historyFork = port.fork(assistantId);
  assert.ok(historyFork);
  assert.notEqual(historyFork.sessionId, port.id);
  const historyContext = SessionManager.open(historyFork.sessionFile, dir).buildSessionContext();
  assert.equal(historyContext.messages.length, 1);
  assert.equal(historyContext.messages[0]?.role, "user");

  const inMemory = new PiSessionAdapter(SessionManager.inMemory(dir));
  assert.equal(inMemory.fork("anything"), undefined);
  assert.throws(() => port.fork("missing"), /Session entry not found/);
  console.log("session fork port tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
