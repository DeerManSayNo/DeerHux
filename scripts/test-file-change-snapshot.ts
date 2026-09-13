import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionAdapter } from "../lib/session/pi-session-adapter.ts";
import { buildSessionContext, cacheSessionPath, invalidateSessionFileCache, readSessionFileCached } from "../lib/session-reader.ts";
import { readRecentMessages } from "../lib/session/session-messages.ts";
import { createFileChangeSnapshot, FILE_CHANGE_SNAPSHOT_ENTRY, readFileChangeSnapshot } from "../lib/file-change-snapshot.ts";
import { createSessionHistorySnapshotStore } from "../lib/session-history-snapshots.ts";
import type { SessionEntry } from "../lib/types.ts";
import { GET } from "../app/api/sessions/[id]/route.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-file-snapshot-"));
try {
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "修改项目内外文件", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "完成" }], api: "anthropic-messages", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() });
  const port = new PiSessionAdapter(manager);
  const file = port.file!;
  const added = path.join(root, "new.txt");
  const edited = path.join(root, "edited.txt");
  const deleted = path.join(root, "deleted.txt");
  const files = [added, edited, deleted];
  const changes = files.map((filePath, index) => ({ filePath, beforeExists: index !== 0, afterExists: index !== 2 }));
  const snapshot = createFileChangeSnapshot("turn-1", files, changes, 123456);
  const snapshotEntry = port.appendCustomEntry(FILE_CHANGE_SNAPSHOT_ENTRY, snapshot)!;
  cacheSessionPath(port.id, file);

  // 原数组后续变化、文件真实状态变化，都不得改写本轮快照。
  files.push(path.join(root, "unrelated.txt"));
  changes[0].afterExists = false;
  fs.writeFileSync(added, "created then edited elsewhere");
  fs.writeFileSync(edited, "modified elsewhere");
  fs.writeFileSync(deleted, "recreated elsewhere");
  const sourceBeforeReads = fs.readFileSync(file, "utf8");
  assert.equal(snapshot.changedFiles.length, 3);
  assert.equal(snapshot.fileChanges[0].afterExists, true);

  // 清除服务器缓存并重新打开 JSONL，模拟窗口关闭、进程重启后的持久化读取。
  invalidateSessionFileCache(file);
  const fresh = readSessionFileCached(file);
  assert.deepEqual(fresh.context.fileChangeSnapshot, snapshot);
  assert.equal(fresh.context.messages.length, 2, "snapshot is metadata, not an extra chat message");
  assert.deepEqual(readRecentMessages(port.id, file, 1).fileChangeSnapshot, snapshot);
  const response = await GET(new Request(`http://localhost/api/sessions/${port.id}`), { params: Promise.resolve({ id: port.id }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).context.fileChangeSnapshot, snapshot);
  assert.equal(fs.readFileSync(file, "utf8"), sourceBeforeReads, "reading history must never rewrite the snapshot");

  // 浏览器缓存同样保存副本；不同会话分别恢复，淘汰后仍可从 JSONL 重建。
  const store = createSessionHistorySnapshotStore();
  store.set(port.id, { messages: fresh.context.messages, entryIds: fresh.context.entryIds, fullHistoryLoaded: true, hasOlderMessages: false, fileChangeSnapshot: snapshot });
  snapshot.changedFiles.push("/mutated-after-caching");
  assert.equal(store.get(port.id)?.fileChangeSnapshot?.changedFiles.length, 3);
  assert.equal(store.get("another-session"), null);
  store.clear();
  assert.equal(store.get(port.id), null);
  invalidateSessionFileCache(file);
  assert.equal(readSessionFileCached(file).context.fileChangeSnapshot?.changedFiles.length, 3);

  // 新回合清除旧显示；空终态必须原样恢复，不能回退到上一轮非空快照。
  manager.appendMessage({ role: "user", content: "这一轮没有改文件", timestamp: Date.now() });
  assert.equal(readSessionFileCached(file).context.fileChangeSnapshot, null);
  const empty = createFileChangeSnapshot("turn-2", [], [], 234567);
  const emptyEntry = port.appendCustomEntry(FILE_CHANGE_SNAPSHOT_ENTRY, empty)!;
  assert.deepEqual(readSessionFileCached(file).context.fileChangeSnapshot, empty);

  // 在同一历史树的旧分支读取时，只能恢复该分支的快照。
  const entries = manager.getEntries() as unknown as SessionEntry[];
  assert.equal(buildSessionContext(entries, snapshotEntry).fileChangeSnapshot?.turnId, "turn-1");
  assert.equal(buildSessionContext(entries, emptyEntry).fileChangeSnapshot?.turnId, "turn-2");
  assert.equal(buildSessionContext(entries, null).fileChangeSnapshot, null);
  const legacy = entries.filter((entry) => entry.type !== "custom" || entry.customType !== FILE_CHANGE_SNAPSHOT_ENTRY);
  assert.equal(buildSessionContext(legacy).fileChangeSnapshot, null, "legacy history has no invented snapshot");
  assert.equal(readFileChangeSnapshot({ ...empty, version: 2 }), null);
  console.log("file change snapshot persistence, branch and API tests passed");
} finally {
  invalidateSessionFileCache();
  fs.rmSync(root, { recursive: true, force: true });
}
