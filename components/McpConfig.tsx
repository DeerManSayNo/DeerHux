"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getClientApiErrorMessage, readControlPlaneJson, writeControlPlaneJson } from "@/lib/client-api";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import styles from "./ui/Form.module.css";

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

  const statusDot = (status: McpServerStatus["status"] | "enabled" | "disabled") =>
    status === "connected" || status === "enabled"
      ? styles.dotSuccess
      : status === "error"
        ? styles.dotDanger
        : status === "unsupported"
          ? styles.dotWarning
          : styles.dotNeutral;

  return (
    <ModalShell
      onClose={onClose}
      layout="split"
      ariaLabel="MCP"
      title="MCP"
      subtitle="Model Context Protocol"
      sidebarFooter={
        <Button variant="secondary" leadingIcon="add" disabled={!canMutate} onClick={add} className={styles.fullWidth}>
          新建服务
        </Button>
      }
      sidebar={
        loading ? (
          <div className={styles.emptyText}>加载中...</div>
        ) : servers.length === 0 ? (
          <div className={styles.emptyText}>暂无 MCP 服务</div>
        ) : (
          servers.map((server) => {
            const active = server.id === selected?.id;
            return (
              <button
                key={server.id}
                type="button"
                onClick={() => setSelectedId(server.id)}
                aria-current={active}
                className={
                  active ? `${styles.scopeButton} ${styles.scopeButtonActive}` : styles.scopeButton
                }
              >
                <div className={styles.scopeRow}>
                  <span className={`${styles.dot} ${statusDot(server.enabled ? "enabled" : "disabled")}`} />
                  <span className={styles.scopeName}>{server.name}</span>
                  <span className={styles.pill}>{server.transport}</span>
                </div>
                <div className={styles.scopeMeta}>
                  {server.description ||
                    (server.transport === "stdio"
                      ? server.command || "未配置命令"
                      : server.url || "未配置 URL")}
                </div>
              </button>
            );
          })
        )
      }
      actions={
        <>
          <div className={styles.headerMain}>
            <div className={styles.mainTitle}>{selected?.name ?? "MCP 服务配置"}</div>
            <div className={styles.subtitle}>
              配置会保存到 ~/.deerhux/agent/mcp.json；启用的 stdio 服务会在 Agent 会话启动时注入为工具。
            </div>
          </div>
          {selected ? (
            <Button variant="danger" disabled={!canMutate} onClick={remove}>
              删除
            </Button>
          ) : null}
          <Button variant="secondary" disabled={testing || !canMutate} onClick={testConnection}>
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button variant="primary" disabled={saving || !canMutate} onClick={save}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </>
      }
    >
      {!selected ? (
        <div className={styles.centeredEmpty}>
          <span className={styles.emptyText}>{loadMessage || "暂无 MCP 服务。"}</span>
          <Button variant="primary" disabled={!canMutate} onClick={add}>
            创建第一个 MCP 服务
          </Button>
        </div>
      ) : (
        <fieldset disabled={!canMutate} className={styles.form}>
          <div className={styles.gridTwo}>
            <label className={styles.label}>
              服务名称
              <input
                value={selected.name}
                onChange={(e) => updateSelected({ name: e.target.value })}
                className={styles.input}
              />
            </label>
            <label className={styles.label}>
              传输类型
              <select
                value={selected.transport}
                onChange={(e) => updateSelected({ transport: e.target.value as McpTransport })}
                className={styles.input}
              >
                <option value="stdio">stdio</option>
                <option value="sse">sse</option>
                <option value="http">http</option>
              </select>
            </label>
          </div>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={selected.enabled}
              onChange={(e) => updateSelected({ enabled: e.target.checked })}
            />
            启用该服务
          </label>

          <label className={styles.label}>
            描述
            <input
              value={selected.description ?? ""}
              onChange={(e) => updateSelected({ description: e.target.value })}
              className={styles.input}
            />
          </label>

          {selected.transport === "stdio" ? (
            <>
              <div className={styles.gridTwo}>
                <label className={styles.label}>
                  Command
                  <input
                    value={selected.command ?? ""}
                    onChange={(e) => updateSelected({ command: e.target.value })}
                    placeholder="例如：npx"
                    className={styles.input}
                  />
                </label>
                <label className={styles.label}>
                  stdio framing
                  <select
                    value={selected.stdioFraming ?? "auto"}
                    onChange={(e) => updateSelected({ stdioFraming: e.target.value as McpStdioFraming })}
                    className={styles.input}
                  >
                    <option value="auto">auto（推荐）</option>
                    <option value="newline">newline（现代 MCP）</option>
                    <option value="content-length">content-length（旧服务）</option>
                  </select>
                </label>
              </div>
              <label className={styles.label}>
                Args（每行一个参数）
                <textarea
                  value={argsText(selected)}
                  onChange={(e) => updateSelected({ args: parseLines(e.target.value) })}
                  rows={5}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/project"}
                  className={`${styles.textarea} ${styles.mono}`}
                />
              </label>
            </>
          ) : (
            <label className={styles.label}>
              URL
              <input
                value={selected.url ?? ""}
                onChange={(e) => updateSelected({ url: e.target.value })}
                placeholder="https://..."
                className={styles.input}
              />
            </label>
          )}

          <label className={styles.label}>
            环境变量（每行 KEY=VALUE）
            <textarea
              value={envText(selected)}
              onChange={(e) => updateSelected({ env: parseEnv(e.target.value) })}
              rows={5}
              placeholder="API_KEY=..."
              className={`${styles.textarea} ${styles.mono}`}
            />
          </label>

          {loadMessage && (
            <div role="alert" className={styles.errorBox}>
              加载失败：{loadMessage}。为防止覆盖现有配置，暂不可编辑。
            </div>
          )}
          {testMessage && <div className={styles.hintBox}>{testMessage}</div>}
          {saveMessage && <div className={styles.hintBox}>{saveMessage}</div>}

          {testStatuses.length > 0 && (
            <div className={styles.statusList}>
              {testStatuses.map((status) => (
                <div
                  key={status.id}
                  className={
                    status.status === "connected"
                      ? `${styles.statusRow} ${styles.statusRowSuccess}`
                      : status.status === "error"
                        ? `${styles.statusRow} ${styles.statusRowDanger}`
                        : styles.statusRow
                  }
                >
                  <div className={styles.statusHead}>
                    <span className={`${styles.dot} ${statusDot(status.status)}`} />
                    <strong>{status.name}</strong>
                    <span className={styles.pill}>{status.transport}</span>
                    <span className={styles.pill}>{status.status}</span>
                    <span className={styles.pill}>{status.toolCount} tools</span>
                    {status.stdioFraming && <span className={styles.pill}>{status.stdioFraming}</span>}
                  </div>
                  {status.errorMessage && <div className={styles.statusError}>{status.errorMessage}</div>}
                </div>
              ))}
            </div>
          )}
        </fieldset>
      )}
    </ModalShell>
  );
}
