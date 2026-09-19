"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { notifyApp } from "@/lib/app-notifications";
import { findEmptyModelId } from "@/lib/models-config-validation";
import { parseProviderConfigJson, serializeProviderConfig } from "@/lib/models-config-transfer";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import { AppIcon } from "@/components/AppIcon";
import styles from "./ModelsConfig.module.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  fastMode?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface RecoveryFallbackModel {
  provider: string;
  modelId: string;
}
type AutoRecoveryModel = RecoveryFallbackModel | null;

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
  providerProxies?: Record<string, string>;
  autoRecoveryModels?: AutoRecoveryModel[];
  /** 全局唯一的 Flash 模型，用于解释选中文字等轻量快速任务。 */
  flashModel?: RecoveryFallbackModel | null;
}

let cachedModelsConfig: ModelsJson | null = null;
let modelsConfigRequest: Promise<ModelsJson> | null = null;
let modelsConfigFetchedAt = 0;

export function preloadModelsConfigData(forceRefresh = false): Promise<ModelsJson> {
  if (cachedModelsConfig && (!forceRefresh || Date.now() - modelsConfigFetchedAt < 1_000)) {
    return Promise.resolve(cachedModelsConfig);
  }
  if (!modelsConfigRequest) {
    modelsConfigRequest = fetch("/api/models-config")
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ModelsJson>;
      })
      .then((data) => {
        const normalized = data.providers ? data : { ...data, providers: {} };
        cachedModelsConfig = normalized;
        modelsConfigFetchedAt = Date.now();
        return normalized;
      })
      .catch((error) => {
        modelsConfigRequest = null;
        throw error;
      })
      .finally(() => {
        modelsConfigRequest = null;
      });
  }
  return modelsConfigRequest;
}

function firstProviderSelection(config: ModelsJson): Selection | null {
  const name = Object.keys(config.providers ?? {})[0];
  return name ? { type: "provider", name } : null;
}

async function copyText(text: string): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:clipboard-manager|write_text", { text });
      return;
    } catch { /* use the browser fallback */ }
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* use the selection fallback */ }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("浏览器拒绝了剪贴板写入");
  } finally {
    textarea.remove();
  }
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string; testMode?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number; testMode?: string; debugPayload?: string };

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "recovery" }
  | { type: "flash" };

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, mono, autoFocus, spellCheck, disabled }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; autoFocus?: boolean; spellCheck?: boolean; disabled?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
    spellCheck={spellCheck} disabled={disabled}
    onFocus={autoFocus ? (e) => e.currentTarget.select() : undefined}
    className={`${styles.input} ${mono ? styles.mono : ""}`} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={`${styles.input} ${styles.secretInput} ${mono ? styles.mono : ""}`}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "隐藏 API 密钥" : "显示 API 密钥"}
        title={visible ? "隐藏 API 密钥" : "显示 API 密钥"}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={styles.input} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={styles.input} data-empty={!value}>
      {!required && <option value="">— 继承 / 无 —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.checkLabel}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className={styles.checkbox} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className={styles.sectionTitle}>{children}</div>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={styles.switchControl}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" className={styles.switchTrack} data-checked={checked}>
        <span className={styles.switchThumb} />
      </span>
    </button>
  );
}

// ── Provider detail ───────────────────────────────────────────────────────────

type ProxyStatus =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; ip: string; country: string; countryCode: string }
  | { phase: "error"; message: string };

