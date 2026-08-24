"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { SkillSearchResult } from "@/app/api/skills/search/route";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  canDelete: boolean;
}

interface ProjectOption {
  cwd: string;
  displayName: string;
}

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function projectName(cwd: string): string {
  return cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd;
}

function skillsApiUrl(cwd?: string): string {
  return cwd ? `/api/skills?cwd=${encodeURIComponent(cwd)}` : "/api/skills";
}

function sourceLabel(skill: Skill): string {
  const scope = skill.sourceInfo?.scope;
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  if (scope === "builtin") return "builtin";
  return "path";
}

/** Derive a human-friendly sub-group name for a skill within its scope. */
function subGroupKey(skill: Skill): string {
  const src = skill.sourceInfo?.source;
  // If source is a meaningful identifier (e.g. package name from skills.sh),
  // use it as the subgroup key
  if (src && src !== "auto" && src !== "local" && src !== "project" && src !== "user") {
    return src;
  }
  // Otherwise, use the baseDir (the directory that was scanned for skills)
  return skill.baseDir || "";
}

/** Shorten a sub-group key for display. */
function subGroupDisplay(key: string): string {
  // Package-style sources (e.g. owner/repo@skill) — just show the repo part
  const atIdx = key.indexOf("@");
  if (atIdx > -1) {
    const beforeAt = key.slice(0, atIdx);
    const parts = beforeAt.split("/");
    return parts.length >= 2 ? parts.slice(-2).join("/") : beforeAt;
  }
  // Path-like key — shorten
  if (key.startsWith("/") || key.startsWith("~")) {
    // Extract the last meaningful directory name
    const parts = key.replace(/\/+$/, "").split("/");
    // e.g. ~/.deerhux/agent/skills → "deerhux/agent/skills", ~/.deerhux → ".deerhux"
    // Show last 1-2 segments that help distinguish
    const homeIdx = parts.findIndex((p) => p === "~" || p === ".deerhux");
    if (homeIdx >= 0) {
      return parts.slice(homeIdx).join("/");
    }
    return parts.slice(-2).join("/");
  }
  return key || "其他";
}

const labelMap: Record<string, string> = {
  global: "全局",
  project: "项目",
  path: "路径",
  builtin: "内置",
};

