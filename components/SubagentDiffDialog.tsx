"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CollaborationRunSnapshot } from "@/lib/parallel-agent/collaboration-types";
import { diffDownloadUrl, fetchDiffPatch, fetchDiffSummary, runSelectionKey, type DiffSummary } from "@/lib/subagent-review-client";
import styles from "./SubagentReview.module.css";

export interface SubagentReviewSelection {
  key: string;
  workerIds: string[];
  files: string[];
}

export function SubagentOperationDialog({ title, busy, onClose, children }: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    const cancel = (event: Event) => {
      event.preventDefault();
      if (!busy) onClose();
    };
    dialog?.addEventListener("cancel", cancel);
    return () => { dialog?.removeEventListener("cancel", cancel); };
  }, [busy, onClose]);
  return <dialog
    ref={dialogRef}
    aria-labelledby={titleId}
    aria-busy={busy}
    className={styles.dialog}
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
      )).filter((element) => element.getClientRects().length > 0);
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
  >
    <header className={styles.dialogHeader}>
      <h3 id={titleId}>{title}</h3>
      <button type="button" className={styles.iconButton} title="关闭对话框" aria-label="关闭对话框" disabled={busy} onClick={onClose}>×</button>
    </header>
    <div className={styles.dialogBody}>{children}</div>
  </dialog>;
}

export function shortWorkerId(workerId: string): string {
  return workerId.length > 16 ? `${workerId.slice(0, 6)}…${workerId.slice(-8)}` : workerId;
}

export function formatArtifactBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const FILE_CHANGE_LABELS = { new: "＋ 新建", modified: "✎ 修改", deleted: "− 删除", renamed: "↪ 重命名", typechange: "⇄ 类型变更" } as const;
function fileSizeLabel(file: DiffSummary["files"][number]): string {
  const exact = (bytes: number | null | undefined) => bytes == null ? "大小未知" : `${bytes.toLocaleString()} B`;
  if (!file.changeKind) return exact(file.bytes);
  if (file.changeKind === "deleted") return `删除前 ${exact(file.oldBytes)} → 已删除`;
  if (file.changeKind === "new") return `新增 ${exact(file.newBytes)}`;
  return `旧 ${exact(file.oldBytes)} → 新 ${exact(file.newBytes)}`;
}

interface Props {
  run: CollaborationRunSnapshot;
  selection: SubagentReviewSelection;
  onSelectionChange: (selection: SubagentReviewSelection) => void;
  busy: boolean;
  selectionLocked: boolean;
  canApply: boolean;
  notice?: ReactNode;
  onApply: () => void;
  onClose: () => void;
}

export function SubagentDiffDialog(props: Props) {
  return <SubagentOperationDialog title="审阅并应用成果" busy={props.busy} onClose={props.onClose}>
    <DiffReviewContents key={runSelectionKey(props.run)} {...props} />
  </SubagentOperationDialog>;
}

