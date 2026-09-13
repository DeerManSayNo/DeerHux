"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import styles from "./CompactionConfirmModal.module.css";
import {
  formatContextUsage,
  readStoredCompactionModel,
  writeStoredCompactionModel,
  type CompactionModelRef,
  type CompactionProgress,
  type CompactionProgressPhase,
} from "@/lib/compaction-ui";

export type CompactionModelOption = {
  provider: string;
  modelId: string;
  name: string;
};

type Props = {
  open: boolean;
  reason: "threshold" | "manual";
  contextUsage?: {
    percent?: number | null;
    tokens?: number | null;
    contextWindow?: number;
  } | null;
  /** 当前会话主模型，作为默认候选之一。 */
  sessionModel?: CompactionModelRef | null;
  modelOptions: CompactionModelOption[];
  busy?: boolean;
  error?: string | null;
  progress?: CompactionProgress | null;
  onConfirm: (model: CompactionModelRef) => void;
  onCancel: () => void;
  onAbort?: () => void;
  /** 仅 threshold 场景：跳过压缩仍发送。 */
  onSkipSend?: () => void;
};

const PHASE_STEPS: { phase: CompactionProgressPhase; label: string }[] = [
  { phase: "preparing", label: "分析边界" },
  { phase: "summarizing", label: "生成摘要" },
  { phase: "archiving", label: "归档历史" },
  { phase: "applying", label: "写入结果" },
  { phase: "done", label: "完成" },
];

function phaseIndex(phase: CompactionProgressPhase | undefined): number {
  if (!phase) return -1;
  return PHASE_STEPS.findIndex((s) => s.phase === phase);
}

