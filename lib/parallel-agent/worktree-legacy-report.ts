import { createHash } from "node:crypto";
import type { CollaborationRunState } from "./collaboration-types.ts";

export const LEGACY_REPORT_LIMITS = Object.freeze({ maxWorkers: 32, maxIdentityInputCharacters: 160 });
const RUN_STATUSES = ["setting_up", "running", "complete", "aborted", "error", "applying", "applied", "recoverable"] as const;
const WORKER_STATUSES = ["pending", "running", "complete", "aborted", "error"] as const;
type HistoricalStatus = typeof RUN_STATUSES[number] | "unknown";
type HistoricalWorkerStatus = typeof WORKER_STATUSES[number] | "unknown";

export interface LegacyWorktreeRecoveryReport {
  version: 1;
  kind: "legacy_read_only";
  runRef: string | null;
  historicalStatus: HistoricalStatus;
  historicalApplied: boolean;
  historyEvidence: "store_only_not_git_verified";
  reason: "legacy_baseline_unverified" | "legacy_applied_history_only";
  workerCount: number | null;
  inspectedWorkerCount: number;
  workersTruncated: boolean;
  workers: Array<{ ordinal: number; workerRef: string | null; historicalStatus: HistoricalWorkerStatus; storedDiffPresent: boolean }>;
  baseline: "unverified";
  resources: "not_inspected";
  capabilities: { apply: false; continue: false; discard: false; automaticMigration: false; diffDownload: false; metadataExport: true };
  diffExport: { available: false; reason: "legacy_diff_content_not_verified" };
  instructions: Array<{ code: "preserve_resources" | "history_only" | "export_manually" | "verify_baseline" | "no_automatic_migration"; text: string }>;
  limits: typeof LEGACY_REPORT_LIMITS;
}

// Only plain stored fields are relevant. Never traverse events, session metadata,
// paths, baseline claims, names, prompts or the contents of a historical diff.
function ownValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function reference(value: unknown, prefix: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > LEGACY_REPORT_LIMITS.maxIdentityInputCharacters) return null;
  // Opaque correlation reference, not a trusted path, identity proof or capability.
  return `${prefix}-${createHash("sha256").update(prefix).update("\0").update(value).digest("hex").slice(0, 16)}`;
}

/**
 * A bounded report over an already-loaded Store snapshot. This performs no I/O
 * and grants no lifecycle authority. A manifest reference always remains on the
 * v2 path, even when that reference might later fail v2 validation.
 *
 * Legacy diff text can contain credentials and absolute paths; safely proving
 * otherwise requires unavailable provenance. Only metadata can be exported.
 */
export function buildLegacyWorktreeRecoveryReport(state: CollaborationRunState): LegacyWorktreeRecoveryReport | null {
  if (ownValue(state, "mode") !== "isolated_coding") return null;
  const implementation = ownValue(state, "worktreeImplementation");
  if (implementation !== undefined && implementation !== null) return null;
  const manifest = ownValue(state, "worktreeManifestPath");
  if (manifest !== undefined && manifest !== null && manifest !== "") return null;
  const status = ownValue(state, "status");
  const historicalStatus: HistoricalStatus = RUN_STATUSES.includes(status as typeof RUN_STATUSES[number]) ? status as HistoricalStatus : "unknown";
  const historicalApplied = historicalStatus === "applied" || ownValue(state, "applyState") === "applied";
  const sourceWorkers = ownValue(state, "workers");
  const length = Array.isArray(sourceWorkers) ? ownValue(sourceWorkers, "length") : undefined;
  const workerCount = typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : null;
  const inspectedWorkerCount = workerCount === null ? 0 : Math.min(workerCount, LEGACY_REPORT_LIMITS.maxWorkers);
  const workers: LegacyWorktreeRecoveryReport["workers"] = [];
  for (let index = 0; index < inspectedWorkerCount; index += 1) {
    const worker = ownValue(sourceWorkers, String(index));
    const workerStatus = ownValue(worker, "status");
    const diff = ownValue(worker, "diff");
    workers.push({ ordinal: index + 1, workerRef: reference(ownValue(worker, "workerId"), "worker"),
      historicalStatus: WORKER_STATUSES.includes(workerStatus as typeof WORKER_STATUSES[number]) ? workerStatus as HistoricalWorkerStatus : "unknown",
      storedDiffPresent: typeof diff === "string" && diff.length > 0 });
  }
  return {
    version: 1, kind: "legacy_read_only", runRef: reference(ownValue(state, "runId"), "legacy"), historicalStatus,
    historicalApplied, historyEvidence: "store_only_not_git_verified",
    reason: historicalApplied ? "legacy_applied_history_only" : "legacy_baseline_unverified",
    workerCount, inspectedWorkerCount, workersTruncated: workerCount === null || workerCount > inspectedWorkerCount, workers,
    baseline: "unverified", resources: "not_inspected",
    capabilities: { apply: false, continue: false, discard: false, automaticMigration: false, diffDownload: false, metadataExport: true },
    diffExport: { available: false, reason: "legacy_diff_content_not_verified" },
    instructions: [
      { code: "preserve_resources", text: "保留现有工作目录、分支和历史记录；本报告未检查资源是否存在，也不授权任何清理。" },
      ...(historicalApplied ? [{ code: "history_only" as const, text: "历史记录标记为已应用；仅保持历史展示，不重新 Apply 或触发清理。本报告未核验当前 Git 状态。" }] : []),
      { code: "export_manually", text: "可保存本报告的脱敏元数据。历史 Diff 正文未验证，不能从此报告下载；请由用户在可信的本地历史记录或备份中人工定位、审阅并另存副本，导出前检查凭据和私密内容。" },
      { code: "verify_baseline", text: "人工恢复前，须从可靠的创建记录独立确认原仓库与创建基线；不能使用当前 HEAD、旧路径或不完整 Diff 猜测基线。未能证明时不要自动应用。" },
      { code: "no_automatic_migration", text: "本报告不会生成 manifest、转换为 v2、运行 Git 或改写 Session。保留原记录，在独立副本中人工核验恢复方案。" },
    ],
    limits: { ...LEGACY_REPORT_LIMITS },
  };
}
