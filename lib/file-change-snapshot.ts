import { readFileChanges, type FileChange } from "./file-changes.ts";

export const FILE_CHANGE_SNAPSHOT_ENTRY = "file_change_snapshot";

/** 一轮结束时的文件变更证据；读取和展示均不得查询文件当前状态。 */
export interface FileChangeSnapshot {
  version: 1;
  turnId: string;
  capturedAt: number;
  changedFiles: string[];
  fileChanges: FileChange[];
}

export function createFileChangeSnapshot(
  turnId: string,
  changedFiles: string[],
  fileChanges: FileChange[],
  capturedAt = Date.now(),
): FileChangeSnapshot {
  const files = [...new Set(changedFiles.filter((file) => typeof file === "string" && file.trim() && !file.includes("\0")))];
  const paths = new Set(files);
  return {
    version: 1, turnId, capturedAt, changedFiles: files,
    fileChanges: readFileChanges(fileChanges).filter((change) => paths.has(change.filePath))
      .map(({ filePath, beforeExists, afterExists }) => ({ filePath, beforeExists, afterExists })),
  };
}

/** 返回独立副本，避免事件数组/组件状态在保存后反向修改快照。 */
export function readFileChangeSnapshot(value: unknown): FileChangeSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.turnId !== "string" || !item.turnId.trim()
    || typeof item.capturedAt !== "number" || !Number.isFinite(item.capturedAt)
    || !Array.isArray(item.changedFiles) || !item.changedFiles.every((file) => typeof file === "string")
    || !Array.isArray(item.fileChanges)) return null;
  return createFileChangeSnapshot(item.turnId, item.changedFiles, readFileChanges(item.fileChanges), item.capturedAt);
}
