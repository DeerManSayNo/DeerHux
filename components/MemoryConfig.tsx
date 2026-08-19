"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { notifyApp, subscribeToAppNotification } from "@/lib/app-notifications";
import {
  canEditMemory,
  failedState,
  loadingState,
  readRequiredArray,
  readyState,
  type MemoryConfigLoadState,
} from "@/lib/memory-config-state";

interface MemoryItem { id: string; text: string; createdAt: string }
interface AgentRole { id: string; name: string; description: string; builtIn?: boolean; sourceInfo?: { scope?: string; filePath?: string }; blocks: Record<string, MemoryItem[]> }

type MemoryScope = { type: "global"; id: "global"; name: string; description: string; count: number } | { type: "role"; id: string; name: string; description: string; count: number; role: AgentRole };

function newItem(): MemoryItem { return { id: `local_${Date.now()}`, text: "", createdAt: new Date().toISOString() }; }
function cloneItems(items: MemoryItem[]): MemoryItem[] { return items.map((m) => ({ ...m })); }
function rolesUrl(cwd?: string): string { return cwd ? `/api/roles?cwd=${encodeURIComponent(cwd)}` : "/api/roles"; }
function roleUrl(id: string, cwd?: string): string { return cwd ? `/api/roles/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}` : `/api/roles/${encodeURIComponent(id)}`; }
function roleScope(role: AgentRole): string { return role.sourceInfo?.scope ?? (role.builtIn ? "builtIn" : "user"); }
function roleProjectCwd(role: AgentRole): string { return role.sourceInfo?.filePath?.match(/^(.+?)[/\\\\][.]agents[/\\\\]roles\\.json$/)?.[1] ?? ""; }
function scopeLabel(scope: string): string { return scope === "project" ? "项目" : scope === "user" ? "全局" : scope === "builtIn" ? "内置" : scope; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "未知错误"; }

async function fetchRequiredArray<T>(url: string, field: string): Promise<T[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
  return readRequiredArray<T>(await response.json(), field);
}