function SkillModeSwitch({
  mode,
  loading,
  onChange,
}: {
  mode: "active" | "passive";
  loading: boolean;
  onChange: (mode: "active" | "passive") => void;
}) {
  const options = [
    { value: "passive" as const, label: "被动", title: "模型可根据任务语义自动匹配" },
    { value: "active" as const, label: "主动", title: "仅在用户明确引用时加载" },
  ];
  return (
    <div
      role="group"
      aria-label="技能调用方式"
      style={{
        display: "inline-flex",
        flexShrink: 0,
        padding: 2,
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--bg)",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {options.map((option) => {
        const selected = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            title={option.title}
            disabled={loading}
            onClick={() => onChange(option.value)}
            style={{
              minWidth: 42,
              padding: "3px 8px",
              border: "none",
              borderRadius: 4,
              background: selected ? "var(--accent)" : "transparent",
              color: selected ? "var(--bg)" : "var(--text-dim)",
              fontSize: 11,
              fontWeight: selected ? 600 : 400,
              cursor: loading ? "wait" : "pointer",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function TavilyKeyConfig() {
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [hasExistingKey, setHasExistingKey] = useState(false);

  // Load current config on mount
  useEffect(() => {
    setLoading(true);
    fetch("/api/tavily/config")
      .then((r) => r.json())
      .then((d: { configured?: boolean; apiKey?: string; hasKey?: boolean; error?: string }) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        if (d.configured) {
          setApiKey(d.apiKey || "");
          setHasExistingKey(true);
          setSaved(true);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      setError("请输入 API 密钥");
      return;
    }
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/tavily/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSaved(true);
      setHasExistingKey(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch("/api/tavily/test", { method: "POST" });
      const d = await res.json() as { success?: boolean; message?: string; error?: string };
      if (d.success) {
        setTestResult({ success: true, message: d.message || "API 密钥有效" });
      } else {
        setTestResult({ success: false, message: d.message || d.error || "测试失败" });
      }
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setApiKey("");
    // Clear the key by saving empty config
    try {
      await fetch("/api/tavily/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
    } catch { /* ignore */ }
    setSaved(false);
    setHasExistingKey(false);
    setTestResult(null);
    setError(null);
  }, []);

  if (loading) {
    return (
      <div style={{ marginTop: 28, padding: 16, borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 28, padding: 16, borderTop: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
        Tavily API 密钥
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
        设置后，Agent 可通过 Tavily 搜索引擎获取最新网络信息。
        前往{" "}
        <a
          href="https://app.tavily.com"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--accent)", textDecoration: "none" }}
        >
          tavily.com
        </a>{" "}
        获取 API 密钥。
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
            placeholder={hasExistingKey ? "（已配置，输入新密钥以更新）" : "输入 Tavily API 密钥…"}
            style={{
              width: "100%",
              padding: "7px 36px 7px 10px",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <button
            onClick={() => setShowKey(!showKey)}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: 4,
              display: "flex",
            }}
            title={showKey ? "隐藏" : "显示"}
          >
            {showKey ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          style={{
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 6,
            border: "none",
            background: saved ? "rgba(34,197,94,0.1)" : "var(--accent)",
            color: saved ? "#16a34a" : "#fff",
            cursor: saving || !apiKey.trim() ? "not-allowed" : "pointer",
            opacity: saving || !apiKey.trim() ? 0.5 : 1,
            flexShrink: 0,
            transition: "background 0.15s, color 0.15s",
          }}
        >
          {saving ? "保存中…" : saved ? "✓ 已保存" : "保存"}
        </button>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleTest}
          disabled={testing || !hasExistingKey}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            borderRadius: 5,
            border: "1px solid var(--border)",
            background: "none",
            color: hasExistingKey ? "var(--text-muted)" : "var(--text-dim)",
            cursor: testing || !hasExistingKey ? "not-allowed" : "pointer",
            opacity: testing || !hasExistingKey ? 0.4 : 1,
          }}
        >
          {testing ? "测试中…" : "测试密钥"}
        </button>
        {hasExistingKey && (
          <button
            onClick={handleClear}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            清除
          </button>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 12px",
            borderRadius: 6,
            background: testResult.success
              ? "rgba(34,197,94,0.08)"
              : "rgba(239,68,68,0.08)",
            border: `1px solid ${testResult.success ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
            fontSize: 12,
            color: testResult.success ? "#16a34a" : "#ef4444",
            lineHeight: 1.5,
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
          }}
        >
          {testResult.success ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          {testResult.message}
        </div>
      )}

      {/* General error */}
      {error && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: "#f87171",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function SkillDetail({
  skill,
  cwd,
  projects,
  moveProjectCwd,
  onMoveProjectCwdChange,
  onModeChange,
  onDelete,
  onMove,
  toggling,
  deleting,
  moving,
  saveError,
}: {
  skill: Skill;
  cwd?: string;
  projects: ProjectOption[];
  moveProjectCwd: string;
  onMoveProjectCwdChange: (cwd: string) => void;
  onModeChange: (skill: Skill, mode: "active" | "passive") => void;
  onDelete: (skill: Skill) => void;
  onMove: (skill: Skill, targetScope: "global" | "project", targetCwd?: string) => void;
  toggling: boolean;
  deleting: boolean;
  moving: boolean;
  saveError: string | null;
}) {
  const label = sourceLabel(skill);
  const sgKey = subGroupKey(skill);
  const sgDisplay = subGroupDisplay(sgKey);
  const mode = skill.disableModelInvocation ? "active" : "passive";
  const targetScope = label === "global" ? "project" : "global";
  const canMove = skill.canDelete && (label === "global" || label === "project");
  const needsProjectTarget = canMove && targetScope === "project";
  const canMoveNow = !needsProjectTarget || Boolean(moveProjectCwd);

  const [confirmDelete, setConfirmDelete] = useState(false);

  function displayPath(p: string): string {
    if (cwd && label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Path + tags + toggle + delete */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 3,
            flexShrink: 0,
            background:
              label === "project"
                ? "rgba(99,102,241,0.12)"
                : "rgba(120,120,120,0.12)",
            color:
              label === "project" ? "rgba(99,102,241,0.8)" : "var(--text-dim)",
          }}
        >
          {labelMap[label] ?? label}
        </span>
        {sgDisplay && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 4px",
              borderRadius: 3,
              flexShrink: 0,
              background: "rgba(139,92,246,0.1)",
              color: "rgba(139,92,246,0.75)",
              fontFamily: "var(--font-mono)",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={sgKey}
          >
            {sgDisplay}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayPath(skill.filePath)}
        </span>
        <SkillModeSwitch
          mode={mode}
          loading={toggling || moving}
          onChange={(nextMode) => onModeChange(skill, nextMode)}
        />
        {needsProjectTarget && (
          <select
            value={moveProjectCwd}
            onChange={(e) => onMoveProjectCwdChange(e.target.value)}
            disabled={moving || deleting}
            title={moveProjectCwd || "选择目标项目"}
            style={{
              flexShrink: 0,
              maxWidth: 150,
              padding: "3px 6px",
              fontSize: 11,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: moveProjectCwd ? "var(--text-muted)" : "var(--text-dim)",
              cursor: moving || deleting ? "not-allowed" : "pointer",
            }}
          >
            <option value="">选择项目</option>
            {projects.map((project) => (
              <option key={project.cwd} value={project.cwd}>
                {project.displayName || projectName(project.cwd)}
              </option>
            ))}
          </select>
        )}
        {canMove && (
          <button
            onClick={() => onMove(skill, targetScope, targetScope === "project" ? moveProjectCwd : undefined)}
            disabled={moving || deleting || !canMoveNow}
            title={targetScope === "project" ? "移到选择的项目" : "移到全局"}
            style={{
              flexShrink: 0,
              padding: "3px 8px",
              fontSize: 11,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-dim)",
              cursor: moving || deleting || !canMoveNow ? "not-allowed" : "pointer",
              opacity: moving || deleting || !canMoveNow ? 0.5 : 1,
            }}
          >
            {moving
              ? "移动中…"
              : targetScope === "project"
                ? "移到项目"
                : "移到全局"}
          </button>
        )}
        {skill.canDelete && !confirmDelete && (
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={deleting || moving}
            title="删除技能"
            style={{
              flexShrink: 0,
              padding: "3px 8px",
              fontSize: 11,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-dim)",
              cursor: deleting || moving ? "not-allowed" : "pointer",
              opacity: deleting || moving ? 0.5 : 1,
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
          </button>
        )}
        {saveError && (
          <span style={{ fontSize: 12, color: "#f87171", flexShrink: 0 }}>
            {saveError}
          </span>
        )}
      </div>

      <div
        style={{
          marginTop: -12,
          fontSize: 11,
          color: "var(--text-dim)",
          lineHeight: 1.5,
        }}
      >
        {mode === "passive"
          ? "被动技能会出现在模型提示词中，可根据任务语义自动匹配。"
          : "主动技能不会进入模型提示词，只在用户明确引用时加载。"}
      </div>

      {/* Delete confirmation bar */}
      {confirmDelete && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 6,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.2)",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span
            style={{ fontSize: 13, color: "#ef4444", flex: 1 }}
          >
            确定要删除技能 <strong>{skill.name}</strong> 吗？此操作不可撤销。
          </span>
          <button
            onClick={() => setConfirmDelete(false)}
            disabled={deleting}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "none",
              color: "var(--text-muted)",
              cursor: deleting ? "not-allowed" : "pointer",
            }}
          >
            取消
          </button>
          <button
            onClick={() => {
              onDelete(skill);
              setConfirmDelete(false);
            }}
            disabled={deleting}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 4,
              border: "none",
              background: "#ef4444",
              color: "#fff",
              cursor: deleting ? "not-allowed" : "pointer",
              opacity: deleting ? 0.5 : 1,
            }}
          >
            {deleting ? "删除中…" : "确认删除"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          名称
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "var(--text)",
          }}
        >
          {skill.name}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}
        >
          描述
        </span>
        <span
          style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6 }}
        >
          {skill.description}
        </span>
      </div>
    </div>
  );
}

const scopeLabels: Record<string, string> = {
  global: "全局",
  project: "项目",
};

function AddSkillPanel({
  cwd,
  onInstalled,
}: {
  cwd?: string;
  onInstalled: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installedPkgs, setInstalledPkgs] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "project">("global");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!cwd && scope === "project") setScope("global");
  }, [cwd, scope]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError("未找到匹配的技能");
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  const install = useCallback(
    async (pkg: string) => {
      if (scope === "project" && !cwd) {
        setInstallError("请先在技能配置顶部选择项目视图");
        return;
      }
      setInstalling(pkg);
      setInstallError(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || d.error) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setInstalledPkgs((prev) => new Set(prev).add(pkg));
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd],
  );

  const installPath =
    scope === "global"
      ? "~/.deerhux/agent/skills/"
      : cwd
        ? `${shortenPath(cwd)}/.deerhux/skills/`
        : "请先选择项目视图";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
          添加技能
        </div>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
            placeholder="例如 react, testing, deploy"
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 13,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
            style={{
              padding: "7px 16px",
              fontSize: 13,
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              cursor: searching || !query.trim() ? "not-allowed" : "pointer",
              opacity: searching || !query.trim() ? 0.5 : 1,
              flexShrink: 0,
            }}
          >
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        {/* Scope + install path row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              borderRadius: 5,
              border: "1px solid var(--border)",
              overflow: "hidden",
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            {(["global", "project"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                disabled={s === "project" && !cwd}
                style={{
                  padding: "3px 10px",
                  border: "none",
                  cursor: s === "project" && !cwd ? "not-allowed" : "pointer",
                  background: scope === s ? "var(--bg-selected)" : "none",
                  color: scope === s ? "var(--text)" : "var(--text-dim)",
                  opacity: s === "project" && !cwd ? 0.45 : 1,
                  fontWeight: scope === s ? 600 : 400,
                  borderRight:
                    s === "global" ? "1px solid var(--border)" : "none",
                }}
              >
                {scopeLabels[s] ?? s}
              </button>
            ))}
          </div>
          <span
            style={{
              fontSize: 12,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {installPath}
          </span>
        </div>

        {/* Errors */}
        {searchError && (
          <div style={{ fontSize: 12, color: "#f87171" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}
          >
            {installError}
          </div>
        )}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled = installedPkgs.has(r.package);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <button
                  onClick={() =>
                    !isInstalled && !isInstalling && install(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null}
                  style={{
                    flexShrink: 0,
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: 500,
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    cursor:
                      isInstalled || isInstalling || installing !== null
                        ? "not-allowed"
                        : "pointer",
                    background: isInstalled ? "rgba(34,197,94,0.1)" : "none",
                    color: isInstalled
                      ? "#16a34a"
                      : isInstalling
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    transition: "color 0.12s",
                  }}
                >
                  {isInstalled
                    ? "✓ 已安装"
                    : isInstalling
                      ? "安装中…"
                      : "安装"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div
            style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}
          >
            在{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            上搜索并安装适合您 Agent 的技能。
          </div>
        )
      )}
    </div>
  );
}

export function SkillsConfig({
  projects = [],
  onClose,
}: {
  projects?: ProjectOption[];
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedProjectCwd, setSelectedProjectCwd] = useState("");
  const [moveProjectCwd, setMoveProjectCwd] = useState("");
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    skill: Skill;
    x: number;
    y: number;
  } | null>(null);

  useEscapeClose(() => setAddMode(false), addMode);
  useEscapeClose(onClose, !addMode && !contextMenu);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const revealSkillInFinder = useCallback(async () => {
    if (!contextMenu) return;
    try {
      const response = await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: contextMenu.skill.baseDir }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setSaveError(data.error ?? `HTTP ${response.status}`);
      }
    } catch (error) {
      setSaveError(String(error));
    }
    setContextMenu(null);
  }, [contextMenu]);

  const projectChoices = useMemo(
    () => projects.filter((project) => project.cwd),
    [projects],
  );

  const loadSkills = useCallback((preferredSelected?: string, overrideCwd?: string) => {
    const targetCwd = overrideCwd ?? selectedProjectCwd;
    setLoading(true);
    setError(null);
    fetch(skillsApiUrl(targetCwd || undefined))
      .then((r) => r.json())
      .then((d: { skills?: Skill[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          return;
        }
        const list = d.skills ?? [];
        setSkills(list);
        setSelected((current) => {
          if (preferredSelected && list.some((s) => s.filePath === preferredSelected)) {
            return preferredSelected;
          }
          if (current && list.some((s) => s.filePath === current)) return current;
          return list[0]?.filePath ?? null;
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedProjectCwd]);

  useEffect(() => {
    loadSkills();
  }, [selectedProjectCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!moveProjectCwd && projectChoices[0]?.cwd) {
      setMoveProjectCwd(projectChoices[0].cwd);
    }
  }, [moveProjectCwd, projectChoices]);

  const changeMode = useCallback(async (skill: Skill, mode: "active" | "passive") => {
    const next = mode === "active";
    if (next === skill.disableModelInvocation) return;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          cwd: selectedProjectCwd || undefined,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [selectedProjectCwd]);

  const moveSkill = useCallback(async (skill: Skill, targetScope: "global" | "project", targetCwd?: string) => {
    const requestCwd = targetScope === "project" ? targetCwd : selectedProjectCwd;
    if (targetScope === "project" && !requestCwd) {
      setSaveError("请选择目标项目");
      return;
    }
    setMoving((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          cwd: requestCwd || undefined,
          targetScope,
        }),
      });
      const d = (await res.json()) as {
        success?: boolean;
        filePath?: string;
        error?: string;
      };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      const nextCwd = targetScope === "project" ? (requestCwd ?? "") : "";
      setSelectedProjectCwd(nextCwd);
      loadSkills(d.filePath, nextCwd);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setMoving((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [loadSkills, selectedProjectCwd]);

  const deleteSkill = useCallback(async (skill: Skill) => {
    setDeleting((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch(
        `${skillsApiUrl(selectedProjectCwd || undefined)}${selectedProjectCwd ? "&" : "?"}filePath=${encodeURIComponent(skill.filePath)}`,
        { method: "DELETE" },
      );
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      // Remove from list and select next available
      setSkills((prev) => {
        const next = prev.filter((s) => s.filePath !== skill.filePath);
        if (selected === skill.filePath) {
          setSelected(next.length > 0 ? next[0].filePath : null);
        }
        return next;
      });
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setDeleting((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, [selected, selectedProjectCwd]);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 860,
          height: "78vh",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span
              style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", flexShrink: 0 }}
            >
              技能配置
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedProjectCwd("")}
                style={{
                  padding: "4px 9px",
                  fontSize: 12,
                  borderRadius: 5,
                  border: "1px solid var(--border)",
                  background: selectedProjectCwd ? "none" : "var(--bg-selected)",
                  color: selectedProjectCwd ? "var(--text-dim)" : "var(--text)",
                  cursor: "pointer",
                }}
              >
                全局
              </button>
              <select
                value={selectedProjectCwd}
                onChange={(e) => setSelectedProjectCwd(e.target.value)}
                title={selectedProjectCwd || "选择项目视图"}
                style={{
                  maxWidth: 360,
                  padding: "4px 8px",
                  fontSize: 12,
                  borderRadius: 5,
                  border: "1px solid var(--border)",
                  background: selectedProjectCwd ? "var(--bg-selected)" : "var(--bg)",
                  color: selectedProjectCwd ? "var(--text)" : "var(--text-dim)",
                  cursor: "pointer",
                }}
              >
                <option value="">选择项目视图…</option>
                {projectChoices.map((project) => (
                  <option key={project.cwd} value={project.cwd}>
                    {project.displayName || projectName(project.cwd)}
                  </option>
                ))}
              </select>
              <code
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedProjectCwd ? shortenPath(selectedProjectCwd) : "global skills"}
              </code>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Left: skill list */}
          <div
            style={{
              width: 210,
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  加载中…
                </div>
              ) : error ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "#f87171",
                  }}
                >
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div
                  style={{
                    padding: "10px 8px",
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  未找到任何技能
                </div>
              ) : (
                (() => {
                  // Build nested groups: scope → sub-group → skills
                  type SubGroup = { label: string; skills: typeof skills };
                  type ScopeGroup = { label: string; subGroups: SubGroup[] };
                  const scopeGroups: ScopeGroup[] = [];
                  for (const scope of ["builtin", "project", "global", "path"]) {
                    const scopeSkills = skills.filter(
                      (s) => sourceLabel(s) === scope,
                    );
                    if (scopeSkills.length === 0) continue;
                    // Within a scope, group by subGroupKey
                    const subMap = new Map<string, typeof skills>();
                    for (const skill of scopeSkills) {
                      const key = subGroupKey(skill);
                      if (!subMap.has(key)) subMap.set(key, []);
                      subMap.get(key)!.push(skill);
                    }
                    const subGroups: SubGroup[] = [...subMap.entries()].map(
                      ([key, list]) => ({
                        label: subGroupDisplay(key),
                        skills: list,
                      }),
                    );
                    scopeGroups.push({
                      label: labelMap[scope] ?? scope,
                      subGroups,
                    });
                  }
                  return scopeGroups.map(({ label: scopeLabel, subGroups }) => (
                    <div key={scopeLabel} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          padding: "4px 8px 3px",
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--text-dim)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {scopeLabel}
                      </div>
                      {subGroups.map(({ label: sgLabel, skills: sgSkills }) => {
                        // Only show sub-group header when there are multiple sub-groups
                        const showHeader = subGroups.length > 1;
                        return (
                          <div key={sgLabel}>
                            {showHeader && (
                              <div
                                style={{
                                  padding: "2px 8px 2px 16px",
                                  fontSize: 9,
                                  fontWeight: 500,
                                  color: "var(--text-dim)",
                                  fontFamily: "var(--font-mono)",
                                  opacity: 0.65,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={sgLabel}
                              >
                                {sgLabel}
                              </div>
                            )}
                            {sgSkills.map((skill) => {
                              const isSelected =
                                !addMode && selected === skill.filePath;
                              const mode = skill.disableModelInvocation ? "主动" : "被动";
                              return (
                                <div
                                  key={skill.filePath}
                                  onClick={() => {
                                    setSelected(skill.filePath);
                                    setAddMode(false);
                                  }}
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelected(skill.filePath);
                                    setAddMode(false);
                                    setContextMenu({
                                      skill,
                                      x: Math.min(event.clientX, window.innerWidth - 216),
                                      y: Math.min(event.clientY, window.innerHeight - 92),
                                    });
                                  }}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 7,
                                    padding: "8px 8px",
                                    borderRadius: 5,
                                    cursor: "pointer",
                                    background: isSelected
                                      ? "var(--bg-selected)"
                                      : "none",
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!isSelected)
                                      e.currentTarget.style.background =
                                        "var(--bg-hover)";
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!isSelected)
                                      e.currentTarget.style.background = "none";
                                  }}
                                >
                                  <span
                                    style={{
                                      flexShrink: 0,
                                      width: 7,
                                      height: 7,
                                      borderRadius: "50%",
                                      background: skill.disableModelInvocation
                                        ? "rgba(139,92,246,0.85)"
                                        : "var(--accent)",
                                      boxShadow: skill.disableModelInvocation
                                        ? "none"
                                        : "0 0 4px var(--accent)",
                                      transition:
                                        "background 0.15s, box-shadow 0.15s",
                                    }}
                                  />
                                  <span
                                    style={{
                                      fontSize: 12,
                                      fontWeight: isSelected ? 600 : 400,
                                      color: "var(--text)",
                                      fontFamily: "var(--font-mono)",
                                      flex: 1,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {skill.name}
                                  </span>
                                  <span
                                    style={{
                                      flexShrink: 0,
                                      fontSize: 9,
                                      color: skill.disableModelInvocation
                                        ? "rgba(139,92,246,0.9)"
                                        : "var(--text-dim)",
                                    }}
                                  >
                                    {mode}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ));
                })()
              )}
            </div>
            {/* Add skill button */}
            <div
              style={{
                padding: "8px 6px",
                borderTop: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => setAddMode(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  cursor: "pointer",
                  background: addMode ? "var(--bg-selected)" : "none",
                  color: addMode ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (!addMode)
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!addMode) e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                添加技能
              </div>
            </div>
          </div>

          {/* Right: detail or add panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {addMode ? (
              <AddSkillPanel
                cwd={selectedProjectCwd || undefined}
                onInstalled={() => {
                  loadSkills();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <>
                <SkillDetail
                  key={selectedSkill.filePath}
                  skill={selectedSkill}
                  cwd={selectedProjectCwd || undefined}
                  projects={projectChoices}
                  moveProjectCwd={moveProjectCwd}
                  onMoveProjectCwdChange={setMoveProjectCwd}
                  onModeChange={changeMode}
                  onDelete={deleteSkill}
                  onMove={moveSkill}
                  toggling={toggling.has(selectedSkill.filePath)}
                  deleting={deleting.has(selectedSkill.filePath)}
                  moving={moving.has(selectedSkill.filePath)}
                  saveError={saveError}
                />
                {selectedSkill.name === "tavily-search" && <TavilyKeyConfig />}
              </>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                请选择一个技能
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            关闭
          </button>
        </div>
      </div>

      {contextMenu && (
        <div
          role="menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1100,
            width: 200,
            padding: 6,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            style={{
              padding: "5px 8px 7px",
              color: "var(--text-dim)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={contextMenu.skill.baseDir}
          >
            {contextMenu.skill.name}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={revealSkillInFinder}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "7px 8px",
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--bg-hover)";
              event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              <path d="m9 12 3 3 3-3" />
            </svg>
            在 Finder 中显示
          </button>
        </div>
      )}
    </div>
  );
}
