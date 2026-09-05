"use client";

import { useCallback, useEffect, useMemo, useState, useLayoutEffect, useRef, type CSSProperties, type TextareaHTMLAttributes } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { subscribeToAppNotification, notifyApp } from "@/lib/app-notifications";
import { SystemPromptConfig } from "./SystemPromptConfig";
import styles from "./RoleConfig.module.css";

interface RoleSetting { id: string; text: string; createdAt: string }
interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, RoleSetting[]>;
  builtIn?: boolean;
  sourceInfo?: { scope?: string; filePath?: string };
  canDelete?: boolean;
}

const BLOCKS = ["Identity", "Soul", "Rules", "User", "Tools", "Memory"] as const;
const BLOCK_LABELS: Record<string, string> = {
  Identity: "身份与职责",
  Soul: "语气与风格",
  Rules: "行为规则",
  User: "用户偏好",
  Tools: "工具使用规则",
  Memory: "角色长期记忆",
};

const SCOPE_LABELS: Record<string, string> = { builtIn: "内置", user: "全局", project: "项目" };

function roleScope(role: AgentRole): string {
  return role.sourceInfo?.scope ?? (role.builtIn ? "builtIn" : "user");
}

function roleProjectCwd(role: AgentRole): string {
  return role.sourceInfo?.filePath?.match(/^(.+?)[/\\][.]agents[/\\]roles\.json$/)?.[1] ?? "";
}

function rolesApiUrl(cwd?: string): string {
  return cwd ? `/api/roles?cwd=${encodeURIComponent(cwd)}` : "/api/roles";
}

function projectName(cwd: string): string {
  return cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd;
}

function roleApiUrl(id: string, cwd?: string): string {
  return cwd ? `/api/roles/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd)}` : `/api/roles/${encodeURIComponent(id)}`;
}

function cloneBlocks(blocks: Record<string, RoleSetting[]>): Record<string, RoleSetting[]> {
  const next: Record<string, RoleSetting[]> = {};
  for (const block of BLOCKS) next[block] = [...(blocks?.[block] ?? [])].map((s) => ({ ...s }));
  return next;
}

function notifyRolesUpdated() {
  notifyApp("deerhux.roles-updated");
}

