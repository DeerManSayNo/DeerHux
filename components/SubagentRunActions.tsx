"use client";

import { useEffect, useRef, useState } from "react";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";
import {
  ClientRequestError, DISCARD_CONFIRMATION, commitDiscard, createPendingApply, fetchRun, getRunCapabilities,
  previewDiscard, resumeWorker, runSelectionKey, submitApply, verifyPendingApply,
  type ApplyResponse, type DiscardPreview, type DiscardResult, type PendingApply,
} from "@/lib/subagent-review-client";
import { SubagentDiffDialog, SubagentOperationDialog, shortWorkerId, type SubagentReviewSelection } from "./SubagentDiffDialog";
import styles from "./SubagentReview.module.css";

interface Props {
  run: CollaborationRunSnapshot;
  onRunUpdate?: (run: CollaborationRunSnapshot) => void;
}

const resourceLabels: Record<string, string> = { worktree: "工作树", branch: "分支", patch: "diff artifact" };
const riskLabels: Record<string, string> = {
  UNCAPTURED_DIRTY_WORKTREE: "存在尚未捕获的工作树变更",
  WORKTREE_CHANGED_AFTER_CAPTURE: "工作树在捕获后有新变更",
  IGNORED_FILES_PRESENT: "存在 Git 忽略的文件",
  WORKTREE_CONTENT_UNVERIFIED: "工作树内容未完整核验，现存成果将保留",
};

function captureIdentity(run: CollaborationRunSnapshot): string {
  return JSON.stringify([run.captureState, run.workers.map((worker) => [worker.workerId, worker.patchSha256, worker.captureErrorCode])]);
}

function applyMessage(result: ApplyResponse): string {
  switch (result.outcome) {
    case "applied": return `服务端确认已应用 ${result.files.length} 个文件；文件状态以刷新后的 Run 为准。`;
    case "no_changes": return "没有可应用的变更，本次未执行应用。";
    case "conflict": return "检测到冲突，未确认应用成功。已保留选择，请重新审阅后处理冲突。";
    case "precondition_failed": return "应用前置条件已变化。请刷新并重新审阅，未确认应用成功。";
    case "recovery_required": return "应用需要恢复核验，已禁止新请求。成果仍保留，请查看恢复说明。";
    case "pending": return "服务端仍在应用中；请稍后核验上次应用。";
    case "unknown": return "应用结果暂不确定，已保留原幂等键与选择，请核验上次应用。";
    default: return "应用未完成。请刷新状态并审阅错误；没有显示为已应用。";
  }
}

export function SubagentRunActions(props: Props) {
  if (props.run.mode !== "isolated_coding") return null;
  return <RunActionsState key={props.run.runId} {...props} />;
}

