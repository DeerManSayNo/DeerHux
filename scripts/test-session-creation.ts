import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionCreationStore, findPromptReceipt } from "../lib/session/creation-store.ts";
import { PiSessionAdapter } from "../lib/session/pi-session-adapter.ts";

if (process.argv[2] === "--creation-worker") {
  const [directory, project, mode] = process.argv.slice(3);
  const workerStore = new SessionCreationStore(directory);
  await workerStore.withRequest(project, "v2_process_shared", AbortSignal.timeout(10_000), async () => {
    const record = await workerStore.prepare(project, "v2_process_shared", () => {
      const manager = SessionManager.create(project, join(directory, "sessions"));
      return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, header: manager.getHeader()! };
    }, async () => { throw new Error("new requests cannot scan history"); });
    if (mode === "crash") process.exit(0);
    if (!await findPromptReceipt(record.sessionFile, "v2_process_shared")) {
      const adapter = new PiSessionAdapter(SessionManager.open(record.sessionFile));
      adapter.appendCustomEntry("display_user_message", { clientMessageId: "v2_process_shared", turnId: "once" });
    }
    console.log(JSON.stringify(record));
  });
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "deerhux-creation-test-"));
const cwd = join(root, "project");
const directory = join(root, "creations");
const store = new SessionCreationStore(directory);
const signal = AbortSignal.timeout(30_000);
let allocations = 0;
let legacyScans = 0;
const allocate = () => {
  allocations++;
  const manager = SessionManager.create(cwd, join(root, "sessions"));
  return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!, header: manager.getHeader()! };
};
const legacy = async () => { legacyScans++; return undefined; };
const prepare = (id: string, instance = store) => instance.withRequest(cwd, id, signal, () => instance.prepare(cwd, id, allocate, legacy));
try {
  const worker = (mode: string) => new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--creation-worker", join(root, "cross-process"), cwd, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? done(stdout) : reject(new Error(stderr)));
  });
  await worker("crash");
  const processes = await Promise.all([worker("resume"), worker("resume")]);
  const processRecords = processes.map((output) => JSON.parse(output.trim()));
  assert.equal(processRecords[0].sessionId, processRecords[1].sessionId);
  assert.equal(new PiSessionAdapter(SessionManager.open(processRecords[0].sessionFile)).getCustomEntries("display_user_message").length, 1);

  const records = await Promise.all(Array.from({ length: 8 }, () => prepare("v2_concurrent")));
  assert.equal(new Set(records.map((item) => item.sessionId)).size, 1);
  assert.equal(allocations, 1);
  assert.equal(legacyScans, 0);
  const restarted = await prepare("v2_concurrent", new SessionCreationStore(directory));
  assert.equal(restarted.sessionId, records[0].sessionId);
  assert.equal(allocations, 1);

  // Crash between mapping reservation and JSONL initialization uses the same ID.
  const recordFile = readdirSync(directory).find((name) => name.endsWith(".json"))!;
  writeFileSync(join(directory, recordFile), JSON.stringify({ ...restarted, initialized: false }));
  unlinkSync(restarted.sessionFile);
  const recovered = await prepare("v2_concurrent");
  assert.equal(recovered.sessionId, restarted.sessionId);
  assert.ok(existsSync(recovered.sessionFile));
  assert.equal(allocations, 1);

  // Receipts reach disk before the first assistant response, survive reopening,
  // and appending that response does not duplicate headers or earlier entries.
  const manager = SessionManager.open(recovered.sessionFile);
  const adapter = new PiSessionAdapter(manager);
  adapter.appendModelChange("test", "fixture");
  adapter.appendCustomEntry("display_user_message", { content: "你好", clientMessageId: "v2_concurrent", turnId: "turn_1" });
  assert.deepEqual(await findPromptReceipt(recovered.sessionFile, "v2_concurrent"), { turnId: "turn_1" });
  const reopened = new PiSessionAdapter(SessionManager.open(recovered.sessionFile));
  assert.equal(reopened.getCustomEntries("display_user_message").length, 1);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], api: "openai-responses", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const lines = readFileSync(recovered.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.type === "session").length, 1);
  assert.equal(lines.filter((line) => line.customType === "display_user_message").length, 1);

  // A >50 MB single-line image payload remains bounded and cannot block new IDs.
  const huge = join(root, "legacy.jsonl");
  writeFileSync(huge, JSON.stringify({ type: "session", id: "legacy", cwd }) + '\n{"type":"custom","customType":"display_user_message","data":{"content":"');
  for (let i = 0; i < 54; i++) appendFileSync(huge, "x".repeat(1024 * 1024));
  appendFileSync(huge, '","clientMessageId":"client_legacy","turnId":"legacy:t1"},"id":"entry"}\n');
  assert.deepEqual(await findPromptReceipt(huge, "client_legacy"), { turnId: "legacy:t1" });
  assert.equal(await findPromptReceipt(huge, "unrelated"), null);
  const before = legacyScans;
  await prepare("v2_with_large_history");
  assert.equal(legacyScans, before);
  const old = await store.withRequest(cwd, "client_legacy", signal, () => store.prepare(cwd, "client_legacy", allocate, async () => {
    assert.ok(await findPromptReceipt(huge, "client_legacy"));
    return { sessionId: "legacy", sessionFile: huge };
  }));
  assert.equal(old.sessionId, "legacy");
  await store.withRequest(cwd, "client_legacy", signal, () => store.prepare(cwd, "client_legacy", allocate, async () => { throw new Error("must not rescan"); }));

  // Missing mapped sessions and corrupt state fail closed, never allocate again.
  const count = allocations;
  unlinkSync(recovered.sessionFile);
  await assert.rejects(prepare("v2_concurrent"), /文件已丢失/);
  writeFileSync(join(directory, recordFile), "{broken");
  await assert.rejects(prepare("v2_concurrent"), /记录损坏/);
  assert.equal(allocations, count);
  const blocked = new SessionCreationStore(join(root, "not-a-directory"));
  writeFileSync(join(root, "not-a-directory"), "blocked");
  await assert.rejects(prepare("v2_disk_failure", blocked));
  assert.equal(allocations, count);

  // Failed admission persistence must not appear accepted from the in-memory entry.
  const brokenManager = SessionManager.create(cwd, join(root, "failure-sessions"));
  const brokenAdapter = new PiSessionAdapter(brokenManager);
  rmSync(join(root, "failure-sessions"), { recursive: true });
  assert.throws(() => brokenAdapter.appendCustomEntry("display_user_message", { clientMessageId: "failed" }), /persistence failed/);
  assert.throws(() => brokenAdapter.getCustomEntries("display_user_message"), /persistence failed/);
  console.log("session creation passed: concurrent/restart reservation, durable pre-model receipts, >50 MB legacy streaming, no history scan for new IDs, missing/corrupt/disk failure guards");
} finally {
  rmSync(root, { recursive: true, force: true });
}
