"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { getClientApiErrorMessage, readControlPlaneJson, writeControlPlaneJson } from "@/lib/client-api";

type McpTransport = "stdio" | "sse" | "http";
type McpStdioFraming = "auto" | "newline" | "content-length";
interface McpServerConfig { id: string; name: string; enabled: boolean; transport: McpTransport; command?: string; args?: string[]; stdioFraming?: McpStdioFraming; url?: string; env?: Record<string, string>; description?: string; createdAt: string; updatedAt: string }
interface McpServerStatus { id: string; name: string; transport: McpTransport; status: "connected" | "error" | "unsupported"; toolCount: number; errorMessage?: string; sourcePath?: string; stdioFraming?: McpStdioFraming }

function makeServer(): McpServerConfig { return { id: `local_${Date.now()}`, name: "新 MCP 服务", enabled: true, transport: "stdio", command: "", args: [], stdioFraming: "auto", url: "", env: {}, description: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
function argsText(s: McpServerConfig) { return (s.args ?? []).join("\n"); }
function envText(s: McpServerConfig) { return Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"); }
function parseLines(text: string) { return text.split(/\n+/).map((v) => v.trim()).filter(Boolean); }
function parseEnv(text: string) { return Object.fromEntries(text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => { const i = line.indexOf("="); return i >= 0 ? [line.slice(0, i).trim(), line.slice(i + 1).trim()] : [line, ""]; })); }

export function McpConfig({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  useEscapeClose(onClose);

  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [loadMessage, setLoadMessage] = useState<string>("");
  const [testStatuses, setTestStatuses] = useState<McpServerStatus[]>([]);
  const [testMessage, setTestMessage] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadState("loading");
    setLoadMessage("");
    try {
      const payload = await readControlPlaneJson<{ servers?: McpServerConfig[] }>("/api/mcp-config", { cache: "no-store" });
      const list = payload.servers ?? [];
      setServers(list); setSelectedId((id) => id && list.some((s) => s.id === id) ? id : (list[0]?.id ?? null));
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setLoadMessage(getClientApiErrorMessage(error));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => servers.find((s) => s.id === selectedId) ?? servers[0] ?? null, [selectedId, servers]);
  const canMutate = loadState === "ready";
  const updateSelected = (patch: Partial<McpServerConfig>) => {
    if (!canMutate) return;
    setServers((list) => list.map((s) => s.id === selected?.id ? { ...s, ...patch } : s));
  };
  const add = () => {
    if (!canMutate) return;
    const server = makeServer();
    setServers((list) => [...list, server]);
    setSelectedId(server.id);
  };
  const remove = () => {
    if (!canMutate || !selected) return;
    setServers((list) => list.filter((server) => server.id !== selected.id));
    setSelectedId(servers.find((server) => server.id !== selected.id)?.id ?? null);
  };
  const save = useCallback(async () => {
    if (!canMutate) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const payload = await writeControlPlaneJson<{ servers: McpServerConfig[]; reloadResults?: Array<{ ok: boolean; skipped?: boolean; error?: string }> }>("/api/mcp-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ servers }) });
      const list = payload.servers;
      setServers(list); setSelectedId((id) => id && list.some((s) => s.id === id) ? id : (list[0]?.id ?? null));
      const reloadResults = payload.reloadResults ?? [];
      if (reloadResults.length === 0) setSaveMessage("已保存。新会话将自动使用最新 MCP 配置。");
      else {
        const ok = reloadResults.filter((r) => r.ok).length;
        const skipped = reloadResults.filter((r) => r.skipped).length;
        const failed = reloadResults.filter((r) => r.error).length;
        setSaveMessage(`已保存。MCP 热刷新：成功 ${ok}，跳过 ${skipped}，失败 ${failed}。`);
      }
    } catch (error) {
      setSaveMessage(getClientApiErrorMessage(error));
    } finally { setSaving(false); }
  }, [canMutate, servers]);

  const testConnection = useCallback(async () => {
    if (!canMutate) return;
    setTesting(true);
    setTestMessage("");
    setTestStatuses([]);
    try {
      const payload = await writeControlPlaneJson<{ statuses?: McpServerStatus[]; toolCount?: number; error?: string }>("/api/mcp-config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, servers }) });
      const statuses = payload.statuses ?? [];
      setTestStatuses(statuses);
      const connected = statuses.filter((s) => s.status === "connected").length;
      const errors = statuses.filter((s) => s.status === "error").length;
      const unsupported = statuses.filter((s) => s.status === "unsupported").length;
      setTestMessage(`测试完成：连接 ${connected}，错误 ${errors}，未支持 ${unsupported}，工具 ${payload.toolCount ?? 0} 个。`);
    } catch (error) {
      setTestMessage(`测试失败：${getClientApiErrorMessage(error)}`);
    } finally { setTesting(false); }
  }, [canMutate, cwd, servers]);

  return <div role="dialog" aria-modal="true" aria-label="MCP" style={overlayStyle} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
      <aside style={asideStyle}>
        <div style={asideHeaderStyle}><div><div style={titleStyle}>MCP</div><div style={subStyle}>Model Context Protocol</div></div><button onClick={add} disabled={!canMutate} style={{ ...smallBtnStyle, opacity: canMutate ? 1 : 0.5, cursor: canMutate ? "pointer" : "not-allowed" }}>+</button></div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>{loading ? <div style={emptyStyle}>加载中...</div> : servers.length === 0 ? <div style={emptyStyle}>暂无 MCP 服务</div> : servers.map((server) => {
          const active = server.id === selected?.id;
          return <button key={server.id} onClick={() => setSelectedId(server.id)} style={{ ...scopeBtnStyle, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ width: 8, height: 8, borderRadius: 99, background: server.enabled ? "#22c55e" : "var(--text-dim)" }} /><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 800 : 600 }}>{server.name}</span><span style={pillStyle}>{server.transport}</span></div>
            <div style={scopeMetaStyle}>{server.description || (server.transport === "stdio" ? server.command || "未配置命令" : server.url || "未配置 URL")}</div>
          </button>;
        })}</div>
      </aside>
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={mainHeaderStyle}><div style={{ flex: 1 }}><div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{selected?.name ?? "MCP 服务配置"}</div><div style={subStyle}>配置会保存到 ~/.deerhux/agent/mcp.json；启用的 stdio 服务会在 Agent 会话启动时注入为工具。</div></div>{selected && <button onClick={remove} disabled={!canMutate} style={{ ...dangerBtnStyle, opacity: canMutate ? 1 : 0.5, cursor: canMutate ? "pointer" : "not-allowed" }}>删除</button>}<button onClick={testConnection} disabled={testing || !canMutate} style={{ ...secondaryBtnStyle, opacity: testing || !canMutate ? 0.5 : 1, cursor: testing || !canMutate ? "not-allowed" : "pointer" }}>{testing ? "测试中..." : "测试连接"}</button><button onClick={save} disabled={saving || !canMutate} style={{ ...primaryBtnStyle, opacity: saving || !canMutate ? 0.5 : 1, cursor: saving || !canMutate ? "not-allowed" : "pointer" }}>{saving ? "保存中..." : "保存"}</button><button onClick={onClose} style={closeBtnStyle}>×</button></div>
        {!selected ? <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}><span style={emptyStyle}>{loadMessage || "暂无 MCP 服务。"}</span><button onClick={add} disabled={!canMutate} style={{ ...primaryBtnStyle, opacity: canMutate ? 1 : 0.5, cursor: canMutate ? "pointer" : "not-allowed" }}>创建第一个 MCP 服务</button></div> : <fieldset disabled={!canMutate} style={{ flex: 1, minWidth: 0, margin: 0, padding: 0, border: "none", overflowY: "auto" }}><div style={{ padding: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><label style={labelStyle}>服务名称<input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} style={inputStyle} /></label><label style={labelStyle}>传输类型<select value={selected.transport} onChange={(e) => updateSelected({ transport: e.target.value as McpTransport })} style={inputStyle}><option value="stdio">stdio</option><option value="sse">sse</option><option value="http">http</option></select></label></div>
          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, margin: "4px 0 12px" }}><input type="checkbox" checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />启用该服务</label>
          <label style={labelStyle}>描述<input value={selected.description ?? ""} onChange={(e) => updateSelected({ description: e.target.value })} style={inputStyle} /></label>
          {selected.transport === "stdio" ? <><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><label style={labelStyle}>Command<input value={selected.command ?? ""} onChange={(e) => updateSelected({ command: e.target.value })} placeholder="例如：npx" style={inputStyle} /></label><label style={labelStyle}>stdio framing<select value={selected.stdioFraming ?? "auto"} onChange={(e) => updateSelected({ stdioFraming: e.target.value as McpStdioFraming })} style={inputStyle}><option value="auto">auto（推荐）</option><option value="newline">newline（现代 MCP）</option><option value="content-length">content-length（旧服务）</option></select></label></div><label style={labelStyle}>Args（每行一个参数）<textarea value={argsText(selected)} onChange={(e) => updateSelected({ args: parseLines(e.target.value) })} rows={5} placeholder="-y\n@modelcontextprotocol/server-filesystem\n/Users/me/project" style={textareaStyle} /></label></> : <label style={labelStyle}>URL<input value={selected.url ?? ""} onChange={(e) => updateSelected({ url: e.target.value })} placeholder="https://..." style={inputStyle} /></label>}
          <label style={labelStyle}>环境变量（每行 KEY=VALUE）<textarea value={envText(selected)} onChange={(e) => updateSelected({ env: parseEnv(e.target.value) })} rows={5} placeholder="API_KEY=..." style={textareaStyle} /></label>
          {loadMessage && <div role="alert" style={hintStyle}>加载失败：{loadMessage}。为防止覆盖现有配置，暂不可编辑。</div>}
          {testMessage && <div style={hintStyle}>{testMessage}</div>}
          {testStatuses.length > 0 && <div style={{ display: "grid", gap: 8, marginTop: 10 }}>{testStatuses.map((status) => <div key={status.id} style={{ ...statusRowStyle, borderColor: status.status === "connected" ? "rgba(34,197,94,0.35)" : status.status === "error" ? "rgba(239,68,68,0.35)" : "var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: 99, background: status.status === "connected" ? "#22c55e" : status.status === "error" ? "#ef4444" : "#f59e0b" }} /><strong>{status.name}</strong><span style={pillStyle}>{status.transport}</span><span style={pillStyle}>{status.status}</span><span style={pillStyle}>{status.toolCount} tools</span>{status.stdioFraming && <span style={pillStyle}>{status.stdioFraming}</span>}</div>
            {status.errorMessage && <div style={{ marginTop: 6, color: "#f87171", fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap" }}>{status.errorMessage}</div>}
          </div>)}</div>}
          {saveMessage && <div style={hintStyle}>{saveMessage}</div>}
        </div></fieldset>}
      </main>
    </div>
  </div>;
}

const overlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 };
const modalStyle: CSSProperties = { width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg)", boxShadow: "0 18px 60px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex" };
const asideStyle: CSSProperties = { width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" };
const asideHeaderStyle: CSSProperties = { padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const titleStyle: CSSProperties = { fontSize: 16, fontWeight: 800, color: "var(--text)" };
const subStyle: CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3 };
const scopeBtnStyle: CSSProperties = { width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 10, cursor: "pointer", marginBottom: 4 };
const scopeMetaStyle: CSSProperties = { marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const pillStyle: CSSProperties = { fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 6px" };
const mainHeaderStyle: CSSProperties = { padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 };
const labelStyle: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 12 };
const inputStyle: CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 6, padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 };
const textareaStyle: CSSProperties = { ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono)", fontSize: 12 };
const emptyStyle: CSSProperties = { padding: 12, color: "var(--text-muted)", fontSize: 12 };
const smallBtnStyle: CSSProperties = { width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 18 };
const primaryBtnStyle: CSSProperties = { padding: "8px 12px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--accent)", color: "white", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const secondaryBtnStyle: CSSProperties = { padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const dangerBtnStyle: CSSProperties = { padding: "8px 10px", borderRadius: 9, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", color: "#ef4444", cursor: "pointer", fontSize: 12 };
const closeBtnStyle: CSSProperties = { width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 };
const hintStyle: CSSProperties = { marginTop: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 };
const statusRowStyle: CSSProperties = { padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 };