function DiffReviewContents({ run, selection, onSelectionChange, busy, selectionLocked, canApply, notice, onApply }: Props) {
  const selectionKey = runSelectionKey(run);
  const selectedWorkers = selection.key === selectionKey ? selection.workerIds : [];
  const selectedFiles = selection.key === selectionKey ? selection.files : [];
  const [activeWorkerId, setActiveWorkerId] = useState(run.workers.find((worker) => worker.patchSha256 && !worker.captureErrorCode)?.workerId ?? run.workers[0]?.workerId ?? "");
  const [summaries, setSummaries] = useState<Record<string, DiffSummary>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [canVerifyText, setCanVerifyText] = useState(false);
  const requestRef = useRef(0);
  const activeWorker = run.workers.find((worker) => worker.workerId === activeWorkerId);
  const summary = summaries[activeWorkerId];
  const disabled = busy || selectionLocked;
  const selectedWorkerKey = JSON.stringify(selectedWorkers);
  const expectedCaptureKey = JSON.stringify(run.workers.map((worker) => [worker.workerId, worker.patchSha256]));

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) setCanVerifyText(Boolean(globalThis.crypto?.subtle)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeWorkerId) return;
    const requestId = ++requestRef.current;
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(activeWorkerId);
      setError(null);
      try {
        const expected = new Map<string, string | null>(JSON.parse(expectedCaptureKey));
        const requested = [...new Set([activeWorkerId, ...JSON.parse(selectedWorkerKey) as string[]])];
        const results = await Promise.all(requested.map(async (workerId) => {
          const result = await fetchDiffSummary(run.runId, workerId);
          if (expected.get(workerId) && result.artifact?.sha256 !== expected.get(workerId)) throw new Error("capture changed");
          return [workerId, result] as const;
        }));
        if (!cancelled && requestRef.current === requestId) setSummaries((previous) => ({ ...previous, ...Object.fromEntries(results) }));
      } catch {
        if (!cancelled && requestRef.current === requestId) setError("无法读取当前捕获摘要。成果可能已变化，请关闭审阅并刷新状态后重试。");
      } finally {
        if (!cancelled && requestRef.current === requestId) setLoading(null);
      }
    });
    return () => { cancelled = true; };
  }, [activeWorkerId, run.runId, selectedWorkerKey, expectedCaptureKey]);

  function updateSelection(workerIds: string[], files: string[]) {
    onSelectionChange({ key: selectionKey, workerIds, files: [...new Set(files)] });
  }

  function toggleWorker(workerId: string, checked: boolean) {
    const capturedFiles = summaries[workerId]?.files.map((file) => file.path);
    if (!capturedFiles) { setActiveWorkerId(workerId); return; }
    const workerIds = checked ? run.workers.filter((worker) => selectedWorkers.includes(worker.workerId) || worker.workerId === workerId).map((worker) => worker.workerId)
      : selectedWorkers.filter((id) => id !== workerId);
    const available = new Set(workerIds.flatMap((id) => summaries[id]?.files.map((file) => file.path) ?? []));
    const files = checked ? [...selectedFiles, ...capturedFiles] : selectedFiles.filter((file) => available.has(file));
    updateSelection(workerIds, files);
  }

  const fileOwners = new Map<string, string[]>();
  for (const workerId of selectedWorkers) {
    for (const file of summaries[workerId]?.files ?? []) fileOwners.set(file.path, [...(fileOwners.get(file.path) ?? []), workerId]);
  }
  const overlaps = [...fileOwners.entries()].filter(([file, owners]) => selectedFiles.includes(file) && owners.length > 1).map(([file]) => file);
  const allAvailableFiles = [...fileOwners.keys()];
  const allSelectedReady = selectedWorkers.every((workerId) => Boolean(summaries[workerId]));

  async function reviewAll() {
    if (disabled || loading) return;
    setLoading("all");
    setError(null);
    try {
      const results = await Promise.all(run.workers.filter((worker) => worker.patchSha256 && !worker.captureErrorCode).map(async (worker) => {
        const result = await fetchDiffSummary(run.runId, worker.workerId);
        if (result.artifact?.sha256 !== worker.patchSha256) throw new Error("capture changed");
        return [worker.workerId, result] as const;
      }));
      setSummaries((previous) => ({ ...previous, ...Object.fromEntries(results) }));
      const available = results.filter(([, result]) => result.artifact?.available && result.files.length > 0);
      updateSelection(available.map(([workerId]) => workerId), available.flatMap(([, result]) => result.files.map((file) => file.path)));
    } catch {
      setError("无法验证全部成果，未更改选择。请刷新 Run 后重新审阅。");
    } finally { setLoading(null); }
  }

  async function loadPatch() {
    if (!summary?.artifact?.inlineAvailable || summary.artifact.containsBinary || loading || !canVerifyText) return;
    const workerId = activeWorkerId;
    setLoading(workerId);
    setError(null);
    try {
      // Fetch the summary again before the text request so stale metadata cannot
      // turn a binary/large artifact into an inline preview.
      const fresh = await fetchDiffSummary(run.runId, workerId);
      if (fresh.artifact?.sha256 !== summary.artifact.sha256 || !fresh.artifact.inlineAvailable || fresh.artifact.containsBinary) throw new Error("capture changed");
      const patch = await fetchDiffPatch(run.runId, workerId);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(patch))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== fresh.artifact.sha256) throw new Error("capture changed during text fetch");
      setPatches((previous) => ({ ...previous, [workerId]: patch }));
    } catch {
      setError("正文不可预览或成果已变化。请刷新摘要；大文件和二进制请使用下载。");
    } finally { setLoading(null); }
  }

  return <>
    <p className={styles.muted}>先选择 Worker，再选择文件。文件选择按路径作用于所有所选 Worker；应用前服务端会检查冲突。</p>
    <div className={styles.toolbar}>
      <button type="button" className={styles.button} disabled={disabled || Boolean(loading)} onClick={() => void reviewAll()}>审阅全部成果</button>
      <span className={styles.muted}>按需加载全部摘要并全选，仍须点击“应用所选文件”确认应用。</span>
      {loading === "all" && <span role="status">正在加载全部成果摘要…</span>}
    </div>
    {notice}
    {selectionLocked && <p className={styles.warning}>上次应用结果尚未确定，选择已锁定。请先核验上次应用；不会生成新的幂等键。</p>}
    <div className={styles.reviewGrid}>
      <div className={styles.workerList} aria-label="Worker 列表">
        {run.workers.map((worker) => <div key={worker.workerId} className={styles.workerRow}>
          <input type="checkbox" aria-label={`选择 Worker ${worker.name} (${shortWorkerId(worker.workerId)})`}
            checked={selectedWorkers.includes(worker.workerId)}
            disabled={disabled || !summaries[worker.workerId]?.artifact?.available || Boolean(worker.captureErrorCode)}
            onChange={(event) => toggleWorker(worker.workerId, event.target.checked)} />
          <button type="button" className={styles.workerButton} aria-pressed={activeWorkerId === worker.workerId}
            onClick={() => setActiveWorkerId(worker.workerId)} disabled={busy}>
            <span>{worker.title ?? worker.name}</span><small>{shortWorkerId(worker.workerId)}</small>
          </button>
        </div>)}
      </div>
      <section className={styles.filePanel} aria-label="捕获文件">
        <h4>{activeWorker?.title ?? activeWorker?.name ?? "没有 Worker"}</h4>
        {loading === activeWorkerId && <p role="status">正在加载审阅数据…</p>}
        {error && <p role="alert" className={styles.warning}>{error}</p>}
        {summary && <>
          <p className={styles.muted}>{summary.files.length} 个文件 · {summary.files.filter((file) => file.type === "binary").length} 个二进制文件 · artifact {formatArtifactBytes(summary.artifact?.bytes)}</p>
          {!selectedWorkers.includes(activeWorkerId) && <button type="button" className={styles.button}
            disabled={disabled || !summary.artifact?.available || Boolean(activeWorker?.captureErrorCode)}
            onClick={() => toggleWorker(activeWorkerId, true)}>选择此 Worker 的文件</button>}
          <div className={styles.fileList}>
            {summary.files.map((file) => <label key={file.path} className={styles.fileRow} title={file.path}>
              <input type="checkbox" aria-label={`选择文件 ${file.path}`} checked={selectedWorkers.includes(activeWorkerId) && selectedFiles.includes(file.path)}
                disabled={disabled || !selectedWorkers.includes(activeWorkerId)}
                onChange={(event) => updateSelection(selectedWorkers, event.target.checked ? [...selectedFiles, file.path] : selectedFiles.filter((selected) => selected !== file.path))} />
              <span className={styles.fileName}>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span>
              <small>{file.changeKind ? FILE_CHANGE_LABELS[file.changeKind] : "变更类型未知"} · {file.type === "binary" ? "二进制" : "文本"} · {fileSizeLabel(file)}
                {file.addedLines != null && file.deletedLines != null && ` · +${file.addedLines}/−${file.deletedLines} 行`}</small>
            </label>)}
            {summary.files.length === 0 && <p className={styles.muted}>没有捕获的文件变更。</p>}
          </div>
          <p className={styles.muted}>大小为捕获时 Git blob 的精确字节数（符号链接按链接文本计）；不是当前磁盘占用。删除显示旧大小，旧版捕获或非 blob 对象显示未知；二进制不计算增删行数。</p>
          {summary.artifact?.available && <div className={styles.toolbar}>
            <a className={styles.button} href={diffDownloadUrl(run.runId, activeWorkerId)} download>下载此 Worker 的 diff</a>
            {summary.artifact.inlineAvailable && !summary.artifact.containsBinary && canVerifyText
              ? <button type="button" className={styles.button} disabled={Boolean(loading) || busy} onClick={() => void loadPatch()}>加载 unified diff</button>
              : <span className={styles.muted}>{summary.artifact.containsBinary ? "含二进制内容，仅提供下载" : !summary.artifact.inlineAvailable ? "超过 1 MiB 预览上限，仅提供下载" : "当前连接不支持正文安全校验，仅提供下载；可使用 HTTPS 或 localhost 预览。"}</span>}
          </div>}
          {patches[activeWorkerId] !== undefined && <pre className={styles.diffText} tabIndex={0} aria-label="Unified diff 正文">{patches[activeWorkerId] || "空 diff"}</pre>}
        </>}
      </section>
    </div>
    {overlaps.length > 0 && <div className={styles.warning} role="status">
      <strong>所选 Worker 修改了同一路径，可能冲突：</strong>
      <ul>{overlaps.map((file) => <li key={file} className={styles.fileName}>{file}</li>)}</ul>
      服务端检查通过前不会显示为已应用。
    </div>}
    <footer className={styles.toolbar}>
      <button type="button" className={styles.button} disabled={disabled || !selectedWorkers.length || !allSelectedReady} onClick={() => updateSelection(selectedWorkers, allAvailableFiles)}>全选文件</button>
      <button type="button" className={styles.button} disabled={disabled || !selectedFiles.length} onClick={() => updateSelection(selectedWorkers, [])}>清空选择</button>
      <span className={styles.muted}>已选 {selectedWorkers.length} 个 Worker / {selectedFiles.length} 个路径</span>
      {!allSelectedReady && <span className={styles.muted}>正在核验之前所选 Worker 的摘要，全选暂不可用。</span>}
      <button type="button" className={styles.primaryButton} title="应用所选文件到主工作区" disabled={disabled || !canApply || !selectedWorkers.length || !selectedFiles.length} onClick={onApply}>应用所选文件</button>
    </footer>
  </>;
}
