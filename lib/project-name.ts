const DEFAULT_CWD_NAME_RE = /^(?:deerhux-cwd|pi-cwd)(?:-\d{8})?$/;

/** Convert an internal cwd into the user-facing project label. */
export function getProjectDisplayName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? cwd;
  return DEFAULT_CWD_NAME_RE.test(name) ? "默认" : name;
}
