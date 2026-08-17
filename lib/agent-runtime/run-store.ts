import fs from "fs";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isTerminalAgentRunStatus,
  type AgentRunRecord,
  type AgentRunTransition,
  type CreateAgentRunInput,
} from "./run-types.ts";

const RUNS_DIR_NAME = "runs";
const RUN_FILE_RE = /^[A-Za-z0-9._:-]{1,240}\.json$/;
/** 终态 Run 的默认保留期（7 天）。可被 DEERHUX_RUN_TTL_MS 覆盖。 */
const DEFAULT_RUN_TTL_MS = 7 * 24 * 60 * 60_000;
/** 单次清理最多删除的文件数——防御损坏目录导致的启动尖峰。 */
const MAX_PRUNE_PER_PASS = 2_000;

function readRunTtlMs(): number {
  const raw = process.env.DEERHUX_RUN_TTL_MS;
  if (!raw) return DEFAULT_RUN_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_RUN_TTL_MS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeRunFileName(runId: string): string {
  const normalized = runId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 240);
  if (!normalized) throw new Error("Invalid empty agent run id");
  return `${normalized}.json`;
}

function readRunFile(filePath: string): AgentRunRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AgentRunRecord>;
    if (
      parsed.version !== 1
      || typeof parsed.runId !== "string"
      || typeof parsed.sessionId !== "string"
      || typeof parsed.turnId !== "string"
      || typeof parsed.status !== "string"
      || typeof parsed.ownerEpoch !== "string"
    ) return null;
    return parsed as AgentRunRecord;
  } catch {
    return null;
  }
}

/**
 * 单进程 Run 状态持久层。
 *
 * 每次 transition 写完整快照到同目录临时文件；fsync 后 rename，因此重启时至多
 * 读取上一个完整状态，不会得到半截 JSON。它刻意不自动续跑任何外部副作用：旧进程
 * 的非终态 run 会由 reconcileInterruptedRuns 收敛为 interrupted。
 */
export class AgentRunStore {
  readonly epoch: string;
  private readonly runsDir: string;

  constructor(agentDir = getAgentDir(), epoch = `runtime_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`) {
    this.runsDir = path.join(agentDir, RUNS_DIR_NAME);
    this.epoch = epoch;
  }

  create(input: CreateAgentRunInput): AgentRunRecord {
    const timestamp = nowIso();
    const record: AgentRunRecord = {
      version: 1,
      runId: input.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      requestKind: input.requestKind ?? "main",
      status: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerProcessId: process.pid,
      ownerEpoch: this.epoch,
      ...(input.model ? { model: input.model } : {}),
    };
    this.write(record);
    return record;
  }

  get(runId: string): AgentRunRecord | null {
    return readRunFile(this.filePath(runId));
  }

  getLatestForSession(sessionId: string): AgentRunRecord | null {
    let latest: AgentRunRecord | null = null;
    for (const record of this.list()) {
      if (record.sessionId !== sessionId) continue;
      if (!latest || record.updatedAt > latest.updatedAt) latest = record;
    }
    return latest;
  }

  list(): AgentRunRecord[] {
    try {
      if (!fs.existsSync(this.runsDir)) return [];
      return fs.readdirSync(this.runsDir)
        .filter((file) => RUN_FILE_RE.test(file))
        .map((file) => readRunFile(path.join(this.runsDir, file)))
        .filter((record): record is AgentRunRecord => record !== null);
    } catch {
      return [];
    }
  }

  transition(runId: string, transition: AgentRunTransition): AgentRunRecord {
    const current = this.get(runId);
    if (!current) throw new Error(`Agent run not found: ${runId}`);
    if (isTerminalAgentRunStatus(current.status) && current.status !== transition.status) {
      throw new Error(`Cannot transition terminal agent run ${runId} from ${current.status} to ${transition.status}`);
    }
    const timestamp = nowIso();
    const next: AgentRunRecord = {
      ...current,
      ...transition,
      updatedAt: timestamp,
      ...(transition.status === "running" && !current.startedAt ? { startedAt: timestamp } : {}),
      ...(isTerminalAgentRunStatus(transition.status) && !current.endedAt ? { endedAt: timestamp } : {}),
      ownerProcessId: process.pid,
      ownerEpoch: this.epoch,
    };
    this.write(next);
    return next;
  }

