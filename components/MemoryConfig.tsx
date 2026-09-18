"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { notifyApp, subscribeToAppNotification } from "@/lib/app-notifications";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import formStyles from "./ui/Form.module.css";
import styles from "./MemoryConfig.module.css";
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
    <ModalShell
      onClose={onClose}
      layout="split"
      ariaLabel="记忆"
      title="记忆"
      subtitle="Global & Role Memory"
      sidebar={
        loading ? (
          <div className={formStyles.emptyText}>加载中...</div>
        ) : (
          scopes.map((scope) => {
            const active = scope.id === selectedId;
            return (
              <button
                key={scope.id}
                type="button"
                onClick={() => setSelectedId(scope.id)}
                aria-current={active}
                className={
                  active
                    ? `${formStyles.scopeButton} ${formStyles.scopeButtonActive}`
                    : formStyles.scopeButton
                }
              >
                <div className={formStyles.scopeRow}>
                  <span className={formStyles.scopeName}>{scope.name}</span>
                  {scope.type === "global" ? (
                    <span className={formStyles.pill}>默认</span>
                  ) : (
                    <span
                      className={
                        roleScope(scope.role) === "project"
                          ? `${formStyles.pill} ${formStyles.pillAccent}`
                          : formStyles.pill
                      }
                    >
                      {scopeLabel(roleScope(scope.role))}
                    </span>
                  )}
                </div>
                <div className={formStyles.scopeMeta}>
                  {scope.count} 条记忆 · {scope.description}
                </div>
              </button>
            );
          })
        )
      }
      actions={
        <>
          <div className={formStyles.headerMain}>
            <div className={formStyles.mainTitle}>{selected?.name ?? "记忆"}</div>
            <div className={formStyles.subtitle}>
              {selected?.type === "global"
                ? "全局记忆会注入所有角色的系统提示词。"
                : "这里编辑的就是角色窗口里的 Memory / 角色长期记忆，双方双向互通。"}
            </div>
          </div>
          <Button
            variant="secondary"
            leadingIcon="add"
            disabled={!canEdit}
            onClick={() => setDraft((items) => [...items, newItem()])}
          >
            新增记忆
          </Button>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={saving || !canEdit} onClick={save}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </>
      }
    >
      <div className={styles.mainBody}>
        {loadErrors.map((message) => (
          <div key={message} role="alert" className={formStyles.errorBox}>
            {message}。为防止覆盖现有数据，相关记忆暂不可编辑。
          </div>
        ))}
        {saveError && (
          <div role="alert" className={formStyles.errorBox}>
            保存失败：{saveError}。草稿已保留，请修复问题后重试。
          </div>
        )}
        {draft.length === 0 && (
          <div className={formStyles.emptyBox}>暂无记忆。点击「新增记忆」添加一条长期记忆。</div>
        )}
        {draft.map((item, index) => (
          <div key={item.id} className={styles.draftRow}>
            <textarea
              value={item.text}
              disabled={!canEdit}
              onChange={(event) =>
                setDraft((items) =>
                  items.map((memory, itemIndex) =>
                    itemIndex === index ? { ...memory, text: event.target.value } : memory,
                  ),
                )
              }
              rows={3}
              placeholder="输入一条长期记忆 / 用户偏好 / 背景信息..."
              className={formStyles.textarea}
            />
            <Button
              variant="danger"
              disabled={!canEdit}
              aria-label="删除这条记忆"
              onClick={() => setDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))}
            >
              删除
            </Button>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
