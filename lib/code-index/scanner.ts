import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { DEFAULT_IGNORES, IGNORED_EXTENSIONS, MAX_FILE_SIZE } from "./config";
import type { IndexedFile } from "./database";

export interface ScannedFile {
  path: string;
  absPath: string;
  mtime: number;
  ctime: number;
  size: number;
  hash: string;
  content: string;
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

async function readGitignore(cwd: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".gitignore"), "utf8");
    return raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#") && !l.startsWith("!"));
  } catch {
    return [];
  }
}

function matchesIgnore(rel: string, name: string, gitignore: string[]): boolean {
  if (DEFAULT_IGNORES.has(name)) return true;
  if (IGNORED_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  return gitignore.some(pattern => {
    const p = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!p) return false;
    if (p.includes("*")) {
      const escaped = p.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      const re = new RegExp(`^${escaped}$`);
      return re.test(rel) || re.test(name);
    }
    return rel === p || rel.startsWith(`${p}/`) || name === p;
  });
}

export async function scanFiles(cwd: string, previous = new Map<string, IndexedFile>()): Promise<ScannedFile[]> {
  const root = path.resolve(cwd);
  const gitignore = await readGitignore(root);
  const files: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const rel = path.relative(root, absPath).split(path.sep).join("/");
      if (matchesIgnore(rel, entry.name, gitignore)) continue;
      if (entry.isDirectory()) {
        try { await walk(absPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(absPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const cached = previous.get(rel);
        if (cached && cached.mtime === stat.mtimeMs && cached.ctime === stat.ctimeMs && cached.size === stat.size) {
          files.push({ ...cached, ctime: stat.ctimeMs, absPath });
          continue;
        }
        const buffer = await fs.readFile(absPath);
        if (isBinary(buffer)) continue;
        const content = buffer.toString("utf8");
        files.push({
          path: rel,
          absPath,
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
          size: stat.size,
          hash: crypto.createHash("sha256").update(buffer).digest("hex"),
          content,
        });
      } catch (error) {
        // Editors commonly replace files by rename while a scan is in progress.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  await walk(root);
  return files;
}
