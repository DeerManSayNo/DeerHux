const DEFAULT_CWD_NAME_RE = /^(?:deerhux-cwd|pi-cwd)(?:-\d{8})?$/;

/** Convert an internal cwd into the user-facing project label. */
export function getProjectDisplayName(cwd: string): string {
  if (isScheduledTasksCwd(cwd)) return "默认";
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? cwd;
  return DEFAULT_CWD_NAME_RE.test(name) ? "默认" : name;
}

export function isScheduledTasksCwd(cwd: string): boolean {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return /[\\/]\.deerhux[\\/]agent[\\/]scheduled-tasks$/.test(normalized)
    || /[\\/]\.deerhux[\\/]agent[\\/]wechat[\\/]remote-cwd$/.test(normalized);
}

/** Group internal task sessions under Default without changing their execution cwd. */
export function getSidebarProjectCwd(cwd: string, defaultCwd: string | null): string | null {
  return isScheduledTasksCwd(cwd) ? defaultCwd : cwd;
}