function ProjectList({ projects, selectedCwd, onSelect }: { projects: { cwd: string; displayName: string }[]; selectedCwd: string; onSelect: (cwd: string) => void }) {
  const [open, setOpen] = useState(false);

  useEscapeClose(() => setOpen(false), open);

  if (projects.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 2px" }}>暂无项目</div>;
  }

  const selectedProject = projects.find((project) => project.cwd === selectedCwd) ?? projects[0];
  const selectedName = selectedProject.displayName || projectName(selectedProject.cwd);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={selectedProject.cwd}
        style={{
          width: "100%",
          minHeight: 36,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >

        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{selectedName}</span>

        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 12, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>⌄</span>
      </button>

      {open && (
        <div
          className="role-project-list"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 20,
            maxHeight: 220,
            overflowY: "auto",
            padding: 6,
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-panel)",
            boxShadow: "0 12px 28px rgba(0,0,0,0.14)",
          }}
        >
          {projects.map((project) => {
            const active = project.cwd === selectedCwd;
            const name = project.displayName || projectName(project.cwd);
            return (
              <button
                key={project.cwd}
                type="button"
                onClick={() => { onSelect(project.cwd); setOpen(false); }}
                title={project.cwd}
                style={{
                  width: "100%",
                  padding: "8px 9px",
                  border: "none",
                  borderRadius: 5,
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 2,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 99, background: active ? "var(--accent)" : "var(--border)", flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: active ? 600 : 400 }}>{name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RoleConfig({ onClose, cwd, projects = [] }: { onClose: () => void; cwd?: string; projects?: { cwd: string; displayName: string }[] }) {
  const [selectedProjectCwd, setSelectedProjectCwd] = useState(() => cwd ?? projects[0]?.cwd ?? "");
  const effectiveCwd = selectedProjectCwd || cwd;
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const projectChoices = useMemo(() => {
    const byCwd = new Map<string, { cwd: string; displayName: string }>();
    for (const project of projects) if (project.cwd) byCwd.set(project.cwd, project);
    if (cwd && !byCwd.has(cwd)) byCwd.set(cwd, { cwd, displayName: projectName(cwd) });
    for (const role of roles) {
      const roleCwd = role.sourceInfo?.filePath?.match(/^(.+?)[/\\][.]agents[/\\]roles\.json$/)?.[1];
      if (roleCwd && !byCwd.has(roleCwd)) byCwd.set(roleCwd, { cwd: roleCwd, displayName: projectName(roleCwd) });
    }
    return [...byCwd.values()];
  }, [cwd, projects, roles]);
  const [selectedRoleId, setSelectedRoleId] = useState("default");
  const [search, setSearch] = useState("");
  const [editorTab, setEditorTab] = useState<"basic" | "settings">("basic");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const canEdit = editing && !saving;
  const [draft, setDraft] = useState<AgentRole | null>(null);
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [systemPromptRole, setSystemPromptRole] = useState<AgentRole | null>(null);

  useEscapeClose(() => setNewRoleOpen(false), newRoleOpen);
  useEscapeClose(onClose, !newRoleOpen && !systemPromptRole);

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newBasePrompt, setNewBasePrompt] = useState("");
  const [newScope, setNewScope] = useState<"user" | "project">(effectiveCwd ? "project" : "user");
  const [draftScope, setDraftScope] = useState<"user" | "project">("user");
  const [draftProjectCwd, setDraftProjectCwd] = useState(() => selectedProjectCwd);

  const loadRoles = useCallback(async (overrideCwd?: string) => {
    const targetCwd = overrideCwd ?? effectiveCwd;
    setLoading(true);
    try {
      const res = await fetch(rolesApiUrl(targetCwd), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { roles: AgentRole[] };
      const list = data.roles ?? [];
      setRoles(list);
      setSelectedRoleId((id) => list.some((r) => r.id === id) ? id : (list[0]?.id ?? "default"));
    } finally {
      setLoading(false);
    }
  }, [effectiveCwd]);

  useEffect(() => { loadRoles(); }, [loadRoles]);

  useEffect(() => {
    return subscribeToAppNotification("deerhux.roles-updated", () => { loadRoles(); });
  }, [loadRoles]);

  useEffect(() => {
    if (!effectiveCwd && newScope === "project") setNewScope("user");
  }, [effectiveCwd, newScope]);

  useEffect(() => {
    if (selectedProjectCwd && projectChoices.some((project) => project.cwd === selectedProjectCwd)) return;
    setSelectedProjectCwd(cwd ?? projectChoices[0]?.cwd ?? "");
  }, [cwd, projectChoices, selectedProjectCwd]);

  const selectedRole = useMemo(() => roles.find((r) => r.id === selectedRoleId) ?? roles[0] ?? null, [roles, selectedRoleId]);

  useEffect(() => {
    setEditing(false);
    if (!selectedRole) {
      setDraft(null);
      return;
    }
    setDraft({ ...selectedRole, blocks: cloneBlocks(selectedRole.blocks) });
    const scope = roleScope(selectedRole) === "project" ? "project" : "user";
    setDraftScope(scope);
    const cwdFromFile = selectedRole.sourceInfo?.filePath?.match(/^(.+?)[/\\][.]agents[/\\]roles\.json$/)?.[1] ?? "";
    setDraftProjectCwd(scope === "project" && cwdFromFile ? cwdFromFile : selectedProjectCwd);
  }, [selectedRole, selectedProjectCwd]);

  const settingCount = (role: AgentRole) => Object.values(role.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0);

  const createRole = useCallback(async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const targetCwd = newScope === "project" ? selectedProjectCwd : effectiveCwd;
      const res = await fetch(rolesApiUrl(targetCwd), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, description: newDescription, basePrompt: newBasePrompt, scope: newScope }),
      });
      if (!res.ok) return;
      const data = await res.json() as { role: AgentRole };
      setNewName(""); setNewDescription(""); setNewBasePrompt(""); setNewRoleOpen(false);
      await loadRoles();
      notifyRolesUpdated();
      setSelectedRoleId(data.role.id);
    } finally {
      setSaving(false);
    }
  }, [newName, newDescription, newBasePrompt, newScope, selectedProjectCwd, effectiveCwd, loadRoles]);

  const saveDraft = useCallback(async () => {
    if (!draft || !editing || saving) return;
    setSaving(true);
    try {
      const currentScope = selectedRole ? (roleScope(selectedRole) === "project" ? "project" : "user") : "user";
      const currentRoleCwd = selectedRole && currentScope === "project" ? (roleProjectCwd(selectedRole) || effectiveCwd) : undefined;
      const shouldMove = Boolean(selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && (draftScope !== currentScope || (draftScope === "project" && draftProjectCwd && draftProjectCwd !== currentRoleCwd)));
      const patchBody: Record<string, unknown> = {
        name: draft.name,
        description: draft.description,
        basePrompt: draft.basePrompt,
        blocks: draft.blocks,
      };
      if (shouldMove) {
        patchBody.moveRole = true;
        patchBody.scope = draftScope;
        if (draftScope === "project" && draftProjectCwd) patchBody.cwd = draftProjectCwd;
        // Set fromCwd to tell the backend where the role currently lives.
        // null → global role (search only global file).
        // Non-null string → project role (search that project file first).
        patchBody.fromCwd = currentScope === "project" ? (currentRoleCwd ?? effectiveCwd) : null;
      }
      const requestCwd = currentScope === "project" ? currentRoleCwd : undefined;
      const res = await fetch(roleApiUrl(draft.id, requestCwd), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) {
        let errMsg = `保存失败 (HTTP ${res.status})`;
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errMsg = errData.error;
        } catch { /* ignore parse error */ }
        window.alert(errMsg);
        return;
      }
      setEditing(false);
      if (shouldMove && draftScope === "project" && draftProjectCwd) {
        setSelectedProjectCwd(draftProjectCwd);
        // Reload with the target project cwd immediately, because
        // setSelectedProjectCwd won't have taken effect yet and effectiveCwd
        // still points to the old project.
        await loadRoles(draftProjectCwd);
      } else {
        await loadRoles();
      }
      notifyRolesUpdated();
    } finally {
      setSaving(false);
    }
  }, [draft, editing, saving, effectiveCwd, loadRoles, selectedRole, draftScope, draftProjectCwd]);

  const deleteSelectedRole = useCallback(async () => {
    if (!selectedRole || selectedRole.id === "default") return;
    if (!window.confirm(`确定删除角色「${selectedRole.name}」吗？角色设定库也会一起删除。`)) return;
    setSaving(true);
    try {
      const requestCwd = roleScope(selectedRole) === "project" ? (roleProjectCwd(selectedRole) || effectiveCwd) : undefined;
      const response = await fetch(roleApiUrl(selectedRole.id, requestCwd), { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        window.alert(payload?.error ?? `删除失败（HTTP ${response.status}）`);
        return;
      }
      setSelectedRoleId("default");
      await loadRoles();
      notifyRolesUpdated();
    } finally {
      setSaving(false);
    }
  }, [selectedRole, effectiveCwd, loadRoles]);

  const updateDraftBlock = (block: string, updater: (items: RoleSetting[]) => RoleSetting[]) => {
    setDraft((prev) => prev ? { ...prev, blocks: { ...prev.blocks, [block]: updater(prev.blocks[block] ?? []) } } : prev);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="角色管理"
      className={styles.overlay}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 }}
      onClick={onClose}
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)", boxShadow: "0 20px 70px rgba(0,0,0,0.2)", overflow: "hidden", display: "flex" }}
      >
        <aside className={styles.sidebar} style={{ width: 248, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)" }}>角色管理</div>
              </div>
              <button aria-label={newRoleOpen ? "收起新建角色" : "新建角色"} title="新建角色" onClick={() => setNewRoleOpen((v) => !v)} style={{ width: 30, height: 30, borderRadius: 5, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>+</button>
            </div>
            <ProjectList
              projects={projectChoices}
              selectedCwd={selectedProjectCwd}
              onSelect={setSelectedProjectCwd}
            />
            <input className={styles.search} aria-label="搜索角色" placeholder="搜索角色…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {newRoleOpen && (
            <div style={createPanelStyle}>
              <div style={createHeaderStyle}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>新建角色</div>
                  <div style={{ marginTop: 2, fontSize: 10, color: "var(--text-dim)" }}>选择全局或指定项目保存</div>
                </div>
                <span style={{ ...scopeBadgeStyle, color: newScope === "project" ? "var(--text)" : "var(--text-muted)" }}>{newScope === "project" ? "项目" : "全局"}</span>
              </div>
              <label style={fieldLabelStyle}>
                <span>角色名称</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例如：前端架构师" style={inputStyle} />
              </label>
              <label style={fieldLabelStyle}>
                <span>角色描述</span>
                <input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="一句话说明这个角色擅长什么" style={inputStyle} />
              </label>
              <label style={fieldLabelStyle}>
                <span>保存位置</span>
                <select value={newScope} onChange={(e) => setNewScope(e.target.value as "user" | "project")} style={selectStyle}>
                  <option value="user">全局角色（所有项目可用）</option>
                  <option value="project" disabled={!effectiveCwd}>项目角色（写入指定项目）</option>
                </select>
              </label>
              {newScope === "project" && (
                <label style={fieldLabelStyle}>
                  <span>目标项目</span>
                  <select value={selectedProjectCwd} onChange={(e) => setSelectedProjectCwd(e.target.value)} disabled={projectChoices.length === 0} style={selectStyle}>
                    {projectChoices.length === 0 && <option value="">无项目</option>}
                    {projectChoices.map((project) => <option key={project.cwd} value={project.cwd}>{project.displayName || projectName(project.cwd)}</option>)}
                  </select>
                  {selectedProjectCwd && <span style={helperTextStyle}>{selectedProjectCwd}</span>}
                </label>
              )}
              {!effectiveCwd && <div style={helperTextStyle}>未选择项目，暂只能创建全局角色</div>}
              <label style={fieldLabelStyle}>
                <span>基础设定</span>
                <AutoHeightTextarea value={newBasePrompt} onChange={(e) => setNewBasePrompt(e.target.value)} placeholder="可选：描述角色职责、口吻、工作方式..." rows={3} style={textareaStyle} />
              </label>
              <button onClick={createRole} disabled={!newName.trim() || saving || (newScope === "project" && !selectedProjectCwd)} style={{ ...primaryBtnStyle, width: "100%", minHeight: 36, opacity: !newName.trim() || saving || (newScope === "project" && !selectedProjectCwd) ? 0.5 : 1 }}>创建角色</button>
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {loading ? <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>加载中...</div> : (() => {
              const groups = ["project", "user", "builtIn"].map((scope) => ({ scope, items: roles.filter((role) => roleScope(role) === scope && `${role.name} ${role.description}`.toLowerCase().includes(search.trim().toLowerCase())) })).filter((g) => g.items.length);
              const selectedProjectLabel = projectChoices.find((project) => project.cwd === selectedProjectCwd)?.displayName ?? (selectedProjectCwd ? projectName(selectedProjectCwd) : "项目");
              if (!groups.length) return <div className={styles.emptySearch}>没有找到匹配的角色</div>;
              return groups.map((group) => (
                <div key={group.scope} style={{ marginBottom: 8 }}>
                  <div style={{ padding: "8px 8px 5px", fontSize: 10, fontWeight: 500, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.scope === "project" ? `项目 · ${selectedProjectLabel}` : (SCOPE_LABELS[group.scope] ?? group.scope)}</div>
                  {group.items.map((role) => {
                    const active = role.id === selectedRoleId;
                    return (
                      <button className={styles.roleItem} aria-current={active ? "true" : undefined} key={role.id} onClick={() => setSelectedRoleId(role.id)} style={{ width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 5, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", marginBottom: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 600 : 400 }}>{role.name}</span>
                          <span className={styles.listCount} title={`${settingCount(role)} 条设定`}>{settingCount(role) || ""}</span>
                        </div>
                        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{role.description || "暂未添加角色描述"}</div>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div className={styles.toolbar} style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{draft?.name ?? "角色设定库"}</div>
                {selectedRole && <span className={styles.scopeText}>{SCOPE_LABELS[roleScope(selectedRole)] ?? roleScope(selectedRole)}角色</span>}
              </div>

            </div>
            <div className={styles.toolbarActions}>
              {selectedRole && <button type="button" className={styles.iconButton} title={canEdit ? "管理系统提示词" : "点击编辑后管理系统提示词"} aria-label="管理系统提示词" disabled={!canEdit} onClick={() => setSystemPromptRole(selectedRole)}><RoleActionIcon action="prompt" /></button>}
              <button type="button" className={styles.iconButton} title={editing ? "正在编辑" : "编辑角色"} aria-label="编辑角色" aria-pressed={editing} disabled={!draft || saving || editing} onClick={() => setEditing(true)}><RoleActionIcon action="edit" /></button>
              <button type="button" className={styles.iconButton} title={saving ? "保存中…" : "保存角色"} aria-label={saving ? "保存中" : "保存角色"} aria-busy={saving} disabled={!draft || !canEdit} onClick={saveDraft}><RoleActionIcon action="save" /></button>
              <span className={styles.actionDivider} />
              <button type="button" className={styles.iconButton} title="关闭" aria-label="关闭角色管理" onClick={onClose}><RoleActionIcon action="close" /></button>
            </div>
          </div>

          {draft && <div className={styles.tabs}>
            <button aria-pressed={editorTab === "basic"} onClick={() => setEditorTab("basic")}>基本信息</button>
            <button aria-pressed={editorTab === "settings"} onClick={() => setEditorTab("settings")}>角色设定 <span>{settingCount(draft)}</span></button>
          </div>}
          {!draft ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>请选择角色</div>
          ) : (
            <div className={styles.editor} data-editing={editing}>
              {editorTab === "basic" && <>
              <section className={styles.formSection}>

              <div className={styles.fields}>
                <label className={styles.fieldRow}><span>角色名称</span><input readOnly={!canEdit} value={draft.name} onChange={(e) => setDraft((p) => p ? { ...p, name: e.target.value } : p)} style={inputStyle} /></label>
                <label className={styles.fieldRow}><span>角色描述</span><AutoHeightTextarea readOnly={!canEdit} value={draft.description} onChange={(e) => setDraft((p) => p ? { ...p, description: e.target.value } : p)} rows={2} placeholder="一句话说明角色擅长什么" style={textareaStyle} /></label>
              </div>
              </section>
              <section className={styles.formSection}>
              <label className={styles.fieldRow}><span>基础提示词<small>角色的核心职责与工作方式</small></span><AutoHeightTextarea readOnly={!canEdit} value={draft.basePrompt} onChange={(e) => setDraft((p) => p ? { ...p, basePrompt: e.target.value } : p)} rows={9} style={textareaStyle} /></label>
              </section>

              {selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && (
                <div className={styles.formSection}>
                  <div className={styles.fieldRow}><span>使用范围<small>设置角色可用的项目</small></span>
                  <div className={styles.scopeFields}>
                    <label style={{ ...fieldLabelStyle2, flex: "1 1 180px" }}>
                      <span>作用域</span>
                      <select disabled={!canEdit} value={draftScope} onChange={(e) => setDraftScope(e.target.value as "user" | "project")} style={selectStyle}>
                        <option value="user">全局（所有项目可见）</option>
                        <option value="project">项目（绑定到某个项目）</option>
                      </select>
                    </label>
                    {draftScope === "project" && (
                      <label style={{ ...fieldLabelStyle2, flex: "1 1 260px" }}>
                        <span>目标项目</span>
                        <select disabled={!canEdit} value={draftProjectCwd} onChange={(e) => setDraftProjectCwd(e.target.value)} style={selectStyle}>
                          {projectChoices.length === 0 && <option value="">无项目</option>}
                          {projectChoices.map((project) => <option key={project.cwd} value={project.cwd}>{project.displayName || projectName(project.cwd)}</option>)}
                        </select>
                        {draftProjectCwd && <span style={helperTextStyle}>{draftProjectCwd}</span>}
                      </label>
                    )}
                  </div>
                  </div>
                </div>
              )}

              {editing && selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && <div className={styles.deleteRole}><span>删除角色及其全部设定</span><button onClick={deleteSelectedRole} disabled={saving} style={dangerBtnStyle}>删除角色</button></div>}
              </>}
              {editorTab === "settings" && <>
              <p className={styles.settingsHint}>这些设定会应用到使用该角色的对话中。</p>
              {BLOCKS.map((block) => (
                <details key={`${selectedRoleId}-${block}`} className={styles.block} open={(draft.blocks[block]?.length ?? 0) > 0}>
                  <summary><span className={styles.blockTitle}>{BLOCK_LABELS[block]}</span><span className={styles.count}>{draft.blocks[block]?.length ?? 0} 条设定</span><span className={styles.chevron}>›</span></summary>
                  <div className={styles.blockBody}>
                  {(draft.blocks[block] ?? []).length === 0 && <div className={styles.emptyBlock}>暂无设定</div>}
                  {(draft.blocks[block] ?? []).map((setting, index) => (
                    <div key={setting.id} className={styles.setting}>
                      <div className={styles.settingHeader}><span>设定 {index + 1}</span><button disabled={!canEdit} hidden={!editing} aria-label={`删除${BLOCK_LABELS[block]}第 ${index + 1} 条设定`} onClick={() => updateDraftBlock(block, (items) => items.filter((_, i) => i !== index))}>删除</button></div>
                      <AutoHeightTextarea readOnly={!canEdit} aria-label={`${BLOCK_LABELS[block]}第 ${index + 1} 条设定`} placeholder={`补充${BLOCK_LABELS[block]}…`} value={setting.text} onChange={(e) => updateDraftBlock(block, (items) => items.map((s, i) => i === index ? { ...s, text: e.target.value } : s))} rows={3} style={textareaStyle} />
                    </div>
                  ))}
                  <button hidden={!editing} disabled={!canEdit} className={styles.addSetting} onClick={() => updateDraftBlock(block, (items) => [...items, { id: `local_${crypto.randomUUID()}`, text: "", createdAt: new Date().toISOString() }])}>+ 添加设定</button>
                  </div>
                </details>
              ))}
              </>}
            </div>
          )}
        </main>
      </div>
      {systemPromptRole && (
        <div onClick={(e) => e.stopPropagation()}>
          <SystemPromptConfig
            roleId={systemPromptRole.id}
            roleName={systemPromptRole.name}
            cwd={effectiveCwd}
            onClose={() => setSystemPromptRole(null)}
          />
        </div>
      )}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  marginBottom: 0,
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  fontWeight: 400,
  fontFamily: "inherit",
  minWidth: 0,
  lineHeight: 1.6,
  outlineOffset: 2,

};

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: "none",
  cursor: "pointer",
  paddingRight: 32,
  backgroundImage: "linear-gradient(45deg, transparent 50%, var(--text-dim) 50%), linear-gradient(135deg, var(--text-dim) 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 17px) 50%, calc(100% - 12px) 50%",
  backgroundSize: "5px 5px, 5px 5px",
  backgroundRepeat: "no-repeat",
};

const createPanelStyle: CSSProperties = {
  padding: 12,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  background: "var(--bg-panel)",
};

const createHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "2px 1px 4px",
};

const scopeBadgeStyle: CSSProperties = {
  flexShrink: 0,
  padding: "2px 6px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "color-mix(in srgb, var(--bg-panel) 78%, var(--bg))",
  fontSize: 10,
  fontWeight: 500,
  lineHeight: 1.2,
};

const fieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 11,
  fontWeight: 500,
  color: "var(--text-muted)",
};

const fieldLabelStyle2: CSSProperties = {
  ...fieldLabelStyle,
  gap: 4,
};

const helperTextStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 10,
  lineHeight: 1.35,
  color: "var(--text-dim)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "none",
  overflow: "hidden",
  lineHeight: 1.5,
  fontFamily: "inherit",
};

const primaryBtnStyle: CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: 5,
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 550,
};

const dangerBtnStyle: CSSProperties = {
  whiteSpace: "nowrap",
  flexShrink: 0,
  padding: "7px 10px",
  border: "1px solid rgba(239,68,68,0.35)",
  borderRadius: 5,
  background: "rgba(239,68,68,0.06)",
  color: "#ef4444",
  cursor: "pointer",
  fontSize: 12,
};

/** Re-measure on content changes, width changes, and collapsed sections opening. */
function AutoHeightTextarea({ value, style, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element || element.getClientRects().length === 0) return;
    element.style.height = "auto";
    const borderHeight = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borderHeight}px`;
  }, []);

  useLayoutEffect(resize, [value, resize]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let lastWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  return <textarea {...props} ref={ref} value={value} rows={1} style={{ ...style, resize: "none", overflow: "hidden" }} />;
}

function RoleActionIcon({ action }: { action: "edit" | "save" | "close" | "prompt" }) {
  const paths = {
    edit: "M16 3a2.1 2.1 0 0 1 3 3L8 17l-4 1 1-4L16 3Z M14 5l3 3",
    save: "M5 3h12l4 4v14H3V3h2Z M7 3v6h9V3 M7 21v-8h10v8",
    close: "m6 6 12 12 M18 6 6 18",
    prompt: "M8 4H4v16h16v-4 M12 4h8v8 M13 11l7-7 M8 12h2 M8 16h8",
  };
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[action]} /></svg>;
}
