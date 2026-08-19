"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { subscribeToAppNotification, notifyApp } from "@/lib/app-notifications";
import { SystemPromptConfig } from "./SystemPromptConfig";

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
          minHeight: 40,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 11,
          background: "var(--bg)",
          color: "var(--text)",
          cursor: "pointer",
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--accent)", flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 800 }}>{selectedName}</span>
          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{selectedProject.cwd}</span>
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
                  borderRadius: 9,
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
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: active ? 800 : 600 }}>{name}</span>
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
    if (!draft) return;
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
  }, [draft, effectiveCwd, loadRoles, selectedRole, draftScope, draftProjectCwd]);

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
      aria-label="角色"
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", padding: 20 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(1040px, calc(100vw - 40px))", height: "min(780px, calc(100vh - 40px))", border: "1px solid var(--border)", borderRadius: 16, background: "var(--bg)", boxShadow: "0 18px 60px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex" }}
      >
        <aside style={{ width: 280, borderRight: "1px solid var(--border)", background: "var(--bg-panel)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)" }}>角色</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>Agent Profile</div>
              </div>
              <button onClick={() => setNewRoleOpen((v) => !v)} style={{ width: 30, height: 30, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 18 }}>+</button>
            </div>
            <ProjectList
              projects={projectChoices}
              selectedCwd={selectedProjectCwd}
              onSelect={setSelectedProjectCwd}
            />
          </div>
          {newRoleOpen && (
            <div style={createPanelStyle}>
              <div style={createHeaderStyle}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 850, color: "var(--text)" }}>新建角色</div>
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
                <textarea value={newBasePrompt} onChange={(e) => setNewBasePrompt(e.target.value)} placeholder="可选：描述角色职责、口吻、工作方式..." rows={3} style={textareaStyle} />
              </label>
              <button onClick={createRole} disabled={!newName.trim() || saving || (newScope === "project" && !selectedProjectCwd)} style={{ ...primaryBtnStyle, width: "100%", minHeight: 36, opacity: !newName.trim() || saving || (newScope === "project" && !selectedProjectCwd) ? 0.5 : 1 }}>创建角色</button>
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
            {loading ? <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>加载中...</div> : (() => {
              const groups = ["project", "user", "builtIn"].map((scope) => ({ scope, items: roles.filter((role) => roleScope(role) === scope) })).filter((g) => g.items.length);
              const selectedProjectLabel = projectChoices.find((project) => project.cwd === selectedProjectCwd)?.displayName ?? (selectedProjectCwd ? projectName(selectedProjectCwd) : "项目");
              return groups.map((group) => (
                <div key={group.scope} style={{ marginBottom: 8 }}>
                  <div style={{ padding: "8px 8px 5px", fontSize: 10, fontWeight: 700, color: group.scope === "project" ? "var(--accent)" : "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{group.scope === "project" ? `项目 · ${selectedProjectLabel}` : (SCOPE_LABELS[group.scope] ?? group.scope)}</div>
                  {group.items.map((role) => {
                    const active = role.id === selectedRoleId;
                    const scope = roleScope(role);
                    return (
                      <button key={role.id} onClick={() => setSelectedRoleId(role.id)} style={{ width: "100%", display: "block", textAlign: "left", padding: "10px 11px", border: "none", borderRadius: 10, background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", marginBottom: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: active ? 700 : 500 }}>{role.name}</span>
                          <span style={{ ...scopeBadgeStyle, color: scope === "project" ? "var(--accent)" : "var(--text-dim)" }}>{scope === "project" ? (projectName(roleProjectCwd(role)) || SCOPE_LABELS[scope]) : (SCOPE_LABELS[scope] ?? scope)}</span>
                        </div>
                        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{settingCount(role)} 条设定 · {role.description || "无描述"}</div>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{draft?.name ?? "角色设定库"}</div>
                {selectedRole && <span style={{ ...scopeBadgeStyle, color: roleScope(selectedRole) === "project" ? "var(--accent)" : "var(--text-dim)" }}>{SCOPE_LABELS[roleScope(selectedRole)] ?? roleScope(selectedRole)}</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>按全局 / 所选项目管理会跨 session 复用的角色设定</div>
            </div>
            {selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && <button onClick={deleteSelectedRole} disabled={saving} style={dangerBtnStyle}>删除角色</button>}
            {selectedRole && <button onClick={() => setSystemPromptRole(selectedRole)} style={secondaryBtnStyle}>System Prompt 管理</button>}
            <button onClick={saveDraft} disabled={!draft || saving} style={{ ...primaryBtnStyle, opacity: !draft || saving ? 0.5 : 1 }}>{saving ? "保存中..." : "保存"}</button>
            <button onClick={onClose} style={closeBtnStyle}>×</button>
          </div>

          {!draft ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>请选择角色</div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
                <label style={labelStyle}>角色名称<input value={draft.name} onChange={(e) => setDraft((p) => p ? { ...p, name: e.target.value } : p)} style={inputStyle} /></label>
                <label style={labelStyle}>角色描述<input value={draft.description} onChange={(e) => setDraft((p) => p ? { ...p, description: e.target.value } : p)} style={inputStyle} /></label>
              </div>
              <label style={labelStyle}>基础系统提示词<textarea value={draft.basePrompt} onChange={(e) => setDraft((p) => p ? { ...p, basePrompt: e.target.value } : p)} rows={4} style={textareaStyle} /></label>

              {selectedRole && !selectedRole.builtIn && selectedRole.id !== "default" && (
                <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", marginBottom: 12 }}>角色归属</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <label style={{ ...fieldLabelStyle2, flex: "1 1 180px" }}>
                      <span>作用域</span>
                      <select value={draftScope} onChange={(e) => setDraftScope(e.target.value as "user" | "project")} style={selectStyle}>
                        <option value="user">全局（所有项目可见）</option>
                        <option value="project">项目（绑定到某个项目）</option>
                      </select>
                    </label>
                    {draftScope === "project" && (
                      <label style={{ ...fieldLabelStyle2, flex: "1 1 260px" }}>
                        <span>目标项目</span>
                        <select value={draftProjectCwd} onChange={(e) => setDraftProjectCwd(e.target.value)} style={selectStyle}>
                          {projectChoices.length === 0 && <option value="">无项目</option>}
                          {projectChoices.map((project) => <option key={project.cwd} value={project.cwd}>{project.displayName || projectName(project.cwd)}</option>)}
                        </select>
                        {draftProjectCwd && <span style={helperTextStyle}>{draftProjectCwd}</span>}
                      </label>
                    )}
                  </div>
                </div>
              )}

              {BLOCKS.map((block) => (
                <section key={block} style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>{block} / {BLOCK_LABELS[block]}</div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{draft.blocks[block]?.length ?? 0} 条设定</div>
                    </div>
                    <button onClick={() => updateDraftBlock(block, (items) => [...items, { id: `local_${Date.now()}`, text: "", createdAt: new Date().toISOString() }])} style={secondaryBtnStyle}>+ 新增</button>
                  </div>
                  {(draft.blocks[block] ?? []).length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0" }}>暂无设定</div>}
                  {(draft.blocks[block] ?? []).map((setting, index) => (
                    <div key={setting.id} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <textarea value={setting.text} onChange={(e) => updateDraftBlock(block, (items) => items.map((s, i) => i === index ? { ...s, text: e.target.value } : s))} rows={2} style={{ ...textareaStyle, marginBottom: 0 }} />
                      <button onClick={() => updateDraftBlock(block, (items) => items.filter((_, i) => i !== index))} style={{ ...dangerBtnStyle, alignSelf: "stretch" }}>删除</button>
                    </div>
                  ))}
                </section>
              ))}
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
  borderRadius: 11,
  background: "color-mix(in srgb, var(--bg) 88%, var(--bg-panel))",
  color: "var(--text)",
  fontSize: 12,
  lineHeight: 1.4,
  outlineOffset: 2,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
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
  background: "linear-gradient(180deg, var(--bg-panel) 0%, color-mix(in srgb, var(--bg-panel) 88%, var(--bg)) 100%)",
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
  fontWeight: 750,
  lineHeight: 1.2,
};

const fieldLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 11,
  fontWeight: 750,
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
  resize: "vertical",
  lineHeight: 1.5,
  fontFamily: "inherit",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-muted)",
};

const primaryBtnStyle: CSSProperties = {
  padding: "8px 12px",
  border: "none",
  borderRadius: 9,
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

const secondaryBtnStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
};

const dangerBtnStyle: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid rgba(239,68,68,0.35)",
  borderRadius: 8,
  background: "rgba(239,68,68,0.06)",
  color: "#ef4444",
  cursor: "pointer",
  fontSize: 12,
};

const closeBtnStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 18,
};