function RunActionsState({ run, onRunUpdate }: Props) {
  const [fetched, setFetched] = useState<CollaborationRunSnapshot | null>(null);
  // On an exact revision/timestamp tie, prefer the incoming snapshot: cold recovery
  // may replace capture facts without advancing an old persisted revision.
  const latest = fetched && (fetched.version > run.version || fetched.version === run.version && fetched.updatedAt > run.updatedAt) ? fetched : run;
  const [clock, setClock] = useState(() => Date.now());
  const capabilities = getRunCapabilities(latest, clock);
  const [dialog, setDialog] = useState<"review" | "discard" | "continue" | "recovery" | null>(null);
  const [busy, setBusy] = useState(false);
  const operationRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [selection, setSelection] = useState<SubagentReviewSelection>({ key: runSelectionKey(run), workerIds: [], files: [] });
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState(false);
  const [discardWorkerIds, setDiscardWorkerIds] = useState<string[]>([]);
  const [discardPreview, setDiscardPreview] = useState<{ key: string; value: DiscardPreview } | null>(null);
  const [discardResult, setDiscardResult] = useState<DiscardResult | null>(null);
  const [strongText, setStrongText] = useState("");
  const [discardAcknowledged, setDiscardAcknowledged] = useState(false);
  const [continueWorkerId, setContinueWorkerId] = useState("");
  const [continuePrompt, setContinuePrompt] = useState("");
  const storageKey = `deerhux:pending-apply:${run.runId}`;
  const refreshedExpirations = useRef(new Set<string>());
  const deadlineKey = JSON.stringify([latest.continueExpiresAt, ...latest.workers.map((worker) => worker.continueExpiresAt), discardPreview?.value.tokenExpiresAt]);

  function acceptRun(next: CollaborationRunSnapshot) {
    setFetched(next);
    onRunUpdate?.(next);
  }

  function rememberPending(next: PendingApply | null) {
    setPending(next);
    try {
      if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
      else sessionStorage.removeItem(storageKey);
    } catch { /* In-memory request identity still protects the current mounted flow. */ }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
          const value = JSON.parse(stored) as PendingApply;
          if (value.runId === run.runId && typeof value.selectionKey === "string"
            && typeof value.payload?.idempotencyKey === "string"
            && Array.isArray(value.payload.workerIds) && value.payload.workerIds.every((id) => typeof id === "string")
            && Array.isArray(value.payload.files) && value.payload.files.every((file) => typeof file === "string")) {
            setPending(value);
            setNotice("发现上次未核验的应用请求。请先核验，不能直接提交新的请求。");
          }
        }
      } catch { /* Storage may be unavailable in private browsing. */ }
      setPendingLoaded(true);
    });
    return () => { cancelled = true; };
  }, [run.runId, storageKey]);

  useEffect(() => {
    const deadlines = (JSON.parse(deadlineKey) as Array<string | null>).filter((value): value is string => typeof value === "string")
      .map((value) => Date.parse(value)).filter(Number.isFinite).sort((a, b) => a - b);
    const deadline = deadlines.find((value) => !refreshedExpirations.current.has(`${run.runId}:${value}`));
    if (deadline === undefined) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      refreshedExpirations.current.add(`${run.runId}:${deadline}`);
      setClock(Date.now());
      void fetchRun(run.runId).then((next) => {
        if (!cancelled) { setFetched(next); onRunUpdate?.(next); }
      }).catch(() => { if (!cancelled) setNotice("继续能力或确认令牌已到期，无法刷新服务端状态，请手动刷新。"); });
    }, Math.min(Math.max(0, deadline - Date.now() + 20), 2_147_483_647));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [deadlineKey, clock, run.runId, onRunUpdate]);

  async function operate(action: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) {
      setNotice(error instanceof ClientRequestError && error.uncertain
        ? "请求结果暂不确定，请刷新服务端状态后核验；不会把它显示为已完成。"
        : "请求未完成，请刷新状态后重试。成果未被标记为成功处理。");
    } finally { operationRef.current = false; setBusy(false); }
  }

  async function refresh() {
    const next = await fetchRun(run.runId);
    acceptRun(next);
    setClock(Date.now());
    if (pending && next.status === "applied" && next.applyState === "applied"
      && next.applyTransactionId === pending.payload.idempotencyKey && !next.recoveryState) {
      rememberPending(null);
      setPendingRecovery(false);
      setSelection({ key: runSelectionKey(next), workerIds: [], files: [] });
    }
    return next;
  }

  async function settleApply(request: PendingApply, result: ApplyResponse, before: CollaborationRunSnapshot) {
    setConflicts(result.conflicts);
    setNotice(applyMessage(result));
    if (result.outcome === "recovery_required") setPendingRecovery(true);
    if (["pending", "unknown", "recovery_required"].includes(result.outcome)) {
      try { await refresh(); } catch { /* Keep the original request locked until verification. */ }
      return;
    }
    // Even a successful POST is not an optimistic Run update: read authoritative facts.
    const next = await refresh();
    if (result.outcome === "applied") {
      if (next.status !== "applied" || next.applyState !== "applied" || next.applyTransactionId !== request.payload.idempotencyKey) {
        setNotice("应用响应已返回，但服务端快照尚未确认同一事务。请核验上次应用。");
        return;
      }
      rememberPending(null);
      setPendingRecovery(false);
      setSelection({ key: runSelectionKey(next), workerIds: [], files: [] });
      return;
    }
    if (next.status === "applying" || next.applyState === "applying" || next.applyState === "recovery_required" || next.recoveryState) return;
    rememberPending(null);
    setPendingRecovery(false);
    if (captureIdentity(before) === captureIdentity(next)) {
      setSelection({ key: runSelectionKey(next), workerIds: [...request.payload.workerIds], files: [...request.payload.files] });
    } else setSelection({ key: runSelectionKey(next), workerIds: [], files: [] });
  }

  async function applySelected() {
    if (pending || !pendingLoaded || !capabilities.canApply || selection.key !== runSelectionKey(latest) || !selection.files.length) return;
    const next = await refresh();
    if (runSelectionKey(next) !== selection.key) {
      setNotice("Run 版本或捕获已变化，旧选择已失效。请重新审阅。");
      return;
    }
    const request = createPendingApply(next, selection.workerIds, selection.files);
    rememberPending(request);
    try { await settleApply(request, await submitApply(run.runId, request.payload), next); }
    catch {
      setNotice("应用结果暂不确定，已保存原幂等键与原文件选择。请核验上次应用，勿创建新请求。");
    }
  }

  async function verifyApply() {
    if (!pending || pendingRecovery || capabilities.recoveryRequired) return;
    const checked = await verifyPendingApply(pending);
    acceptRun(checked.run);
    await settleApply(pending, checked.result, latest);
  }

  async function loadDiscardPreview(strong = false) {
    if (!discardWorkerIds.length || pending) return;
    const next = await refresh();
    if (!getRunCapabilities(next).canDiscard) { setNotice("当前不能放弃成果，请等待操作结束。"); return; }
    const preview = await previewDiscard(run.runId, discardWorkerIds, strong ? DISCARD_CONFIRMATION : undefined);
    setDiscardPreview({ key: runSelectionKey(next), value: preview });
    setDiscardAcknowledged(false);
    setDiscardResult(null);
    if (!preview.ok && !preview.requiresStrongConfirmation) setNotice("预览未通过安全检查，未执行删除。请刷新状态或查看恢复说明。");
  }

  async function confirmDiscard() {
    const preview = discardPreview?.value;
    if (!preview?.confirmationToken || !discardAcknowledged || discardPreview?.key !== runSelectionKey(latest)
      || preview.tokenExpiresAt && Date.parse(preview.tokenExpiresAt) <= Date.now()) return;
    // Consume locally before sending; a network failure must never reuse this one-time token.
    setDiscardPreview(null);
    const result = await commitDiscard(run.runId, preview.confirmationToken);
    setDiscardResult(result);
    setNotice(result.complete ? "服务端确认清理完成。" : "部分资源仍保留，清理未全部完成。请查看逐 Worker 结果与恢复说明。");
    await refresh();
  }

  const selectionLocked = Boolean(pending) || !pendingLoaded;
  const recovery = capabilities.recoveryRequired || pendingRecovery;
  const preview = discardPreview?.key === runSelectionKey(latest) ? discardPreview.value : null;
  const noticeContent = notice ? <div className={styles.notice} role="status">{notice}
    {conflicts.length > 0 && <ul className={styles.resourceList}>{conflicts.map((file) => <li key={file}>{file}</li>)}</ul>}
  </div> : undefined;

  return <section className={styles.actions} aria-label="成果操作">
    <div className={styles.toolbar}>
      {capabilities.canReview && <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog("review")} title="按 Worker 审阅捕获的文件与 diff">审阅成果</button>}
      {capabilities.canDiscard && <button type="button" className={styles.dangerButton} disabled={busy || selectionLocked}
        onClick={() => { setDiscardWorkerIds(latest.workers.map((worker) => worker.workerId)); setDiscardPreview(null); setDiscardResult(null); setStrongText(""); setDiscardAcknowledged(false); setDialog("discard"); }}>放弃成果</button>}
      <button type="button" className={styles.button} disabled={busy} onClick={() => void operate(async () => { await refresh(); setNotice("已从服务端刷新状态。"); })}>刷新状态</button>
      {(recovery || pending || latest.status === "recoverable") && <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog("recovery")}>恢复说明</button>}
      {pending && !recovery && <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void operate(verifyApply)}>核验上次应用</button>}
    </div>
    {capabilities.busy && <p className={styles.muted}>当前 Run 正在执行或应用中，Continue、Discard 与新的 Apply 已禁用。</p>}
    {!latest.worktreeCapabilities && <p className={styles.muted}>尚未取得服务端操作能力，请刷新状态后再审阅和处理成果。</p>}
    {latest.worktreeCapabilities?.implementation === "v2" && !latest.worktreeCapabilities.apply && <p className={styles.warning}>
      服务端已暂停新的成果应用。审阅与下载仍可用；上次请求结果未知时，请先核验，不要创建新请求。
    </p>}
    {recovery && <p className={styles.warning}>需要人工恢复核验：不会自动生成新幂等键，也不会自动删除保留成果。</p>}
    {noticeContent}
    {latest.continueExpiresAt && <p className={styles.muted}>Run 继续能力到期：{new Date(latest.continueExpiresAt).toLocaleString()}；以 Run 与 Worker 中较早的到期时间为准。</p>}
    {latest.workers.filter((worker) => worker.canContinue || worker.continueExpiresAt).map((worker) => <div key={worker.workerId} className={styles.workerOperation}>
      <span>{worker.name} · {shortWorkerId(worker.workerId)}</span>
      <button type="button" className={styles.button} disabled={busy || selectionLocked || !capabilities.continueWorkerIds.includes(worker.workerId)}
        aria-label={`继续 Worker ${worker.name} (${shortWorkerId(worker.workerId)})`}
        onClick={() => { setContinueWorkerId(worker.workerId); setContinuePrompt(""); setDialog("continue"); }}>继续</button>
      <small className={styles.muted}>{worker.continueExpiresAt ? `继续能力到期：${new Date(worker.continueExpiresAt).toLocaleString()}` : "服务端将重新验证继续能力"}</small>
      {!capabilities.continueWorkerIds.includes(worker.workerId) && <small className={styles.muted}>当前不可继续，请刷新状态核验。</small>}
    </div>)}
    {dialog === "review" && <SubagentDiffDialog run={latest} selection={selection} onSelectionChange={setSelection}
      busy={busy} selectionLocked={selectionLocked || recovery} canApply={capabilities.canApply} notice={noticeContent}
      onApply={() => void operate(applySelected)} onClose={() => setDialog(null)} />}
    {dialog === "continue" && <SubagentOperationDialog title="继续 Worker" busy={busy} onClose={() => setDialog(null)}>
      <p className={styles.muted}>继续使用保留的工作树。服务端会重新验证仓库、Session 与租约；操作完成后重新捕获成果。</p>
      <label>补充指令（可选）<textarea className={styles.input} rows={5} maxLength={20_000} value={continuePrompt} disabled={busy} onChange={(event) => setContinuePrompt(event.target.value)} /></label>
      {noticeContent}
      <button type="button" className={styles.primaryButton} disabled={busy || selectionLocked || !capabilities.continueWorkerIds.includes(continueWorkerId)} onClick={() => void operate(async () => {
        const next = await refresh();
        if (!getRunCapabilities(next).continueWorkerIds.includes(continueWorkerId)) { setNotice("继续能力已失效或正在被其他操作使用。"); return; }
        acceptRun(await resumeWorker(run.runId, continueWorkerId, continuePrompt.trim() || undefined));
        setNotice("已读取继续操作的服务端结果。");
        setDialog(null);
      })}>确认继续</button>
    </SubagentOperationDialog>}
    {dialog === "discard" && <SubagentOperationDialog title="放弃成果前确认" busy={busy} onClose={() => setDialog(null)}>
      <p className={styles.warning}>放弃可能失去继续能力。当前版本会保留仍存在的工作树和审计 artifact；部分保留不等于清理完成。</p>
      <div className={styles.workerList}>{latest.workers.map((worker) => <label key={worker.workerId} className={styles.workerRow}>
        <input type="checkbox" checked={discardWorkerIds.includes(worker.workerId)} disabled={busy}
          onChange={(event) => { setDiscardWorkerIds(event.target.checked ? [...discardWorkerIds, worker.workerId] : discardWorkerIds.filter((id) => id !== worker.workerId)); setDiscardPreview(null); setDiscardAcknowledged(false); setStrongText(""); }} />
        {worker.name} · {shortWorkerId(worker.workerId)}
      </label>)}</div>
      <button type="button" className={styles.button} disabled={busy || !discardWorkerIds.length} onClick={() => void operate(() => loadDiscardPreview())}>预览放弃影响</button>
      {discardPreview && !preview && <p className={styles.warning}>Run 状态已变化，旧预览失效，请重新预览。</p>}
      {preview && <>
        <p>未应用文件：{preview.unappliedFileCount == null ? "数量未知（可能包含尚未捕获的变更）" : `${preview.unappliedFileCount} 个`}</p>
        <ul className={styles.resourceList}>{preview.workers.map((worker) => <li key={worker.workerId}>
          {latest.workers.find((candidate) => candidate.workerId === worker.workerId)?.name ?? "Worker"} · {shortWorkerId(worker.workerId)}：
          {worker.sessionCapability === "continue_will_be_lost" ? "将失去继续能力；" : "继续能力不可用或仅可保留历史；"}
          {worker.retainedResources.length ? `将保留 ${worker.retainedResources.map((resource) => resourceLabels[resource] ?? "资源").join("、")}` : "符合安全检查的资源将清理"}
          {worker.blockedBy.length > 0 && "；安全条件未满足，不能清理"}
        </li>)}</ul>
        {preview.riskCodes.length > 0 && <div className={styles.warning}>
          <ul className={styles.resourceList}>{preview.riskCodes.map((risk) => <li key={risk}>{riskLabels[risk] ?? "存在需要单独确认的数据风险"}</li>)}</ul>
          {preview.requiresStrongConfirmation && <>
            <label>输入 <code>{DISCARD_CONFIRMATION}</code> 确认风险<input className={styles.input} aria-label="高风险放弃确认文本" value={strongText} onChange={(event) => setStrongText(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} /></label>
            <button type="button" className={styles.dangerButton} disabled={busy || strongText !== DISCARD_CONFIRMATION} onClick={() => void operate(() => loadDiscardPreview(true))}>确认风险并重新预览</button>
          </>}
        </div>}
        {preview.confirmationToken && <>
          <p className={styles.muted}>确认令牌到期：{preview.tokenExpiresAt ? new Date(preview.tokenExpiresAt).toLocaleString() : "以服务端校验为准"}</p>
          <label><input type="checkbox" checked={discardAcknowledged} disabled={busy} onChange={(event) => setDiscardAcknowledged(event.target.checked)} /> 我已了解上述影响与保留资源，确认放弃所选成果。</label>
          <button type="button" className={styles.dangerButton} disabled={busy || !discardAcknowledged || Boolean(preview.tokenExpiresAt && Date.parse(preview.tokenExpiresAt) <= clock)} onClick={() => void operate(confirmDiscard)}>确认放弃</button>
        </>}
      </>}
      {discardResult && <div className={discardResult.complete ? styles.notice : styles.warning} role="status">
        <strong>{discardResult.complete ? "清理完成" : "部分资源仍保留，清理未全部完成"}</strong>
        <ul className={styles.resourceList}>{discardResult.workers.map((worker) => <li key={worker.workerId}>{shortWorkerId(worker.workerId)}：{worker.retainedResources.length ? `保留 ${worker.retainedResources.map((resource) => resourceLabels[resource] ?? "资源").join("、")}` : worker.success ? "服务端确认已清理" : "尚未完成，请重新预览"}</li>)}</ul>
      </div>}
      {noticeContent}
    </SubagentOperationDialog>}
    {dialog === "recovery" && <SubagentOperationDialog title="恢复说明" busy={busy} onClose={() => setDialog(null)}>
      {latest.recoveryState === "legacy_recovery_required" && <p>
        旧 Run 缺少可验证创建基线，不能自动应用、继续或清理。
        <a href={`/api/agent-runs/${encodeURIComponent(latest.runId)}/recovery`} download>下载只读恢复元数据</a>（不含历史 Diff 正文）。
      </p>}
      <p>成果和事务记录仍保留。结果不确定时，不应再次创建新 Apply 请求，也不要手工删除工作树或 artifact。</p>
      <ol className={styles.resourceList}>
        <li>刷新服务端状态，确认是否仍在执行、已经应用，或明确需要恢复。</li>
        <li>网络结果未知且未进入 recovery_required 时，使用“核验上次应用”：先读取 Run，必要时只重发原幂等键与原请求。</li>
        <li>已进入 recovery_required 时停止重试；审阅并下载成果后，请维护者结合该 Run 的事务与 Git 状态执行恢复核验。</li>
        <li>Discard 返回部分保留时，现有工作树和审计 artifact 不会被自动强删；刷新后可重新预览保留原因。</li>
      </ol>
      <p className={styles.muted}>Run：{latest.runId}{latest.applyTransactionId ? ` · 事务：${latest.applyTransactionId}` : ""}</p>
      {pending && <p className={styles.muted}>已保存待核验请求：{pending.payload.workerIds.length} 个 Worker，{pending.payload.files.length} 个文件。不会自动替换其幂等键。</p>}
      <div className={styles.toolbar}>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void operate(async () => { await refresh(); })}>刷新状态</button>
        {capabilities.canReview && <button type="button" className={styles.button} disabled={busy} onClick={() => setDialog("review")}>审阅成果</button>}
      </div>
      {noticeContent}
    </SubagentOperationDialog>}
  </section>;
}
