import assert from "node:assert/strict";
import { PiSessionAdapter } from "../lib/session/pi-session-adapter.ts";

const calls: string[] = [];
const entries = new Map<string, unknown>([
  ["entry-1", {
    id: "entry-1",
    type: "message",
    parentId: "parent-1",
    message: { role: "user", content: [{ type: "text", text: "edit me" }] },
  }],
  ["root-user", {
    id: "root-user",
    type: "message",
    parentId: null,
    message: { role: "user", content: "root text" },
  }],
]);
const manager = {
  getSessionId: () => "session-1",
  getSessionFile: () => "/tmp/session-1.jsonl",
  getCwd: () => "/tmp/project",
  isPersisted: () => true,
  getLeafId: () => "current-leaf",
  appendModelChange: (provider: string, modelId: string) => {
    calls.push(`model:${provider}/${modelId}`);
    return "model-entry";
  },
  appendThinkingLevelChange: (level: string) => {
    calls.push(`thinking:${level}`);
    return "thinking-entry";
  },
  appendCustomEntry: (type: string) => {
    calls.push(`custom:${type}`);
    return "custom-entry";
  },
  getEntries: () => [
    { id: "custom-1", type: "custom", customType: "metadata", data: { value: 1 } },
    { id: "custom-2", type: "custom", customType: "other", data: { value: 2 } },
  ],
  getEntry: (id: string) => entries.get(id),
  branch: (id: string) => { calls.push(`branch:${id}`); },
  resetLeaf: () => { calls.push("reset"); },
  buildSessionContext: () => ({
    messages: [{ role: "user", content: "restored" }],
    model: { provider: "provider", modelId: "model" },
    thinkingLevel: "high",
  }),
};
const port = new PiSessionAdapter(manager as never);

assert.equal(port.id, "session-1");
assert.equal(port.file, "/tmp/session-1.jsonl");
assert.equal(port.cwd, "/tmp/project");
assert.equal(port.persisted, true);
assert.equal(port.leafId, "current-leaf");
assert.equal(port.appendModelChange("p", "m"), "model-entry");
assert.equal(port.appendThinkingLevelChange("high"), "thinking-entry");
assert.equal(port.appendCustomEntry("metadata", {}), "custom-entry");
assert.deepEqual(port.getCustomEntries("metadata"), [
  { id: "custom-1", data: { value: 1 } },
]);

const branchSnapshot = port.navigate("entry-1");
assert.deepEqual(calls, ["model:p/m", "thinking:high", "custom:metadata", "branch:parent-1"]);
assert.equal(branchSnapshot.messages[0]?.role, "user");
assert.deepEqual(branchSnapshot.model, { provider: "provider", modelId: "model" });
assert.equal(branchSnapshot.thinkingLevel, "high");
assert.equal(branchSnapshot.editorText, "edit me");

const rootSnapshot = port.navigate("root-user");
assert.equal(calls.at(-1), "reset");
assert.equal(rootSnapshot.editorText, "root text");
port.navigate(null);
assert.equal(calls.at(-1), "reset");
assert.throws(() => port.navigate("missing"), /Session entry not found/);

// ── 关键写入失败必须抛 SessionPersistenceError（不可静默吞掉）──────────
const { SessionPersistenceError } = await import("../lib/session/errors.ts");
const failing = new PiSessionAdapter({
  ...manager,
  appendModelChange: () => { throw new Error("EACCES: disk full"); },
} as never);
assert.throws(
  () => failing.appendModelChange("p", "m"),
  (error: unknown) => error instanceof SessionPersistenceError
    && error.operation === "append_model_change"
    && error.sessionId === "session-1"
    && error.code === "SESSION_PERSIST_FAILED"
    && /disk full/.test(error.message),
);

console.log("session port tests passed");