export function MemoryConfig({ onClose, cwd }: { onClose: () => void; cwd?: string }) {
  useEscapeClose(onClose);

  const [globalLoad, setGlobalLoad] = useState<MemoryConfigLoadState<MemoryItem[]>>(() => loadingState([]));
  const [rolesLoad, setRolesLoad] = useState<MemoryConfigLoadState<AgentRole[]>>(() => loadingState([]));
  const [selectedId, setSelectedId] = useState("global");
  const [draft, setDraft] = useState<MemoryItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const load = useCallback(async () => {
    setGlobalLoad((current) => loadingState(current.data));
    setRolesLoad((current) => loadingState(current.data));
    const [memoryResult, rolesResult] = await Promise.allSettled([
      fetchRequiredArray<MemoryItem>("/api/memory", "global"),
      fetchRequiredArray<AgentRole>(rolesUrl(cwd), "roles"),
    ]);

    if (memoryResult.status === "fulfilled") setGlobalLoad(readyState(memoryResult.value));
    else setGlobalLoad((current) => failedState(current.data, errorMessage(memoryResult.reason)));
    if (rolesResult.status === "fulfilled") setRolesLoad(readyState(rolesResult.value));
    else setRolesLoad((current) => failedState(current.data, errorMessage(rolesResult.reason)));
  }, [cwd]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return subscribeToAppNotification("deerhux.roles-updated", () => { load(); });
  }, [load]);

  const scopes = useMemo<MemoryScope[]>(() => [
    { type: "global", id: "global", name: "全局记忆", description: "对所有角色和所有会话生效", count: globalLoad.data.length },
    ...rolesLoad.data.map((role) => ({ type: "role" as const, id: role.id, name: role.name, description: role.description || "角色专属长期记忆", count: role.blocks?.Memory?.length ?? 0, role })),
  ], [globalLoad.data, rolesLoad.data]);

  const selected = scopes.find((scope) => scope.id === selectedId) ?? scopes[0];
  const canEdit = selected ? canEditMemory(globalLoad.status, rolesLoad.status) : false;
  const loading = globalLoad.status === "loading" || rolesLoad.status === "loading";
  const loadErrors = [
    globalLoad.status === "error" ? `全局记忆加载失败：${globalLoad.error}` : undefined,
    rolesLoad.status === "error" ? `角色加载失败：${rolesLoad.error}` : undefined,
  ].filter((message): message is string => Boolean(message));

  useEffect(() => {
    if (!selected || !canEdit) return;
    setDraft(cloneItems(selected.type === "global" ? globalLoad.data : (selected.role.blocks?.Memory ?? [])));
  }, [selectedId, selected, canEdit, globalLoad.data]);

  const save = useCallback(async () => {
    if (!selected || !canEdit) return;
    const cleaned = draft.filter((item) => item.text.trim()).map((item) => ({ ...item, text: item.text.trim() }));
    setSaving(true);
    setSaveError(undefined);
    try {
      if (selected.type === "global") {
        const response = await fetch("/api/memory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ global: cleaned }) });
        if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
        setGlobalLoad(readyState(readRequiredArray<MemoryItem>(await response.json(), "global")));
      } else {
        const blocks = { ...(selected.role.blocks ?? {}), Memory: cleaned };
        const requestCwd = roleScope(selected.role) === "project" ? (roleProjectCwd(selected.role) || cwd) : undefined;
        const response = await fetch(roleUrl(selected.role.id, requestCwd), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blocks }) });
        if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
        const payload = await response.json() as { role?: AgentRole };
        const savedRole = payload.role;
        if (!savedRole || savedRole.id !== selected.role.id) throw new Error("响应格式无效：缺少已保存的角色");
        setRolesLoad((current) => readyState(current.data.map((role) => role.id === savedRole.id ? savedRole : role)));
      }
      notifyApp("deerhux.roles-updated");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [canEdit, cwd, draft, selected]);

  return (
    <div role="dialog" aria-modal="true" aria-label="记忆" style={overlayStyle} onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} style={modalStyle}>
        <aside style={asideStyle}>
          <div style={asideHeaderStyle}>
            <div><div style={titleStyle}>记忆</div><div style={subStyle}>Global & Role Memory</div></div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {loading ? <div style={emptyStyle}>加载中...</div> : scopes.map((scope) => {
              const active = scope.id === selectedId;
              return <button key={scope.id} onClick={() => setSelectedId(scope.id)} style={{ ...scopeBtnStyle, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 800 : 600 }}>{scope.name}</span>{scope.type === "global" ? <span style={pillStyle}>默认</span> : <span style={{ ...pillStyle, color: roleScope(scope.role) === "project" ? "var(--accent)" : "var(--text-dim)" }}>{scopeLabel(roleScope(scope.role))}</span>}</div>
                <div style={scopeMetaStyle}>{scope.count} 条记忆 · {scope.description}</div>
              </button>;
            })}
          </div>
        </aside>
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={mainHeaderStyle}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{selected?.name ?? "记忆"}</div><div style={subStyle}>{selected?.type === "global" ? "全局记忆会注入所有角色的系统提示词。" : "这里编辑的就是角色窗口里的 Memory / 角色长期记忆，双方双向互通。"}</div></div>
            <button onClick={() => setDraft((items) => [...items, newItem()])} disabled={!canEdit} style={{ ...secondaryBtnStyle, opacity: canEdit ? 1 : 0.5, cursor: canEdit ? "pointer" : "not-allowed" }}>+ 新增记忆</button>
            <button onClick={save} disabled={saving || !canEdit} style={{ ...primaryBtnStyle, opacity: saving || !canEdit ? 0.5 : 1, cursor: saving || !canEdit ? "not-allowed" : "pointer" }}>{saving ? "保存中..." : "保存"}</button>
            <button onClick={onClose} style={closeBtnStyle}>×</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
            {loadErrors.map((message) => <div key={message} role="alert" style={errorBoxStyle}>{message}。为防止覆盖现有数据，相关记忆暂不可编辑。</div>)}
            {saveError && <div role="alert" style={errorBoxStyle}>保存失败：{saveError}。草稿已保留，请修复问题后重试。</div>}
            {draft.length === 0 && <div style={emptyBoxStyle}>暂无记忆。点击「新增记忆」添加一条长期记忆。</div>}
            {draft.map((item, index) => <div key={item.id} style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <textarea value={item.text} disabled={!canEdit} onChange={(event) => setDraft((items) => items.map((memory, itemIndex) => itemIndex === index ? { ...memory, text: event.target.value } : memory))} rows={3} placeholder="输入一条长期记忆 / 用户偏好 / 背景信息..." style={{ ...textareaStyle, opacity: canEdit ? 1 : 0.5 }} />
              <button onClick={() => setDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))} disabled={!canEdit} style={{ ...dangerBtnStyle, alignSelf: "stretch", opacity: canEdit ? 1 : 0.5, cursor: canEdit ? "pointer" : "not-allowed" }}>删除</button>
            </div>)}
          </div>
        </main>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 };
const modalStyle: CSSProperties = { width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg)", boxShadow: "0 18px 60px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex" };
const asideStyle: CSSProperties = { width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" };
const asideHeaderStyle: CSSProperties = { padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" };
const titleStyle: CSSProperties = { fontSize: 16, fontWeight: 800, color: "var(--text)" };
const subStyle: CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 3 };
const scopeBtnStyle: CSSProperties = { width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 10, cursor: "pointer", marginBottom: 4 };
const scopeMetaStyle: CSSProperties = { marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const pillStyle: CSSProperties = { fontSize: 10, color: "var(--accent)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 6px" };
const mainHeaderStyle: CSSProperties = { padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 };
const textareaStyle: CSSProperties = { flex: 1, boxSizing: "border-box", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13, lineHeight: 1.55, resize: "vertical", fontFamily: "inherit" };
const emptyStyle: CSSProperties = { padding: 12, color: "var(--text-muted)", fontSize: 12 };
const emptyBoxStyle: CSSProperties = { border: "1px dashed var(--border)", borderRadius: 12, padding: 18, color: "var(--text-muted)", fontSize: 13, background: "var(--bg-panel)" };
const errorBoxStyle: CSSProperties = { border: "1px solid rgba(239,68,68,0.45)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, color: "#ef4444", fontSize: 12, background: "rgba(239,68,68,0.08)" };
const primaryBtnStyle: CSSProperties = { padding: "8px 12px", borderRadius: 9, border: "1px solid var(--accent)", background: "var(--accent)", color: "white", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const secondaryBtnStyle: CSSProperties = { padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12 };
const dangerBtnStyle: CSSProperties = { padding: "8px 10px", borderRadius: 9, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.08)", color: "#ef4444", cursor: "pointer", fontSize: 12 };
const closeBtnStyle: CSSProperties = { width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 };
