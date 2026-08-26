import fs from "fs";
import os from "os";
import path from "path";

const ALLOWED_ROOTS_TTL_MS = 30_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

declare global {
  var __deerhuxAllowedRootsCache: {
    roots: Set<string>;
    expiresAt: number;
    inflight?: Promise<Set<string>>;
  } | undefined;
  var __deerhuxAllowedExtraRoots: Set<string> | undefined;
}

const LEGACY_DEFAULT_CWD_RE = /^(?:deerhux-cwd|pi-cwd)(?:-\d{8})?$/;

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

function normalizeRoot(root: string): string {
  const useWindowsRules = isWindowsAbsolutePath(root);
  const resolver = useWindowsRules ? path.win32 : path;
  const resolved = resolver.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

export function addAllowedRoot(root: string | null | undefined): void {
  if (!root) return;
  const normalized = normalizeRoot(root);
  if (!globalThis.__deerhuxAllowedExtraRoots) globalThis.__deerhuxAllowedExtraRoots = new Set();
  globalThis.__deerhuxAllowedExtraRoots.add(normalized);
  globalThis.__deerhuxAllowedRootsCache?.roots.add(normalized);
}

async function buildAllowedRoots(fresh = false): Promise<Set<string>> {
  const { listAllSessions } = await import("@/lib/session-reader");
  // Reuse the session reader's stale-while-revalidate cache. A forced scan here
  // makes every file-tree request walk all session JSONL files before it can
  // even read the requested directory. Callers can explicitly request a fresh
  // rebuild after an access miss when they need to discover a just-added root.
  const sessions = await listAllSessions(fresh);
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeRoot(s.cwd));
  }

  for (const root of globalThis.__deerhuxAllowedExtraRoots ?? []) {
    roots.add(normalizeRoot(root));
  }

  try {
    const home = os.homedir();
    // Skip scanning home on Windows to avoid EPERM on junction points
    if (process.platform === "win32") {
      for (const name of ["deerhux-cwd", "pi-cwd"]) {
        roots.add(normalizeRoot(path.join(home, name)));
      }
    } else {
      for (const name of fs.readdirSync(home)) {
        if (LEGACY_DEFAULT_CWD_RE.test(name)) {
          roots.add(normalizeRoot(path.join(home, name)));
        }
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  return roots;
}

export async function getAllowedRoots(fresh = false): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__deerhuxAllowedRootsCache;
  if (!fresh && cached && cached.expiresAt > now) return cached.roots;
  if (!fresh && cached?.inflight) return cached.inflight;

  const inflight = buildAllowedRoots(fresh).then((roots) => {
    globalThis.__deerhuxAllowedRootsCache = {
      roots,
      expiresAt: Date.now() + ALLOWED_ROOTS_TTL_MS,
    };
    return roots;
  }).finally(() => {
    const current = globalThis.__deerhuxAllowedRootsCache;
    if (current?.inflight === inflight) {
      delete current.inflight;
    }
  });

  globalThis.__deerhuxAllowedRootsCache = {
    roots: cached?.roots ?? new Set(),
    expiresAt: 0,
    inflight,
  };
  return inflight;
}

export function isPathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = normalizeRoot(resolver.resolve(target));
    const normalizedRoot = normalizeRoot(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}
