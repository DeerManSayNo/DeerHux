export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  const segments = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("//") && segments.length > 0) {
    segments[0] = `\\\\${segments[0]}`;
  }
  return segments.map(encodeURIComponent).join("/");
}

export function fileApiReadUrl(filePath: string): string {
  return `/api/files/${encodeFilePathForApi(filePath)}?type=read`;
}

/** Repair file URLs persisted before Windows paths were encoded for the API route. */
export function normalizeLegacyFileApiReadUrl(url: string): string {
  const prefix = "/api/files";
  if (!url.startsWith(prefix)) return url;

  const suffix = url.endsWith("?type=read") ? "?type=read" : "";
  const legacyPath = url.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(legacyPath)) return url;
  return fileApiReadUrl(legacyPath);
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}

/** Resolve the tree root and ancestors for an explicit file reveal. */
export function getExplorerRevealTarget(filePath: string, cwd: string) {
  const path = normalizeFilePathSlashes(filePath);
  const project = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  const root = path.startsWith(`${project}/`) ? project || "/" : path.slice(0, path.lastIndexOf("/")) || "/";
  const prefix = root.replace(/\/$/, "");
  const parts = path.slice(prefix.length + 1).split("/");
  const expandedPaths: string[] = [];
  let parent = prefix;
  for (const part of parts.slice(0, -1)) {
    parent += `/${part}`;
    expandedPaths.push(parent);
  }
  return { root, path, expandedPaths };
}
