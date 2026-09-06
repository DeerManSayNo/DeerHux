import path from "path";
import os from "os";

// Resolve after runtime initialization; eager imports may precede DeerHux's
// agent-directory setup (particularly during development hot reload).
export function getIndexDir(): string {
  const configured = process.env.DEERHUX_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  const root = configured
    ? configured.replace(/^~(?=$|[\\/])/, os.homedir())
    : path.join(os.homedir(), ".deerhux", "agent");
  return path.join(root, "indexes");
}
export const MAX_FILE_SIZE = 512 * 1024;
export const SNIPPET_CONTEXT_LINES = 3;
export const DEFAULT_SEARCH_LIMIT = 20;

export const DEFAULT_IGNORES = new Set([
  ".git",
  ".codegraph",
  ".deerhux",
  "node_modules",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
]);

export const IGNORED_EXTENSIONS = new Set([
  ".lock",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".gz", ".tgz", ".rar", ".7z",
  ".mp3", ".mp4", ".mov", ".avi",
  ".wasm", ".bin", ".exe", ".dll", ".dylib", ".so",
]);
