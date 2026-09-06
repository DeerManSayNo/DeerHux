import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { refreshIndex } from "../lib/code-index/indexer.ts";
import { readIndex } from "../lib/code-index/database.ts";
import { getIndexPath } from "../lib/code-index/paths.ts";
import { CodeIndexLifecycle } from "../lib/code-index/lifecycle.ts";
import { searchIndex } from "../lib/code-index/search.ts";
import { getIndexDir } from "../lib/code-index/config.ts";

// The index root must be correct even before Node instrumentation sets env.
const configuredDeerHux = process.env.DEERHUX_CODING_AGENT_DIR;
const configuredPi = process.env.PI_CODING_AGENT_DIR;
try {
  delete process.env.DEERHUX_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(getIndexDir(), path.join(os.homedir(), ".deerhux", "agent", "indexes"));
  process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "custom-pi-agent");
  assert.equal(getIndexDir(), path.join(process.env.PI_CODING_AGENT_DIR, "indexes"));
  process.env.DEERHUX_CODING_AGENT_DIR = "~/custom-deerhux-agent";
  assert.equal(getIndexDir(), path.join(os.homedir(), "custom-deerhux-agent", "indexes"));
} finally {
  if (configuredDeerHux === undefined) delete process.env.DEERHUX_CODING_AGENT_DIR;
  else process.env.DEERHUX_CODING_AGENT_DIR = configuredDeerHux;
  if (configuredPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = configuredPi;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-auto-index-"));
const waitFor = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 8_000;
  while (!await check()) {
    assert.ok(Date.now() < end, "background index did not converge");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
const service = new CodeIndexLifecycle({ debounceMs: 30, pollMs: 150, warmMs: 250 });
let notices = 0;
const leases: { release: () => void }[] = [];
try {
  await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 'INITIAL';\n");
  await fs.mkdir(path.join(root, ".codegraph"));
  await fs.writeFile(path.join(root, ".codegraph", "generated.txt"), "DO_NOT_INDEX");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await fs.mkdir(path.join(root, "ignored"));
  await fs.writeFile(path.join(root, "ignored", "secret.txt"), "DO_NOT_INDEX");
  assert.equal(await readIndex(root), null);
  const first = service.acquire(root, () => { notices++; });
  leases.push(first);
  await waitFor(async () => (await searchIndex(root, "INITIAL")).length === 1);
  assert.ok(notices > 0);
  assert.deepEqual((await searchIndex(root, "DO_NOT_INDEX")), []);
  const second = service.acquire(root);
  leases.push(second);
  first.release(); // One closing session must not stop another's watcher.
  const initial = await readIndex(root);
  const readFile = fs.readFile;
  let sourceReads = 0;
  fs.readFile = new Proxy(readFile, {
    apply(target, receiver, args) {
      if (String(args[0]).endsWith(".ts")) sourceReads++;
      return Reflect.apply(target, receiver, args);
    },
  });
  let unchanged;
  try { unchanged = await refreshIndex(root); } finally { fs.readFile = readFile; }
  assert.equal(sourceReads, 0, "unchanged source files must not be reread");
  assert.equal(unchanged.changedCount, 0);
  assert.equal(unchanged.updatedAt, initial!.updatedAt);
  const scan1 = refreshIndex(root);
  assert.equal(refreshIndex(root), scan1, "concurrent refresh requests must share a scan");
  await scan1;
  await fs.writeFile(path.join(root, "keep.ts"), "export const keep = 'UPDATED';\n");
  await fs.writeFile(path.join(root, "new.ts"), "export const value = 'ADDED';\n");
  await waitFor(async () => (await searchIndex(root, "UPDATED")).length === 1 && (await searchIndex(root, "ADDED")).length === 1);
  await fs.rename(path.join(root, "new.ts"), path.join(root, "renamed.ts"));
  await fs.unlink(path.join(root, "keep.ts"));
  await waitFor(async () => {
    const index = await readIndex(root);
    return Boolean(index?.files.some(f => f.path === "renamed.ts") && !index.files.some(f => ["new.ts", "keep.ts"].includes(f.path)));
  });
  // Readers never see partial JSON during writes.
  await Promise.all(Array.from({ length: 30 }, async () => { assert.ok(await readIndex(root)); }));
  second.release();
  await new Promise(resolve => setTimeout(resolve, 250));
  const stopped = (await readIndex(root))!.updatedAt;
  await fs.writeFile(path.join(root, "renamed.ts"), "AFTER_RELEASE");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await readIndex(root))!.updatedAt, stopped);
  service.touch(root); // UI-only project opening builds/refreshes without a session.
  await waitFor(async () => (await searchIndex(root, "AFTER_RELEASE")).length === 1);
  await new Promise(resolve => setTimeout(resolve, 350));
  console.log("code-index lifecycle: creation, coalescing, incremental refresh, add/rename/delete, ignores, release and UI lease passed");
} finally {
  for (const lease of leases) lease.release();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(getIndexPath(root), { force: true });
}
