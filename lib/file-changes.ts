/** 保留本轮首次操作前和最后一次操作后的存在状态，避免新增后编辑被误标为编辑。 */
export interface FileChange {
  filePath: string;
  beforeExists: boolean;
  afterExists: boolean;
}

export function readFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is FileChange => Boolean(item)
    && typeof item.filePath === "string" && item.filePath.trim().length > 0
    && typeof item.beforeExists === "boolean" && typeof item.afterExists === "boolean");
}

export function mergeFileChanges(previous: FileChange[], incoming: FileChange[]): FileChange[] {
  const result = new Map(previous.map((change) => [change.filePath, change]));
  for (const change of incoming) {
    const first = result.get(change.filePath);
    result.set(change.filePath, { ...change, beforeExists: first?.beforeExists ?? change.beforeExists });
  }
  return [...result.values()];
}

export function fileChangeKind(change: FileChange): "added" | "modified" | "deleted" {
  return !change.afterExists ? "deleted" : change.beforeExists ? "modified" : "added";
}
