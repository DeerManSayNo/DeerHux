import path from "node:path";

/** 修改记录允许项目外路径，也允许文件已被删除；这里不检查文件存在性。 */
export function resolveChangedFilePath(filePath: string, cwd: string): string | null {
  if (!filePath || !filePath.trim() || filePath.includes("\0")) return null;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, filePath);
  return resolved === root ? null : resolved;
}
