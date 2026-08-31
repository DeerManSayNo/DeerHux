"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { getProjectDisplayName } from "@/lib/project-name";
import {
  FLOATING_CHAT_COLLAPSED_SIZE,
  FLOATING_CHAT_EXPANDED_HEIGHT,
  FLOATING_CHAT_EXPANDED_WIDTH,
} from "@/lib/floating-chat-window";

type ProjectOption = { cwd: string; displayName: string };
type RoleOption = { id: string; name: string };
type ModelOption = { provider: string; modelId: string };

const modelValue = (model: ModelOption) => `${model.provider}\u0000${model.modelId}`;
const createClientMessageId = () => `floating-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function FloatingQuickChat() {
  useTheme();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [cwd, setCwd] = useState("");
  const [roleId, setRoleId] = useState("default");
  const [model, setModel] = useState<ModelOption | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resizeWindow = useCallback(async (expanded: boolean) => {
    try {
      const [{ LogicalPosition, LogicalSize }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/dpi"),
        import("@tauri-apps/api/window"),
      ]);
      const appWindow = getCurrentWindow();
      const [position, size, scale] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.outerSize(),
        appWindow.scaleFactor(),
      ]);
      const width = expanded ? FLOATING_CHAT_EXPANDED_WIDTH : FLOATING_CHAT_COLLAPSED_SIZE;
      const height = expanded ? FLOATING_CHAT_EXPANDED_HEIGHT : FLOATING_CHAT_COLLAPSED_SIZE;
      const right = position.x + size.width;
      const bottom = position.y + size.height;
      await appWindow.setSize(new LogicalSize(width, height));
      await appWindow.setPosition(new LogicalPosition((right - width * scale) / scale, (bottom - height * scale) / scale));
    } catch {
      // 普通浏览器中访问该路由时保留页面调试能力。
    }
  }, []);

  const setExpanded = useCallback((expanded: boolean) => {
    setOpen(expanded);
    void resizeWindow(expanded);
  }, [resizeWindow]);

  const loadRoles = useCallback(async (projectCwd: string) => {
    if (!projectCwd) return;
    const response = await fetch(`/api/roles?cwd=${encodeURIComponent(projectCwd)}`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { roles?: RoleOption[] };
    const nextRoles = payload.roles ?? [];
    setRoles(nextRoles);
    setRoleId((current) => nextRoles.some((role) => role.id === current) ? current : (nextRoles[0]?.id ?? "default"));
  }, []);

  useEffect(() => {
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/sessions", { cache: "no-store" }).then((response) => response.ok ? response.json() : { sessions: [] }),
      fetch("/api/project-meta", { cache: "no-store" }).then((response) => response.ok ? response.json() : { meta: {} }),
      fetch("/api/models", { cache: "no-store" }).then((response) => response.ok ? response.json() : { modelList: [] }),
      fetch("/api/default-cwd", { method: "POST" }).then((response) => response.ok ? response.json() : { cwd: "" }),
    ]).then(([sessionPayload, metaPayload, modelPayload, defaultCwdPayload]: [
      { sessions?: { cwd?: string }[] },
      { meta?: { customCwds?: string[]; hiddenCwds?: string[] } },
      { modelList?: { id: string; provider: string }[]; defaultModel?: ModelOption | null },
      { cwd?: string },
    ]) => {
      if (cancelled) return;
      const hidden = new Set(metaPayload.meta?.hiddenCwds ?? []);
      const cwds = [
        defaultCwdPayload.cwd ?? "",
        ...(metaPayload.meta?.customCwds ?? []),
        ...(sessionPayload.sessions ?? []).map((session) => session.cwd ?? ""),
      ].filter((value, index, list) => Boolean(value) && list.indexOf(value) === index && !hidden.has(value));
      const nextProjects = cwds.map((projectCwd) => ({ cwd: projectCwd, displayName: getProjectDisplayName(projectCwd) }));
      const nextModels = (modelPayload.modelList ?? []).map((item) => ({ provider: item.provider, modelId: item.id }));
      const nextCwd = nextProjects[0]?.cwd ?? "";
      setProjects(nextProjects);
      setModels(nextModels);
      setCwd(nextCwd);
      setModel(modelPayload.defaultModel ?? nextModels[0] ?? null);
      void loadRoles(nextCwd);
    }).catch(() => setNotice("配置加载失败"));
    return () => { cancelled = true; };
  }, [loadRoles]);

  useEffect(() => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setAlwaysOnTop(true))
      .catch(() => {});
  }, []);

  const submit = async () => {
    const text = message.trim();
    if (!text || !cwd || !model || sending) return;
    setSending(true);
    setNotice(null);
    const clientMessageId = createClientMessageId();
    try {
      const response = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          type: "prompt",
          message: text,
          clientMessageId,
          creationRequestId: clientMessageId,
          provider: model.provider,
          modelId: model.modelId,
          roleId,
          agentMode: "agent",
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `发送失败（HTTP ${response.status}）`);
      setMessage("");
      setNotice("已发送，新会话正在运行");
      window.setTimeout(() => setExpanded(false), 650);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const show = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setExpanded(true);
  };
  const scheduleClose = () => {
    closeTimerRef.current = setTimeout(() => setExpanded(false), 180);
  };
  const selectedModelValue = model ? modelValue(model) : "";
  const canSend = Boolean(message.trim() && cwd && model && !sending);

  return (
    <main
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
      onFocusCapture={show}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
      }}
      style={{ position: "relative", width: "100vw", height: "100dvh", overflow: "hidden", background: "transparent", color: "var(--text)" }}
    >
      <section
        aria-hidden={!open}
        style={{
          position: "absolute", right: 12, bottom: 76, width: 406, padding: 12,
          border: "1px solid var(--border)", borderRadius: 22,
          background: "color-mix(in srgb, var(--bg-panel) 96%, transparent)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.28)", backdropFilter: "blur(18px)",
          opacity: open ? 1 : 0, visibility: open ? "visible" : "hidden",
          transform: open ? "translateY(0) scale(1)" : "translateY(8px) scale(0.98)",
          transformOrigin: "bottom right", pointerEvents: open ? "auto" : "none",
          transition: "opacity 140ms ease, transform 160ms ease, visibility 140ms ease",
        }}
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="输入任务，Enter 发送…"
          disabled={sending}
          rows={4}
          aria-label="快捷消息"
          style={{ display: "block", width: "100%", minHeight: 112, maxHeight: 170, resize: "none", padding: "12px 12px 8px", border: "none", outline: "none", background: "transparent", color: "var(--text)", font: "inherit", fontSize: 14, lineHeight: 1.55 }}
        />
        {notice && <div title={notice} style={{ minHeight: 18, padding: "0 10px 6px", overflow: "hidden", color: notice.startsWith("已发送") ? "#22c55e" : "#ef4444", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{notice}</div>}
        <div style={{ height: 1, margin: "0 6px 9px", background: "var(--border)" }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", alignItems: "center", gap: 6 }}>
          <QuickSelect label="项目名" value={cwd} options={projects.map((item) => ({ value: item.cwd, label: item.displayName }))} onChange={(value) => { setCwd(value); void loadRoles(value); }} icon={<FolderIcon />} />
          <QuickSelect label="角色名" value={roleId} options={roles.map((item) => ({ value: item.id, label: item.name }))} onChange={setRoleId} icon={<UserIcon />} />
          <QuickSelect label="模型 ID" value={selectedModelValue} options={models.map((item) => ({ value: modelValue(item), label: item.modelId }))} onChange={(value) => { const selected = models.find((item) => modelValue(item) === value); if (selected) setModel(selected); }} icon={<CpuIcon />} />
          <button type="button" onClick={() => void submit()} disabled={!canSend} title="发送" aria-label="发送快捷消息" style={{ display: "grid", placeItems: "center", width: 34, height: 34, padding: 0, border: "none", borderRadius: "50%", background: canSend ? "var(--accent)" : "var(--bg-hover)", color: canSend ? "#fff" : "var(--text-dim)", cursor: canSend ? "pointer" : "not-allowed" }}><SendIcon /></button>
        </div>
      </section>

      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-label={open ? "收起快捷窗口" : "展开快捷窗口"}
        aria-expanded={open}
        title="DeerHux 快捷对话"
        style={{ position: "absolute", right: 12, bottom: 12, display: "grid", placeItems: "center", width: 52, height: 52, padding: 0, border: "1px solid rgba(255,255,255,0.26)", borderRadius: "50%", background: "linear-gradient(145deg, var(--accent), var(--accent-hover))", color: "#fff", cursor: "pointer", boxShadow: "0 10px 28px color-mix(in srgb, var(--accent) 38%, transparent)", transform: open ? "scale(1.04)" : "scale(1)", transition: "transform 140ms ease" }}
      ><ChatIcon /></button>
    </main>
  );
}

function QuickSelect({ label, value, options, onChange, icon }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; icon: React.ReactNode }) {
  return (
    <label title={`选择${label}`} style={{ position: "relative", display: "flex", alignItems: "center", minWidth: 0, height: 34, color: options.length ? "var(--text-muted)" : "var(--text-dim)" }}>
      <span style={{ position: "absolute", left: 7, zIndex: 1, display: "grid", placeItems: "center", pointerEvents: "none" }}>{icon}</span>
      <select aria-label={label} value={value} disabled={!options.length} onChange={(event) => onChange(event.target.value)} style={{ width: "100%", height: 34, minWidth: 0, padding: "0 20px 0 27px", border: "none", borderRadius: 10, outline: "none", background: "var(--bg-hover)", color: "inherit", cursor: options.length ? "pointer" : "default", font: "inherit", fontSize: 11, fontWeight: 600, textOverflow: "ellipsis" }}>
        {!options.length && <option value="">暂无{label}</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ChatIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /><path d="M8 9h8M8 13h5" /></svg>; }
function FolderIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h6l2 2h10v10H3z" /></svg>; }
function UserIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>; }
function CpuIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 6h3M1 9h3m-3 6h3" /></svg>; }
function SendIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5" /></svg>; }
