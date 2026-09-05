/** Capture-time Git blob sizes (not checkout/disk size); absent sides and gitlinks are null. */
export interface WorktreeFileChange {
  path: string;
  previousPath: string | null;
  changeKind: "new" | "modified" | "deleted" | "renamed" | "typechange";
  binary: boolean;
  oldBytes: number | null;
  newBytes: number | null;
  addedLines: number | null;
  deletedLines: number | null;
}
export const CHANGE_KINDS = ["new", "modified", "deleted", "renamed", "typechange"] as const;
export interface WorktreeChangeStats {
  newFiles: number; modifiedFiles: number; deletedFiles: number; renamedFiles: number; typechangedFiles: number;
  addedLines: number; deletedLines: number; binaryFiles: number;
}
const numericFields = ["oldBytes", "newBytes", "addedLines", "deletedLines"] as const;
const statsFields = ["newFiles", "modifiedFiles", "deletedFiles", "renamedFiles", "typechangedFiles", "addedLines", "deletedLines", "binaryFiles"] as const;
export function isCaptureRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
    && !value.includes("\\") && !/^(?:\/|[a-zA-Z]:)/.test(value)
    && !value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}
export function isWorktreeFileChange(value: unknown): value is WorktreeFileChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["path", "previousPath", "changeKind", "binary", ...numericFields];
  if (Object.keys(item).length !== keys.length || Object.keys(item).some((key) => !keys.includes(key))) return false;
  if (!isCaptureRelativePath(item.path) || !CHANGE_KINDS.includes(item.changeKind as WorktreeFileChange["changeKind"]) || typeof item.binary !== "boolean") return false;
  if (item.changeKind === "renamed" ? !isCaptureRelativePath(item.previousPath) || item.previousPath === item.path : item.previousPath !== null) return false;
  if (numericFields.some((key) => item[key] !== null && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0))) return false;
  if (item.binary ? item.addedLines !== null || item.deletedLines !== null : item.addedLines === null || item.deletedLines === null) return false;
  return !(item.changeKind === "new" && item.oldBytes !== null || item.changeKind === "deleted" && item.newBytes !== null);
}
export function summarizeFileChanges(changes: readonly WorktreeFileChange[] | undefined): WorktreeChangeStats | undefined {
  if (changes === undefined) return undefined;
  const stats: WorktreeChangeStats = { newFiles: 0, modifiedFiles: 0, deletedFiles: 0, renamedFiles: 0, typechangedFiles: 0, addedLines: 0, deletedLines: 0, binaryFiles: 0 };
  const field = { new: "newFiles", modified: "modifiedFiles", deleted: "deletedFiles", renamed: "renamedFiles", typechange: "typechangedFiles" } as const;
  for (const item of changes) {
    stats[field[item.changeKind]] += 1;
    stats.binaryFiles += item.binary ? 1 : 0;
    stats.addedLines = Math.min(Number.MAX_SAFE_INTEGER, stats.addedLines + (item.addedLines ?? 0));
    stats.deletedLines = Math.min(Number.MAX_SAFE_INTEGER, stats.deletedLines + (item.deletedLines ?? 0));
  }
  return stats;
}
export function sanitizeChangeStats(value: unknown): WorktreeChangeStats | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (statsFields.some((key) => !Number.isSafeInteger(item[key]) || Number(item[key]) < 0)) return undefined;
  return Object.fromEntries(statsFields.map((key) => [key, item[key]])) as unknown as WorktreeChangeStats;
}
