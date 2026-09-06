import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getIndexDir } from "./config";

export function cwdHash(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

export function getIndexPath(cwd: string): string {
  return path.join(getIndexDir(), `${cwdHash(cwd)}.json`);
}

export function ensureIndexDir(): void {
  fs.mkdirSync(getIndexDir(), { recursive: true });
}
