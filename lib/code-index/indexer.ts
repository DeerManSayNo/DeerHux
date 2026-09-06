import path from "path";
import { readIndex, writeIndex } from "./database";
import { scanFiles } from "./scanner";

type RefreshResult = { fileCount: number; changedCount: number; updatedAt: string };
declare global {
  var __deerhuxCodeIndexRefreshes: Map<string, Promise<RefreshResult>> | undefined;
}

export function refreshIndex(cwd: string): Promise<RefreshResult> {
  const root = path.resolve(cwd);
  const pending = globalThis.__deerhuxCodeIndexRefreshes ??= new Map();
  const existing = pending.get(root);
  if (existing) return existing;
  const work = updateIndex(root).finally(() => { pending.delete(root); });
  pending.set(root, work);
  return work;
}

async function updateIndex(cwd: string): Promise<RefreshResult> {
  const root = path.resolve(cwd);
  const previous = await readIndex(root);
  const previousByPath = new Map((previous?.files ?? []).map(file => [file.path, file]));
  const scanned = await scanFiles(root, previousByPath);
  let changedCount = 0;

  const files = scanned.map(file => {
    const prev = previousByPath.get(file.path);
    if (!prev || prev.mtime !== file.mtime || prev.ctime !== file.ctime || prev.size !== file.size || prev.hash !== file.hash) changedCount += 1;
    return { path: file.path, mtime: file.mtime, ctime: file.ctime, size: file.size, hash: file.hash, content: file.content };
  });

  const scannedPaths = new Set(files.map(file => file.path));
  for (const prev of previous?.files ?? []) {
    if (!scannedPaths.has(prev.path)) changedCount += 1;
  }

  if (previous && changedCount === 0) return { fileCount: files.length, changedCount, updatedAt: previous.updatedAt };
  const updatedAt = new Date().toISOString();
  await writeIndex({ version: 1, cwd: root, updatedAt, files });
  return { fileCount: files.length, changedCount, updatedAt };
}
