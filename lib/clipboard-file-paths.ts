/** Only file URLs carry original paths; a browser File.name is never a path. */
export function parseClipboardFilePaths(uriList: string): string[] {
  const paths: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    if (!line.trim().toLowerCase().startsWith("file://")) continue;
    try {
      const url = new URL(line.trim());
      const pathname = decodeURIComponent(url.pathname);
      const path = url.hostname && url.hostname !== "localhost"
        ? `//${url.hostname}${pathname}`
        : /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname;
      if (path && !paths.includes(path)) paths.push(path);
    } catch {
      // Ignore malformed clipboard entries, never infer a path from a filename.
    }
  }
  return paths;
}

export async function clipboardFilePaths(uriList: string, desktop: boolean): Promise<string[]> {
  const paths = parseClipboardFilePaths(uriList);
  if (paths.length || !desktop) return paths;
  const { invoke } = await import("@tauri-apps/api/core");
  const nativePaths = await invoke<string[]>("read_clipboard_file_paths");
  return [...new Set(nativePaths.flatMap((path) =>
    /^file:\/\//i.test(path) ? parseClipboardFilePaths(path) : [path]))];
}
