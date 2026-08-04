"use client";

import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

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
    <div
      onClick={() => { if (!busy) onCancel(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2100,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compaction-confirm-title"
        style={{
          width: "min(480px, calc(100vw - 40px))",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 16px 40px rgba(0,0,0,0.3)",
          padding: 18,
        }}
      >
        <div
          id="compaction-confirm-title"
          style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}
        >
          {title}
        </div>

        {!showingProgress && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
              {body}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text)",
                lineHeight: 1.5,
                marginBottom: 14,
                padding: "8px 10px",
                background: "var(--bg)",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            >
              当前用量：<b>{usageText}</b>
            </div>

            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              压缩用模型
            </label>
            <select
              disabled={modelOptions.length === 0}
              value={selectedValue}
              onChange={(e) => {
                const [provider, modelId] = e.target.value.split(":::");
                if (provider && modelId) setSelected({ provider, modelId });
              }}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13,
                marginBottom: 8,
              }}
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
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: error ? 10 : 16 }}>
              建议选择稳定、延迟较低的模型做摘要；选择会记住，下次默认沿用。
            </div>
          </>
        )}

        {showingProgress && (
          <div
            style={{
              marginBottom: 14,
              padding: "12px 12px 10px",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5, fontWeight: 600 }}>
                {progress?.message || "正在压缩…"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                {startedAt != null ? formatElapsed(elapsedMs) : "—"}
              </div>
            </div>

            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: "var(--border)",
                overflow: "hidden",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(4, Math.round(stepRatio * 100))}%`,
                  background: progress?.phase === "done" ? "#16a34a" : "var(--accent)",
                  transition: "width 0.35s ease",
                }}
              />
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {PHASE_STEPS.map((step, index) => {
                const done = activePhaseIndex > index || progress?.phase === "done";
                const active = activePhaseIndex === index && progress?.phase !== "done";
                return (
                  <span
                    key={step.phase}
                    style={{
                      fontSize: 11,
                      padding: "3px 8px",
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: done
                        ? "rgba(22,163,74,0.12)"
                        : active
                          ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                          : "transparent",
                      color: done ? "#16a34a" : active ? "var(--accent)" : "var(--text-dim)",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {step.label}
                    {step.phase === "summarizing" && progress?.batchTotal && progress.batchTotal > 1
                      ? ` ${progress.batchIndex ?? 0}/${progress.batchTotal}`
                      : ""}
                  </span>
                );
              })}
            </div>

            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55 }}>
              {progress?.model
                ? <>摘要模型：<b style={{ color: "var(--text)" }}>{progress.model.provider}/{progress.model.modelId}</b></>
                : selected
                  ? <>摘要模型：<b style={{ color: "var(--text)" }}>{selected.provider}/{selected.modelId}</b></>
                  : null}
              {(progress?.tokensBefore != null || contextUsage?.tokens != null) && (
                <>
                  {" · "}用量：
                  <b style={{ color: "var(--text)" }}>
                    {(progress?.tokensBefore ?? contextUsage?.tokens)?.toLocaleString()}
                    {progress?.tokensAfter != null ? ` → ${progress.tokensAfter.toLocaleString()}` : ""}
                  </b>
                  {" tokens"}
                </>
              )}
            </div>
            {busy && (
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
                压缩进行中，请勿关闭页面。可随时点「停止压缩」中止。
              </div>
            )}
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "#ef4444",
              lineHeight: 1.5,
              marginBottom: 14,
              padding: "8px 10px",
              background: "rgba(239,68,68,0.08)",
              borderRadius: 8,
              border: "1px solid rgba(239,68,68,0.2)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          {busy ? (
            <button
              type="button"
              onClick={onAbort}
              style={{
                padding: "7px 16px",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.35)",
                borderRadius: 7,
                color: "#ef4444",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              停止压缩
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  padding: "7px 16px",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {progress?.phase === "done" ? "关闭" : "取消"}
              </button>
              {reason === "threshold" && onSkipSend && progress?.phase !== "done" && (
                <button
                  type="button"
                  onClick={onSkipSend}
                  style={{
                    padding: "7px 16px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  不压缩，仍发送
                </button>
              )}
              {progress?.phase !== "done" && (
                <button
                  type="button"
                  disabled={!selected}
                  onClick={() => {
                    if (!selected) return;
                    writeStoredCompactionModel(selected);
                    onConfirm(selected);
                  }}
                  style={{
                    padding: "7px 16px",
                    background: !selected ? "color-mix(in srgb, var(--accent) 55%, transparent)" : "var(--accent)",
                    border: "none",
                    borderRadius: 7,
                    color: "#fff",
                    cursor: !selected ? "default" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {reason === "threshold" ? "压缩后发送" : "开始压缩"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
