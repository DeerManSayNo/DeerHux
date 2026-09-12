export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
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