function pickDefaultModel(
  options: CompactionModelOption[],
  sessionModel?: CompactionModelRef | null,
): CompactionModelRef | null {
  if (!options.length) return sessionModel ?? null;
  const stored = readStoredCompactionModel();
  if (stored && options.some((o) => o.provider === stored.provider && o.modelId === stored.modelId)) {
    return stored;
  }
  if (sessionModel && options.some((o) => o.provider === sessionModel.provider && o.modelId === sessionModel.modelId)) {
    return sessionModel;
  }
  return { provider: options[0].provider, modelId: options[0].modelId };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

export function CompactionConfirmModal({
  open,
  reason,
  contextUsage,
  sessionModel,
  modelOptions,
  busy = false,
  error = null,
  progress = null,
  onConfirm,
  onCancel,
  onAbort,
  onSkipSend,
}: Props) {
  const [selected, setSelected] = useState<CompactionModelRef | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setSelected(pickDefaultModel(modelOptions, sessionModel));
  }, [open, modelOptions, sessionModel]);

  useEffect(() => {
    if (busy && startedAt == null) setStartedAt(Date.now());
    if (!busy && !progress) setStartedAt(null);
  }, [busy, progress, startedAt]);

  useEffect(() => {
    if (!busy && progress?.phase !== "done") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [busy, progress?.phase]);

  const selectedValue = useMemo(() => {
    if (!selected) return "";
    return `${selected.provider}:::${selected.modelId}`;
  }, [selected]);

  const activePhaseIndex = phaseIndex(progress?.phase);
  const batchRatio = progress?.batchTotal && progress.batchIndex
    ? progress.batchIndex / progress.batchTotal
    : 0;
  const stepRatio = activePhaseIndex < 0
    ? (busy ? 0.05 : 0)
    : progress?.phase === "done"
      ? 1
      : (activePhaseIndex + Math.min(0.9, batchRatio || 0.15)) / (PHASE_STEPS.length - 1);
  const elapsedMs = startedAt != null ? now - startedAt : 0;
  const showingProgress = busy || Boolean(progress);

  if (!open) return null;

  const usageText = formatContextUsage(contextUsage);
  const title = showingProgress
    ? (progress?.phase === "done" ? "压缩完成" : "正在压缩上下文")
    : reason === "threshold"
      ? "上下文即将耗尽，建议先压缩"
      : "压缩上下文";
  const body = reason === "threshold"
    ? "当前上下文用量已超过安全阈值。继续发送前建议先压缩历史；可另选更稳定的模型专门做摘要，不会改会话主模型。"
    : "将用所选模型生成会话摘要并裁剪旧历史。摘要模型仅用于本次压缩，不会切换当前对话模型。";

  return (
    <ModalShell
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      layout="confirm"
      title={title}
      ariaLabel={title}
      actions={null}
      footer={
        busy ? (
          <Button variant="danger" onClick={onAbort}>
            停止压缩
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onCancel}>
              {progress?.phase === "done" ? "关闭" : "取消"}
            </Button>
            {reason === "threshold" && onSkipSend && progress?.phase !== "done" && (
              <Button variant="secondary" onClick={onSkipSend}>
                不压缩，仍发送
              </Button>
            )}
            {progress?.phase !== "done" && (
              <Button
                variant="primary"
                disabled={!selected}
                onClick={() => {
                  if (!selected) return;
                  writeStoredCompactionModel(selected);
                  onConfirm(selected);
                }}
              >
                {reason === "threshold" ? "压缩后发送" : "开始压缩"}
              </Button>
            )}
          </>
        )
      }
    >
      {!showingProgress && (
        <>
          <p className={styles.body}>{body}</p>
          <div className={styles.usageBox}>
            当前用量：<b>{usageText}</b>
          </div>

          <label className={styles.label} htmlFor="compaction-model">
            压缩用模型
          </label>
          <select
            id="compaction-model"
            disabled={modelOptions.length === 0}
            value={selectedValue}
            onChange={(e) => {
              const [provider, modelId] = e.target.value.split(":::");
              if (provider && modelId) setSelected({ provider, modelId });
            }}
            className={styles.select}
          >
            {modelOptions.length === 0 ? (
              <option value="">暂无可用模型</option>
            ) : (
              modelOptions.map((opt) => (
                <option key={`${opt.provider}:${opt.modelId}`} value={`${opt.provider}:::${opt.modelId}`}>
                  {opt.name}（{opt.provider}）
                </option>
              ))
            )}
          </select>
          <p className={styles.hint}>
            建议选择稳定、延迟较低的模型做摘要；选择会记住，下次默认沿用。
          </p>
        </>
      )}

      {showingProgress && (
        <div className={styles.progressBox}>
          <div className={styles.progressHead}>
            <div className={styles.progressMessage}>{progress?.message || "正在压缩…"}</div>
            <div className={styles.progressElapsed}>
              {startedAt != null ? formatElapsed(elapsedMs) : "—"}
            </div>
          </div>

          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${Math.min(100, Math.round(stepRatio * 100))}%` }} />
          </div>

          <div className={styles.stepRow}>
            {PHASE_STEPS.map((step) => {
              const stepActiveIndex = phaseIndex(step.phase);
              const done = activePhaseIndex >= 0 && stepActiveIndex < activePhaseIndex;
              const active = stepActiveIndex === activePhaseIndex;
              return (
                <span
                  key={step.phase}
                  className={
                    done
                      ? `${styles.step} ${styles.stepDone}`
                      : active
                        ? `${styles.step} ${styles.stepActive}`
                        : styles.step
                  }
                >
                  {step.label}
                  {step.phase === "summarizing" && progress?.batchTotal && progress.batchTotal > 1
                    ? ` ${progress.batchIndex ?? 0}/${progress.batchTotal}`
                    : ""}
                </span>
              );
            })}
          </div>

          <div className={styles.progressMeta}>
            {progress?.model ? (
              <>
                摘要模型：
                <b className={styles.progressMetaStrong}>
                  {progress.model.provider}/{progress.model.modelId}
                </b>
              </>
            ) : selected ? (
              <>
                摘要模型：
                <b className={styles.progressMetaStrong}>
                  {selected.provider}/{selected.modelId}
                </b>
              </>
            ) : null}
            {(progress?.tokensBefore != null || contextUsage?.tokens != null) && (
              <>
                {" · "}用量：
                <b className={styles.progressMetaStrong}>
                  {(progress?.tokensBefore ?? contextUsage?.tokens)?.toLocaleString()}
                  {progress?.tokensAfter != null ? ` → ${progress.tokensAfter.toLocaleString()}` : ""}
                </b>
                {" tokens"}
              </>
            )}
          </div>
          {busy && (
            <div className={styles.progressNote}>压缩进行中，请勿关闭页面。可随时点「停止压缩」中止。</div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className={styles.errorBox}>
          {error}
        </div>
      )}
    </ModalShell>
  );
}
