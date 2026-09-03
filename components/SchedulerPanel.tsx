"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import type { ScheduledTask, TaskLog } from "@/lib/scheduler/types";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface ApiModelOption {
  provider: string;
  id: string;
  name: string;
}

// ============================================================================
// Cron presets for quick selection
// ============================================================================

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "每分钟", cron: "* * * * *" },
  { label: "每5分钟", cron: "*/5 * * * *" },
  { label: "每15分钟", cron: "*/15 * * * *" },
  { label: "每30分钟", cron: "*/30 * * * *" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每2小时", cron: "0 */2 * * *" },
  { label: "每天早上8点", cron: "0 8 * * *" },
  { label: "每天早上9点", cron: "0 9 * * *" },
  { label: "每周一早上9点", cron: "0 9 * * 1" },
  { label: "每月1号早上9点", cron: "0 9 1 * *" },
];

// ============================================================================
// Types
// ============================================================================

interface Props {
  onClose: () => void;
  cwd?: string;
}

interface TaskFormData {
  name: string;
  cron: string;
  config: {
    cwd: string;
    message: string;
    model?: { provider: string; modelId: string };
    toolNames?: string[];
  };
}

const EMPTY_FORM: TaskFormData = {
  name: "",
  cron: "0 9 * * *",
  config: { cwd: "", message: "" },
};

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

// ============================================================================
// Component
// ============================================================================