function ProviderDetail({ name, provider, proxyUrl, focusName, onChange, onProxyChange, onRename, onDelete }: {
  name: string; provider: ProviderEntry;
  proxyUrl: string;
  focusName?: boolean;
  onChange: (p: ProviderEntry) => void;
  onProxyChange: (value: string) => void;
  onRename: (n: string) => void;
  onDelete: () => void;
}) {
  const [editingName, setEditingName] = useState(name);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>({ phase: "idle" });
  const proxyProbeId = useRef(0);
  const proxyEnabled = Boolean(proxyUrl.trim());
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  const probeProxy = useCallback(async (url: string) => {
    const probeId = ++proxyProbeId.current;
    setProxyStatus({ phase: "testing" });
    try {
      const response = await fetch("/api/models-config/proxy-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl: url }),
      });
      const data = await response.json() as {
        node?: { ip?: string; country?: string; countryCode?: string };
        error?: string;
      };
      if (!response.ok || !data.node?.ip) throw new Error(data.error || `HTTP ${response.status}`);
      if (probeId !== proxyProbeId.current) return;
      setProxyStatus({
        phase: "success",
        ip: data.node.ip,
        country: data.node.country || "未知地区",
        countryCode: data.node.countryCode || "",
      });
    } catch (error) {
      if (probeId !== proxyProbeId.current) return;
      setProxyStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  return (
    <div className={styles.detailForm}>
      <div className={styles.detailHeading}>
        <SectionTitle>服务商</SectionTitle>
        <Button variant="danger" size="sm" onClick={onDelete}>删除</Button>
      </div>

      <Field label="服务商名称">
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono autoFocus={focusName} />
        {editingName !== name && editingName.trim() && (
          <Button variant="secondary" size="sm" className={styles.inlineAction} onClick={() => onRename(editingName.trim())}>重命名</Button>
        )}
      </Field>

      <Field label="接口地址 (Base URL)">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API 密钥 (API Key)">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span className={styles.fieldHint}>
          以 <code style={{ fontFamily: "var(--font-mono)" }}>!</code> 开头可运行 Shell 命令获取密钥，或直接使用环境变量名称
        </span>
      </Field>

      <Field label="API 格式">
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>

      <Field label="本地代理">
        <div className={styles.proxyInputRow}>
          <TextInput
            value={proxyUrl}
            onChange={(value) => {
              proxyProbeId.current += 1;
              onProxyChange(value);
              setProxyStatus({ phase: "idle" });
            }}
            placeholder="http://127.0.0.1:7897"
            mono
            spellCheck={false}
            disabled={!proxyEnabled}
          />
          <Switch
            checked={proxyEnabled}
            label={proxyEnabled ? "关闭代理" : "启用代理"}
            onChange={(enabled) => {
              const nextProxyUrl = enabled ? proxyUrl.trim() || "http://127.0.0.1:7897" : "";
              onProxyChange(nextProxyUrl);
              if (enabled) void probeProxy(nextProxyUrl);
              else {
                proxyProbeId.current += 1;
                setProxyStatus({ phase: "idle" });
              }
            }}
          />
        </div>
        {proxyStatus.phase === "testing" && <span role="status" className={styles.proxyStatus}>正在探测代理出口...</span>}
        {proxyStatus.phase === "success" && (
          <span role="status" className={styles.proxyStatus}>
            接入节点 <strong>{proxyStatus.ip}</strong>
            <span className={styles.proxyDivider}>·</span>
            {proxyStatus.countryCode && <span className={styles.countryCode}>{proxyStatus.countryCode}</span>}
            <span>{proxyStatus.country}</span>
          </span>
        )}
        {proxyStatus.phase === "error" && <span role="alert" className={`${styles.proxyStatus} ${styles.proxyError}`}>代理连接失败：{proxyStatus.message}</span>}
      </Field>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div className={styles.thinkingMap}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";

        return (
          <div key={level} className={styles.thinkingRow}>
            <span className={styles.thinkingLevel} data-disabled={state === "null"}>{level}</span>
            <div className={styles.thinkingOptions}>
              <button type="button" aria-pressed={state === "omit"} onClick={() => setLevel(level, "omit")}>默认</button>
              <button type="button" data-danger={state === "null"} aria-pressed={state === "null"} onClick={() => setLevel(level, null)}>禁用</button>
              <div className={styles.thinkingCustom} data-active={state === "string"}>
                <button type="button" aria-pressed={state === "string"} onClick={() => setLevel(level, strVal || level)}>自定义</button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
              />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const [testMode, setTestMode] = useState<"text" | "image">("text");
  const hasImageInput = model.input?.includes("image") ?? false;
  const effectiveApi = model.api ?? provider.api;
  const supportsFastMode = effectiveApi === "openai-responses";
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const setApi = (api: string) => onChange({
    ...model,
    api: api || undefined,
    ...(api && api !== "openai-responses" ? { fastMode: undefined } : {}),
  });
  const setFastMode = (enabled: boolean) => onChange({
    ...model,
    ...(enabled ? { api: "openai-responses", fastMode: true } : { fastMode: undefined }),
  });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return "正在测试模型连接...";
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    const modeLabel = testState.testMode === "image" ? "图片测试" : "";
    if (testState.phase === "success") {
      return ["连接成功", modeLabel || null, ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    if (testState.phase === "error") {
      const parts = ["连接失败", modeLabel || null, ...meta, testState.message].filter(Boolean);
      // Image test failed with 400 → model likely doesn't support images
      if (testState.testMode === "image" && testState.status === 400) {
        parts.push("该模型可能不支持图片输入，请检查模型配置");
      }
      return parts.join(" · ");
    }
    return null;
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model, testMode }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
        debugPayload?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
          testMode,
          debugPayload: d.debugPayload,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
        testMode,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e), testMode });
    }
  }, [model, provider, providerName, testState.phase, testMode]);

  return (
    <div className={styles.detailForm}>
      <div className={styles.detailHeading}>
        <SectionTitle>Model</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: "none",
                borderRadius: 4,
                background: testState.phase === "error" ? "var(--danger-bg)" : testState.phase === "success" ? "var(--success-bg)" : "var(--bg-panel)",
                color: testState.phase === "error" ? "var(--danger)" : testState.phase === "success" ? "var(--success)" : "var(--text-muted)",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          {/* Test mode toggle: text / image */}
          {hasImageInput && testState.phase !== "testing" && (
            <div style={{
              display: "flex",
              borderRadius: 4,
              border: "none",
              padding: 2,
              gap: 2,
              background: "var(--bg-panel)",
              overflow: "hidden",
              flexShrink: 0,
              height: 24,
            }}>
              {(["text", "image"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setTestMode(mode)}
                  title={mode === "text" ? "纯文本测试" : "图片输入测试"}
                  style={{
                    padding: "0 8px",
                    height: "100%",
                    background: testMode === mode ? "var(--bg-selected)" : "transparent",
                    border: "none",
                    color: testMode === mode ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: testMode === mode ? 600 : 400,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    whiteSpace: "nowrap",
                  }}
                >
                  {mode === "image" ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 7 4 4 20 4 20 7" />
                      <line x1="9" y1="20" x2="15" y2="20" />
                      <line x1="12" y1="4" x2="12" y2="20" />
                    </svg>
                  )}
                  {mode === "text" ? "文本" : "图片"}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={testMode === "image" ? "测试图片输入能力" : "测试模型连接"}
            style={{
              height: 24,
              padding: "0 10px",
              background: testState.phase === "success" ? "var(--success-bg)" : "var(--bg-panel)",
              border: "none",
              borderRadius: 4,
              color: testState.phase === "success" ? "var(--success)" : (!model.id.trim() || testState.phase === "testing") ? "var(--text-dim)" : "var(--text-muted)",
              cursor: (!model.id.trim() || testState.phase === "testing") ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "testing" && (
              testMode === "image" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              ) : null
            )}
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing" ? "测试中…" : testState.phase === "success" ? "正常" : "测试"}
          </button>
          <button onClick={onDelete}
            style={{ height: 24, padding: "0 8px", background: "var(--danger-bg)", border: "none", borderRadius: 4, color: "var(--danger)", cursor: "pointer", fontSize: 11, boxSizing: "border-box" }}>
            移除
          </button>
        </div>
      </div>
      {testState.phase === "error" && testState.debugPayload && (
        <details style={{ fontSize: 10, opacity: 0.65, marginTop: 2 }}>
          <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>调试：API 请求体</summary>
          <pre style={{ margin: 0, marginTop: 4, padding: 6, background: "var(--bg-hover)", borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 120, overflow: "auto" }}>{testState.debugPayload}</pre>
        </details>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="模型 ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label="显示名称"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder="Display name" /></Field>
      </div>

      <Field label="API 格式覆盖">
        <Select value={model.api ?? ""} onChange={setApi} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check label="推理过程 / 思考" checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label="图片输入" checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
        <label
          title={supportsFastMode ? "请求 Priority 服务等级；上游可能忽略或降级" : "开启后会自动切换为 openai-responses API 格式"}
          className={styles.checkLabel}
        >
          <input
            type="checkbox"
            checked={model.fastMode ?? false}
            onChange={(event) => setFastMode(event.target.checked)}
          />
          快速模式（Priority）
        </label>
      </div>
      {model.fastMode && supportsFastMode && (
        <div style={{ marginTop: -4, fontSize: 10, color: "var(--text-dim)" }}>
          每次请求将携带 service_tier: priority；是否生效由模型服务或中转决定，通常会增加额度消耗。
        </div>
      )}

      {model.reasoning && (
        <>
          <Check
            label="DeepSeek 思考格式兼容"
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>推理强度映射</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  className={styles.textAction}
                >
                  清空
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor
              value={model.thinkingLevelMap}
              onChange={(v) => set("thinkingLevelMap", v)}
            />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="上下文窗口 (Tokens)">
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label="最大输出 Tokens">
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
        </Field>
      </div>

      <div>
        <SectionTitle>计费价格 (每百万 Tokens)</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => {
            const labelsMap = { input: "输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入" };
            return (
              <Field key={k} label={labelsMap[k]}>
                <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
              </Field>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RecoveryFallbackEditor({
  value,
  models,
  onChange,
}: {
  value: AutoRecoveryModel[] | undefined;
  models: { provider: string; modelId: string; label: string }[];
  onChange: (v: AutoRecoveryModel[] | undefined) => void;
}) {
  const current = value ?? [];
  const setLevel = (index: number, raw: string) => {
    const next: AutoRecoveryModel[] = [...current];
    if (!raw) {
      next[index] = null;
    } else {
      const [provider, ...rest] = raw.split(":");
      const modelId = rest.join(":");
      next[index] = { provider, modelId };
    }
    const trimmed = next.slice(0, 3);
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === null) trimmed.pop();
    onChange(trimmed.length ? trimmed : undefined);
  };

  return (
    <div className={styles.detailForm}>
      <div>
        <SectionTitle>自动续跑兜底</SectionTitle>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          激进模式自动执行“中断并继续”时，会按恢复次数切换模型后再发送继续指令。留空则沿用当前会话模型。
        </p>
      </div>

      {[0, 1, 2].map((index) => {
        const selected = current[index] ? `${current[index].provider}:${current[index].modelId}` : "";
        return (
          <Field key={index} label={`第 ${index + 1} 次自动恢复`}>
            <select
              value={selected}
              onChange={(e) => setLevel(index, e.target.value)}
              className={styles.input}
            >
              <option value="">沿用当前模型</option>
              {models.map((m) => (
                <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function FlashModelEditor({
  value,
  models,
  onChange,
}: {
  value: RecoveryFallbackModel | null | undefined;
  models: { provider: string; modelId: string; label: string }[];
  onChange: (v: RecoveryFallbackModel | null) => void;
}) {
  const selected = value ? `${value.provider}:${value.modelId}` : "";
  return (
    <div className={styles.detailForm}>
      <div>
        <SectionTitle>Flash 模型</SectionTitle>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          全局唯一的轻量模型，用于解释选中文字这类短任务。留空则沿用当前会话模型。
        </p>
      </div>
      <Field label="模型">
        <select
          value={selected}
          onChange={(e) => {
            const raw = e.target.value;
            if (!raw) {
              onChange(null);
              return;
            }
            const [provider, ...rest] = raw.split(":");
            onChange({ provider, modelId: rest.join(":") });
          }}
          className={styles.input}
        >
          <option value="">沿用当前会话模型</option>
          {models.map((m) => (
            <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
export function ModelsConfig({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [config, setConfig] = useState<ModelsJson>(() => cachedModelsConfig ?? { providers: {} });
  const [loading, setLoading] = useState(cachedModelsConfig === null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(() => cachedModelsConfig ? firstProviderSelection(cachedModelsConfig) : null);
  const [newProviderName, setNewProviderName] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const providerRowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEscapeClose(onClose, !importOpen);

  useEffect(() => {
    let cancelled = false;
    preloadModelsConfigData(true)
      .then((normalized) => {
        if (cancelled) return;
        setConfig(normalized);
        setSelection((current) => current ?? firstProviderSelection(normalized));
      })
      .catch(() => {
        if (!cancelled && !cachedModelsConfig) setConfig({ providers: {} });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const addCustomProvider = useCallback(() => {
    if (loading) return;
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setNewProviderName(finalName);
    setSelection({ type: "provider", name: finalName });
  }, [config.providers, loading]);

  useEffect(() => {
    if (selection?.type !== "provider" || selection.name !== newProviderName) return;
    const frame = requestAnimationFrame(() => {
      providerRowRefs.current.get(selection.name)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [newProviderName, selection]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setConfig((prev) => {
      const proxies = { ...(prev.providerProxies ?? {}) };
      if (oldName in proxies) {
        proxies[newName] = proxies[oldName];
        delete proxies[oldName];
      }
      return { ...prev, providerProxies: proxies };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      const providerProxies = { ...(prev.providerProxies ?? {}) };
      delete providerProxies[name];
      return { ...prev, providers, providerProxies };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
  }, []);

  const updateAutoRecoveryModels = useCallback((models: AutoRecoveryModel[] | undefined) => {
    setConfig((prev) => ({ ...prev, autoRecoveryModels: models }));
  }, []);

  const updateFlashModel = useCallback((model: RecoveryFallbackModel | null) => {
    setConfig((prev) => ({ ...prev, flashModel: model }));
  }, []);

  const selectedProviderName = selection?.type === "provider"
    ? selection.name
    : selection?.type === "model"
      ? selection.providerName
      : null;

  const handleCopyProvider = useCallback(async () => {
    if (!selectedProviderName) return;
    const provider = config.providers?.[selectedProviderName];
    if (!provider) return;
    setTransferNotice(null);
    try {
      await copyText(serializeProviderConfig(
        selectedProviderName,
        provider as unknown as Record<string, unknown>,
      ));
      setTransferNotice(`已复制 ${selectedProviderName} 的完整配置（包含 API Key）`);
    } catch (error) {
      setTransferNotice(error instanceof Error ? error.message : "复制失败");
    }
  }, [config.providers, selectedProviderName]);

  const handleImport = useCallback(() => {
    try {
      const imported = parseProviderConfigJson(importText);
      const names = Object.keys(imported);
      setConfig((prev) => ({
        ...prev,
        providers: {
          ...(prev.providers ?? {}),
          ...(imported as unknown as Record<string, ProviderEntry>),
        },
      }));
      setSelection({ type: "provider", name: names[0] });
      setNewProviderName(null);
      setSaveError(null);
      setSavedOk(false);
      setTransferNotice(`已导入 ${names.length} 个服务商，请保存配置`);
      setImportOpen(false);
      setImportText("");
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败");
    }
  }, [importText]);

  const handleSave = useCallback(async () => {
    const invalidModel = findEmptyModelId(config);
    if (invalidModel) {
      setSaveError(invalidModel.message);
      setSavedOk(false);
      setSelection({ type: "model", providerName: invalidModel.provider, index: invalidModel.index });
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        cachedModelsConfig = config;
        modelsConfigFetchedAt = Date.now();
        setSavedOk(true);
        notifyApp("deerhux.models-updated");
        onSaved?.();
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, onSaved]);

  const providers = Object.entries(config.providers ?? {});
  const modelOptions = providers.flatMap(([providerName, provider]) =>
    (provider.models ?? [])
      .filter((model) => model.id.trim())
      .map((model) => ({
        provider: providerName,
        modelId: model.id.trim(),
        label: `${model.name?.trim() || model.id.trim()} (${providerName}/${model.id.trim()})`,
      }))
  );

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "recovery") {
      return (
        <RecoveryFallbackEditor
          value={config.autoRecoveryModels}
          models={modelOptions}
          onChange={updateAutoRecoveryModels}
        />
      );
    }
    if (selection.type === "flash") {
      return (
        <FlashModelEditor
          value={config.flashModel}
          models={modelOptions}
          onChange={updateFlashModel}
        />
      );
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          proxyUrl={config.providerProxies?.[selection.name] ?? ""}
          focusName={selection.name === newProviderName}
          onChange={(p) => updateProvider(selection.name, p)}
          onProxyChange={(value) => setConfig((prev) => {
            const providerProxies = { ...(prev.providerProxies ?? {}) };
            if (value) providerProxies[selection.name] = value;
            else delete providerProxies[selection.name];
            return { ...prev, providerProxies };
          })}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
    <ModalShell
      onClose={onClose}
      title="模型配置"
      subtitle={<code className={styles.configPath}>~/.deerhux/agent/models.json</code>}
      className={styles.modelPanel}
      bodyClassName={styles.detailBody}
      sidebar={(
        <nav className={styles.tree} aria-label="模型供应商">
          <button
            type="button"
            className={`${styles.treeItem} ${selection?.type === "recovery" ? styles.treeItemActive : ""}`}
            onClick={() => setSelection({ type: "recovery" })}
          >
            <AppIcon name="refresh" size="compact" />
            <span>自动续跑兜底</span>
          </button>
          <button
            type="button"
            className={`${styles.treeItem} ${selection?.type === "flash" ? styles.treeItemActive : ""}`}
            onClick={() => setSelection({ type: "flash" })}
          >
            <AppIcon name="steer" size="compact" />
            <span>Flash 模型</span>
          </button>
          {providers.length > 0 && <div className={styles.treeLabel}>供应商</div>}
          {loading ? <div className={styles.loadingText}>加载中…</div> : providers.map(([pName, pData]) => {
            const isProviderSelected = selection?.type === "provider" && selection.name === pName;
            const models = pData.models ?? [];
            return (
              <div key={pName} className={styles.providerGroup}>
                <button
                  ref={(node) => {
                    if (node) providerRowRefs.current.set(pName, node);
                    else providerRowRefs.current.delete(pName);
                  }}
                  type="button"
                  className={`${styles.treeItem} ${isProviderSelected ? styles.treeItemActive : ""}`}
                  onClick={() => setSelection({ type: "provider", name: pName })}
                >
                  <AppIcon name="model" size="compact" />
                  <span className={styles.providerName}>{pName}</span>
                </button>
                {models.map((model, index) => {
                  const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === index;
                  return (
                    <button
                      type="button"
                      key={`${model.id}-${index}`}
                      className={`${styles.modelItem} ${isModelSelected ? styles.treeItemActive : ""}`}
                      onClick={() => setSelection({ type: "model", providerName: pName, index })}
                    >
                      <span>{model.id || "新模型"}</span>
                      {model.reasoning && <small>推理</small>}
                    </button>
                  );
                })}
                <button type="button" className={styles.addModel} onClick={() => addModel(pName)}>
                  <AppIcon name="add" size="inline" />
                  <span>添加模型</span>
                </button>
              </div>
            );
          })}
        </nav>
      )}
      sidebarFooter={(
        <Button variant="ghost" className={styles.fullWidth} leadingIcon="add" disabled={loading} onClick={addCustomProvider}>
          {loading ? "加载中…" : "添加服务商"}
        </Button>
      )}
      actions={(
        <div className={styles.headerActions}>
          <Button variant="ghost" size="sm" leadingIcon="copy" disabled={!selectedProviderName || loading} onClick={() => void handleCopyProvider()}>
            复制 JSON
          </Button>
          <Button variant="ghost" size="sm" leadingIcon="import" disabled={loading} onClick={() => { setImportError(null); setImportOpen(true); }}>
            导入 JSON
          </Button>
        </div>
      )}
      footer={(
        <>
          {saveError ? <span role="alert" className={`${styles.footerStatus} ${styles.footerError}`}>{saveError}</span>
            : <span role="status" className={styles.footerStatus}>{transferNotice}</span>}
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" leadingIcon={savedOk ? "check" : undefined} disabled={saving || savedOk} onClick={handleSave}>
            {savedOk ? "已保存" : saving ? "保存中…" : "保存"}
          </Button>
        </>
      )}
    >
      {loading ? null : detailContent ?? <div className={styles.emptyDetail}>请在左侧选择服务商或模型进行配置</div>}
    </ModalShell>
    <ModalShell
      open={importOpen}
      onClose={() => {
        setImportOpen(false);
        setImportError(null);
      }}
      title="导入模型供应商 JSON"
      subtitle="同名服务商会被导入内容替换"
      layout="confirm"
      raised
      footer={(
        <>
          <Button variant="ghost" onClick={() => setImportOpen(false)}>取消</Button>
          <Button variant="primary" disabled={!importText.trim()} onClick={handleImport}>导入到编辑器</Button>
        </>
      )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <textarea
          value={importText}
          onChange={(event) => {
            setImportText(event.target.value);
            setImportError(null);
          }}
          placeholder={'{\n  "providers": {\n    "provider-name": { ... }\n  }\n}'}
          aria-label="供应商配置 JSON"
          spellCheck={false}
          className={`${styles.input} ${styles.importTextarea}`}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          导入内容可包含 API Key。Key 将以明文进入当前配置，并在保存后写入本机 models.json。
        </div>
        {importError && <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>{importError}</div>}
      </div>
    </ModalShell>
    </>
  );
}
