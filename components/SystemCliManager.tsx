"use client";
import { useState } from "react";
import type { SystemCli } from "@/lib/system-cli-types";

export function SystemCliList({ items, selected, loading, error, onSelect, onRefresh }: {
  items: SystemCli[]; selected: string | null; loading: boolean; error: string | null;
  onSelect: (cli: SystemCli) => void; onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return <section style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 8px 8px", fontSize: 11, color: "var(--text-dim)" }}>
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((current) => !current)} style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, border: 0, background: "transparent", textAlign: "left", color: "inherit", cursor: "pointer", fontWeight: 600 }}>
        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>npm CLI · {items.length}
      </button>
      <button type="button" onClick={onRefresh} disabled={loading} style={{ color: "var(--accent)" }}>{loading ? "扫描中…" : "刷新"}</button>
    </div>
    <div hidden={collapsed}>
    {error && <p role="alert" style={{ color: "#f87171", padding: 8, fontSize: 11 }}>{error}</p>}
    <div style={{ maxHeight: 280, overflowY: "auto" }}>
      {items.map((cli) => <button key={cli.path} type="button" onClick={() => onSelect(cli)} title={cli.path} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px", background: selected === cli.path ? "var(--bg-selected)" : "transparent", border: 0, borderRadius: 5, color: "var(--text)", cursor: "pointer" }}>
        <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cli.name}</span>
        <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cli.packageName}{cli.version ? ` · ${cli.version}` : ""}</span>
      </button>)}
      {!loading && !items.length && <p style={{ fontSize: 11, padding: 8, color: "var(--text-dim)" }}>未找到 npm 全局 CLI</p>}
    </div>
    </div>
  </section>;
}

export function SystemCliDetail({ cli, onDeleted }: { cli: SystemCli; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setDeleting(true); setError(null);
    try {
      const response = await fetch("/api/system-clis", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: cli.path, realPath: cli.realPath, packageName: cli.packageName }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "删除失败");
      onDeleted();
    } catch (error) { setError(error instanceof Error ? error.message : "删除失败"); }
    finally { setDeleting(false); }
  };
  return <div style={{ fontSize: 13, color: "var(--text)" }}>
    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>npm 全局 CLI</div>
    <h3 style={{ margin: "18px 0", fontFamily: "var(--font-mono)" }}>{cli.name}</h3>
    <dl style={{ lineHeight: 1.8, overflowWrap: "anywhere" }}>
      <dt style={{ color: "var(--text-dim)" }}>安装目录</dt><dd style={{ margin: "0 0 12px" }}>{cli.path}</dd>
      {cli.realPath !== cli.path && <><dt style={{ color: "var(--text-dim)" }}>实际目录</dt><dd style={{ margin: "0 0 12px" }}>{cli.realPath}</dd></>}
      {cli.packageName && <><dt style={{ color: "var(--text-dim)" }}>所属安装包</dt><dd style={{ margin: "0 0 12px" }}>{cli.packageName}</dd></>}
      {cli.version && <><dt style={{ color: "var(--text-dim)" }}>版本</dt><dd style={{ margin: "0 0 12px" }}>{cli.version}</dd></>}
      <dt style={{ color: "var(--text-dim)" }}>提供的命令</dt><dd style={{ margin: "0 0 12px" }}>{cli.commands.join("、")}</dd>
      {!!cli.bundledClis?.length && <>
        <dt style={{ color: "var(--text-dim)" }}>扩展附带的 CLI</dt>
        <dd style={{ margin: "0 0 12px" }}>{cli.bundledClis.map((bundled) => <div key={bundled.packageName}>{bundled.packageName}{bundled.version ? `@${bundled.version}` : ""} · {bundled.commands.join("、")}</div>)}</dd>
      </>}
    </dl>
    <p style={{ color: "var(--text-dim)", fontSize: 12 }}>展示当前 npm 全局安装的 CLI 工具，每个安装包只显示一项。</p>
    {!!cli.bundledClis?.length && <p style={{ color: "var(--text-dim)", fontSize: 12 }}>此 CLI 由扩展包附带，是否能在终端直接使用取决于 PATH 配置。</p>}
    {cli.removable ? <div style={{ marginTop: 24, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
      <p>{`删除会通过 npm 卸载 ${cli.packageName} 安装包。`}{!!cli.bundledClis?.length && "扩展及其附带的 CLI 会一并移除。"}</p>
      {cli.packageName && <p style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>受影响的命令：{cli.commands.join("、")}</p>}
      {confirming ? <div style={{ display: "flex", gap: 10 }}>
        <button type="button" disabled={deleting} onClick={() => void remove()} style={{ color: "#ef4444", border: "1px solid currentColor", borderRadius: 5, padding: "6px 12px" }}>{deleting ? "删除中…" : "确认删除"}</button>
        <button type="button" disabled={deleting} onClick={() => setConfirming(false)} style={{ color: "var(--text-dim)" }}>取消</button>
      </div> : <button type="button" onClick={() => setConfirming(true)} style={{ color: "#ef4444", border: "1px solid currentColor", borderRadius: 5, padding: "6px 12px" }}>删除 CLI</button>}
    </div> : <p style={{ color: "var(--text-dim)", marginTop: 24 }}>{cli.reason}</p>}
    {error && <pre role="alert" style={{ color: "#f87171", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</pre>}
  </div>;
}