export function SchedulerPanel({ onClose, cwd }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskFormData>({ ...EMPTY_FORM, config: { ...EMPTY_FORM.config, cwd: cwd || "" } });
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEscapeClose(() => setModelDropdownOpen(false), modelDropdownOpen);
  useEscapeClose(onClose, !modelDropdownOpen);

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null;

  // Load tasks
  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = (await res.json()) as { tasks: ScheduledTask[] };
      setTasks(data.tasks);
    } catch {
      setError("加载任务列表失败");
    }
  }, []);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  // Fetch available models
  useEffect(() => {
    fetch("/api/models")
      .then((res) => res.json())
      .then((data: { modelList?: ApiModelOption[]; defaultModel?: { provider: string; modelId: string } | null }) => {
        if (data.modelList) {
          setModels(data.modelList.map((model) => ({
            provider: model.provider,
            modelId: model.id,
            name: model.name,
          })));
        }
        if (data.defaultModel) setDefaultModel(data.defaultModel);
      })
      .catch(() => { /* ignore */ });
  }, []);

  // Close model dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Populate form when selecting a task
  useEffect(() => {
    if (selectedTask) {
      const cfg = selectedTask.config as { cwd: string; message: string; model?: { provider: string; modelId: string }; toolNames?: string[] };
      setForm({
        name: selectedTask.name,
        cron: selectedTask.cron,
        config: {
          cwd: cfg.cwd || "",
          message: cfg.message || "",
          model: cfg.model,
          toolNames: cfg.toolNames,
        },
      });
      setIsCreating(false);
    }
  }, [selectedTask]);

  // -- Actions --

  const handleNew = () => {
    setSelectedId(null);
    setForm({ ...EMPTY_FORM, config: { ...EMPTY_FORM.config, cwd: cwd || "" } });
    setIsCreating(true);
    setError(null);
  };

  const handleSelect = (taskId: string) => {
    setSelectedId(taskId);
    setIsCreating(false);
    setError(null);
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      if (isCreating) {
        const res = await fetch("/api/scheduler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            type: "prompt",
            cron: form.cron,
            config: form.config,
          }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error || "创建失败");
        }
      } else if (selectedId) {
        const res = await fetch(`/api/scheduler/${selectedId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error || "更新失败");
        }
      }
      await fetchTasks();
      setIsCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!confirm("确定删除此定时任务？")) return;
    try {
      const res = await fetch(`/api/scheduler/${selectedId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      setSelectedId(null);
      setIsCreating(false);
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    try {
      const res = await fetch(`/api/scheduler/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      if (!res.ok) throw new Error("切换失败");
      await fetchTasks();
    } catch {
      setError("切换状态失败");
    }
  };

  const handleRunNow = async () => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/scheduler/${selectedId}/run`, { method: "POST" });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error || "执行失败");
      }
      // Refresh task list after a brief delay to let the runner start
      setTimeout(() => void fetchTasks(), 500);
      setTimeout(() => void fetchTasks(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行失败");
    } finally {
      setRunning(false);
    }
  };

  // -- Render helpers --

  const resultIcon = (task: ScheduledTask) => {
    if (!task.lastResult) return null;
    return task.lastResult === "success" ? (
      <span title="上次执行成功" style={{ color: "#22c55e", fontSize: 12 }}>✓</span>
    ) : (
      <span title={`上次执行失败: ${task.lastError || ""}`} style={{ color: "#ef4444", fontSize: 12 }}>✗</span>
    );
  };

  const logResultIcon = (log: TaskLog) => {
    return log.result === "success" ? (
      <span style={{ color: "#22c55e", fontWeight: 600 }}>✓ 成功</span>
    ) : (
      <span style={{ color: "#ef4444", fontWeight: 600 }}>✗ 失败</span>
    );
  };

  // Provider-grouped model options
  const modelGroups: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of models) {
    const group = modelGroups.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelGroups.push({ provider: opt.provider, options: [opt] });
  }

  const selectedModelName = (() => {
    const m = form.config.model;
    if (m) {
      const found = models.find((o) => o.provider === m.provider && o.modelId === m.modelId);
      return found ? found.name : `${m.provider}/${m.modelId}`;
    }
    if (defaultModel) {
      const found = models.find((o) => o.provider === defaultModel.provider && o.modelId === defaultModel.modelId);
      return found ? `默认 — ${found.name}` : `默认 — ${defaultModel.provider}/${defaultModel.modelId}`;
    }
    return models.length > 0 ? `默认 — ${models[0].name}` : "加载中...";
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="定时任务"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 820,
          maxWidth: "calc(100vw - 32px)",
          minHeight: 500,
          maxHeight: "calc(100vh - 64px)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--bg-panel)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>定时任务</div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              width: 32, height: 32, borderRadius: 8,
              border: "none", background: "transparent",
              color: "var(--text-muted)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Task list sidebar */}
          <div style={{
            width: 220, flexShrink: 0,
            borderRight: "1px solid var(--border)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0,
            }}>
              <button
                onClick={handleNew}
                style={{
                  width: "100%", padding: "6px 0", borderRadius: 8,
                  border: "1px dashed var(--border)", background: "transparent",
                  color: "var(--text-muted)", cursor: "pointer",
                  fontSize: 13, fontWeight: 600,
                }}
              >
                + 新建任务
              </button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "6px" }}>
              {tasks.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                  暂无定时任务
                </div>
              ) : (
                tasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => handleSelect(task.id)}
                    style={{
                      padding: "8px 10px", borderRadius: 8,
                      cursor: "pointer",
                      background: task.id === selectedId ? "var(--bg-selected)" : "transparent",
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(task); }}
                        title={task.enabled ? "已启用 — 点击禁用" : "已禁用 — 点击启用"}
                        style={{
                          width: 28, height: 16, borderRadius: 8,
                          border: "none", cursor: "pointer",
                          background: task.enabled ? "#22c55e" : "var(--border)",
                          position: "relative", flexShrink: 0,
                        }}
                      >
                        <span style={{
                          position: "absolute", top: 1,
                          left: task.enabled ? 13 : 1,
                          width: 14, height: 14, borderRadius: 7,
                          background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                          transition: "left 0.15s",
                        }} />
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {task.name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}>
                          <span>{task.cron}</span>
                          {resultIcon(task)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Editor panel */}
          <div style={{
            flex: 1, padding: "16px 20px",
            overflowY: "auto",
            display: "flex", flexDirection: "column", gap: 14,
          }}>
            {isCreating || selectedTask ? (
              <>
                {/* Task name */}
                <div>
                  <label style={labelStyle}>任务名称</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="例如：每日代码检查"
                    style={inputStyle}
                  />
                </div>

                {/* Cron expression */}
                <div>
                  <label style={labelStyle}>执行计划 (Cron 表达式)</label>
                  <input
                    value={form.cron}
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                    placeholder="0 9 * * *"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.cron}
                        onClick={() => setForm({ ...form, cron: preset.cron })}
                        style={{
                          padding: "2px 8px", borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: form.cron === preset.cron ? "var(--bg-selected)" : "transparent",
                          color: form.cron === preset.cron ? "var(--accent)" : "var(--text-dim)",
                          cursor: "pointer", fontSize: 11,
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* CWD */}
                <div>
                  <label style={labelStyle}>工作目录</label>
                  <input
                    value={form.config.cwd}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, cwd: e.target.value } })}
                    placeholder="/path/to/project"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </div>

                {/* AI prompt */}
                <div>
                  <label style={labelStyle}>AI 对话内容</label>
                  <textarea
                    value={form.config.message}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, message: e.target.value } })}
                    placeholder="发送给 AI 的指令，例如：请检查代码库中是否有未使用的导入"
                    rows={4}
                    style={{ ...inputStyle, resize: "vertical", minHeight: 80 }}
                  />
                </div>

                {/* Model selector */}
                <div ref={modelDropdownRef} style={{ position: "relative" }}>
                  <label style={labelStyle}>选择模型</label>
                  <button
                    onClick={() => setModelDropdownOpen((v) => !v)}
                    style={{
                      ...inputStyle,
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      cursor: "pointer", textAlign: "left",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "var(--bg)",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedModelName}
                    </span>
                    <span style={{ flexShrink: 0, marginLeft: 8, fontSize: 10, opacity: 0.5 }}>▼</span>
                  </button>

                  {modelDropdownOpen && (
                    <div
                      style={{
                        position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                        marginTop: 4, maxHeight: 240, overflowY: "auto",
                        background: "var(--bg-panel)", border: "1px solid var(--border)",
                        borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                      }}
                    >
                      <button
                        onClick={() => {
                          setForm({ ...form, config: { ...form.config, model: undefined } });
                          setModelDropdownOpen(false);
                        }}
                        style={{
                          display: "block", width: "100%", padding: "8px 12px",
                          border: "none", background: !form.config.model ? "var(--bg-selected)" : "transparent",
                          color: !form.config.model ? "var(--accent)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 13, textAlign: "left",
                          fontWeight: !form.config.model ? 600 : 400,
                        }}
                      >
                        使用默认模型
                      </button>
                      {modelGroups.map((group) => (
                        <div key={group.provider}>
                          <div style={{ padding: "4px 12px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: "1px solid var(--border)" }}>
                            {group.provider}
                          </div>
                          {group.options.map((opt) => {
                            const isSelected = form.config.model?.provider === opt.provider && form.config.model?.modelId === opt.modelId;
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                onClick={() => {
                                  setForm({ ...form, config: { ...form.config, model: { provider: opt.provider, modelId: opt.modelId } } });
                                  setModelDropdownOpen(false);
                                }}
                                style={{
                                  display: "block", width: "100%", padding: "7px 12px 7px 24px",
                                  border: "none", background: isSelected ? "var(--bg-selected)" : "transparent",
                                  color: isSelected ? "var(--accent)" : "var(--text)",
                                  cursor: "pointer", fontSize: 13, textAlign: "left",
                                  fontWeight: isSelected ? 600 : 400,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}
                              >
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Error */}
                {error && (
                  <div style={{ padding: "8px 12px", borderRadius: 8, background: "#fef2f2", color: "#dc2626", fontSize: 13 }}>
                    {error}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    {selectedTask && (
                      <>
                        <button
                          onClick={handleRunNow}
                          disabled={running}
                          style={{
                            padding: "8px 16px", borderRadius: 8,
                            border: "1px solid #22c55e", background: running ? "var(--border)" : "transparent",
                            color: running ? "var(--text-dim)" : "#22c55e", cursor: running ? "not-allowed" : "pointer",
                            fontSize: 13, fontWeight: 600,
                            display: "flex", alignItems: "center", gap: 4,
                          }}
                        >
                          {running ? "执行中..." : "▶ 手动执行"}
                        </button>
                        <button
                          onClick={handleDelete}
                          style={{
                            padding: "8px 16px", borderRadius: 8,
                            border: "1px solid #fca5a5", background: "transparent",
                            color: "#ef4444", cursor: "pointer", fontSize: 13, fontWeight: 600,
                          }}
                        >
                          删除任务
                        </button>
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => { setIsCreating(false); setSelectedId(null); setError(null); }}
                      style={{
                        padding: "8px 16px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "transparent",
                        color: "var(--text-muted)", cursor: "pointer", fontSize: 13,
                      }}
                    >
                      取消
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving || !form.name.trim()}
                      style={{
                        padding: "8px 20px", borderRadius: 8,
                        border: "none", background: saving || !form.name.trim() ? "var(--border)" : "var(--accent)",
                        color: "#fff", cursor: saving || !form.name.trim() ? "not-allowed" : "pointer",
                        fontSize: 13, fontWeight: 600,
                      }}
                    >
                      {saving ? "保存中..." : isCreating ? "创建" : "保存"}
                    </button>
                  </div>
                </div>

                {/* Execution log — only for existing tasks */}
                {selectedTask && (
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
                    <label style={{ ...labelStyle, marginBottom: 8 }}>
                      执行日志 ({selectedTask.runCount || 0} 次)
                    </label>
                    {(selectedTask.logs || []).length === 0 ? (
                      <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 13, background: "var(--bg)", borderRadius: 8 }}>
                        暂无执行记录
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" }}>
                        {(selectedTask.logs || []).map((log) => (
                          <div
                            key={log.id}
                            style={{
                              padding: "10px 12px",
                              borderRadius: 8,
                              background: "var(--bg)",
                              border: "1px solid var(--border)",
                              fontSize: 12,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: log.output || log.error ? 6 : 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {logResultIcon(log)}
                                <span style={{ color: "var(--text-dim)" }}>{formatTime(log.timestamp)}</span>
                                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                                  {formatDuration(log.durationMs)}
                                </span>
                              </div>
                            </div>
                            {log.error && (
                              <div style={{ color: "#ef4444", fontSize: 11, fontFamily: "var(--font-mono)", wordBreak: "break-all", lineHeight: 1.5 }}>
                                {log.error}
                              </div>
                            )}
                            {log.output && (
                              <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5, marginTop: log.error ? 4 : 0 }}>
                                {log.output}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-dim)", fontSize: 13 }}>
                选择一个任务或创建新任务
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Shared styles --
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 4,
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box" as const,
};