  /**
   * 当前运行时接管磁盘事实前，将其它 epoch 遗留的非终态任务标记为 interrupted。
   * 不尝试自动重放，避免写文件、Shell、MCP、子 Agent 等副作用重复执行。
   */
  reconcileInterruptedRuns(sessionId?: string): AgentRunRecord[] {
    this.pruneExpiredRuns();
    const reconciled: AgentRunRecord[] = [];
    for (const record of this.list()) {
      if (sessionId && record.sessionId !== sessionId) continue;
      if (isTerminalAgentRunStatus(record.status) || record.ownerEpoch === this.epoch) continue;
      try {
        reconciled.push(this.transition(record.runId, {
          status: "interrupted",
          lastEventType: "runtime_interrupted",
          errorCode: "RUNTIME_RESTARTED",
          error: "Agent runtime restarted before this turn reached a terminal state. Continue from the persisted session history.",
        }));
      } catch {
        // A concurrent reconciler may have won. Re-read on the next lifecycle operation.
      }
    }
    return reconciled;
  }

  /**
   * 删除超过 TTL 的终态 Run 文件（按 endedAt / updatedAt 判定）。
   * 挂起清理在 reconcileInterruptedRuns 时顺带执行——无需独立 timer，
   * 避免 HMR/长驻进程泄漏 interval。失败静默（清理是尽力而为）。
   */
  pruneExpiredRuns(ttlMs = readRunTtlMs()): number {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.runsDir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (removed >= MAX_PRUNE_PER_PASS) break;
      if (!RUN_FILE_RE.test(name)) continue;
      const filePath = path.join(this.runsDir, name);
      const record = readRunFile(filePath);
      // 无终态时间戳的非终态 Run 不清理（reconcile 会先收敛它们）。
      const endedAt = record?.endedAt ? Date.parse(record.endedAt) : NaN;
      const updatedAt = record?.updatedAt ? Date.parse(record.updatedAt) : NaN;
      const reference = Number.isFinite(endedAt)
        ? endedAt
        : Number.isFinite(updatedAt) && isTerminalAgentRunStatus(record!.status)
          ? updatedAt
          : NaN;
      if (!Number.isFinite(reference) || reference > cutoff) continue;
      try {
        fs.unlinkSync(filePath);
        removed += 1;
      } catch {
        // 已被并发清理或权限问题——下一轮再试。
      }
    }
    return removed;
  }

  private filePath(runId: string): string {
    return path.join(this.runsDir, safeRunFileName(runId));
  }

  private write(record: AgentRunRecord): void {
    fs.mkdirSync(this.runsDir, { recursive: true });
    const target = this.filePath(record.runId);
    const temporary = path.join(
      this.runsDir,
      `.${safeRunFileName(record.runId)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "w", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, target);
      // Persist rename metadata where supported. Failure here should not invalidate
      // the now-visible file, so it deliberately remains best effort.
      try {
        const dirFd = fs.openSync(this.runsDir, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* Windows/filesystems may reject directory fsync. */ }
    } catch (error) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* noop */ }
      try { fs.unlinkSync(temporary); } catch { /* noop */ }
      throw new Error(`Failed to persist agent run ${record.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

declare global {
  var __deerhuxAgentRunStore: AgentRunStore | undefined;
  var __deerhuxAgentRunPruneDone: boolean | undefined;
}

export function getAgentRunStore(): AgentRunStore {
  if (!globalThis.__deerhuxAgentRunStore) {
    const store = new AgentRunStore();
    globalThis.__deerhuxAgentRunStore = store;
    // 每进程一次的启动清理：覆盖长驻但从不触发 reconcile 的场景。
    // 后续清理挂在 reconcileInterruptedRuns 上（ensureRpcSession 每次冷启动都会调）。
    if (!globalThis.__deerhuxAgentRunPruneDone) {
      globalThis.__deerhuxAgentRunPruneDone = true;
      try {
        store.pruneExpiredRuns();
      } catch {
        // 启动清理失败不阻断任何功能。
      }
    }
  }
  return globalThis.__deerhuxAgentRunStore;
}
