"use client";

import { useEffect, useMemo, useState } from "react";
import type { LoadedExtensionsView } from "@/lib/extensions/types";
import { Button } from "@/components/ui/Button";
import { ModalShell } from "@/components/ui/Modal";
import styles from "./ExtensionsConfig.module.css";

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className={styles.tag}>{children}</span>;
}

export function ExtensionsConfig({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const [data, setData] = useState<LoadedExtensionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}&mcpRuntime=1`)
      .then((res) => res.ok ? res.json() : res.json().then((payload) => Promise.reject(new Error(payload.error ?? `HTTP ${res.status}`))))
      .then((json: LoadedExtensionsView) => setData(json))
      .catch((loadError) => setError(String(loadError)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => data ? {
    skillsEnabled: data.skills.filter((skill) => skill.enabled).length,
    mcpEnabled: data.mcpServers.filter((server) => server.enabled).length,
    toolsEnabled: data.tools.filter((tool) => tool.enabled).length,
    warnings: data.diagnostics.filter((diagnostic) => diagnostic.level !== "info").length,
  } : null, [data]);

  return (
    <ModalShell
      onClose={onClose}
      layout="content"
      title="扩展总览"
      subtitle={<code className={styles.path}>{cwd}</code>}
      actions={<Button variant="ghost" size="sm" leadingIcon="refresh" disabled={loading} onClick={load}>{loading ? "刷新中" : "刷新"}</Button>}
      className={styles.panel}
      bodyClassName={styles.body}
    >
      {loading && !data ? <Empty>正在加载扩展...</Empty> : null}
      {error ? <div role="alert" className={styles.error}>{error}</div> : null}
      {data && summary ? (
        <>
          <div className={styles.summary} aria-label="扩展摘要">
            <span><strong>{summary.skillsEnabled}</strong> / {data.skills.length} Skills</span>
            <span><strong>{summary.mcpEnabled}</strong> / {data.mcpServers.length} MCP</span>
            <span><strong>{summary.toolsEnabled}</strong> / {data.tools.length} Tools</span>
            <span data-warning={summary.warnings > 0}><strong>{summary.warnings}</strong> 条诊断需关注</span>
          </div>

          <section className={styles.section}>
            <header><h3>Skills</h3><span>{data.skills.length} 个</span></header>
            {data.skills.length === 0 ? <Empty>暂无 Skills</Empty> : <div className={styles.rows}>
              {data.skills.map((skill) => (
                <div key={skill.filePath} className={styles.row}>
                  <span className={`${styles.dot} ${skill.enabled ? styles.dotActive : ""}`} />
                  <strong>{skill.name}</strong>
                  <Tag>{skill.sourceLabel ?? skill.source}</Tag>
                  {skill.canDelete ? <Tag>可管理</Tag> : null}
                  {skill.canImportToDeerHux ? <Tag>可导入</Tag> : null}
                  <code title={skill.filePath}>{skill.filePath}</code>
                </div>
              ))}
            </div>}
          </section>

          <section className={styles.section}>
            <header><h3>MCP 服务</h3><span>{data.mcpServers.length} 个</span></header>
            {data.mcpServers.length === 0 ? <Empty>暂无 MCP 服务配置</Empty> : <div className={styles.rows}>
              {data.mcpServers.map((server) => {
                const runtimeStatus = server.runtimeStatus ?? (server.enabled ? "unknown" : "disabled");
                return <div key={server.id} className={styles.stackRow}>
                  <div className={styles.row}>
                    <span className={styles.dot} data-status={runtimeStatus} />
                    <strong>{server.name}</strong>
                    <Tag>{server.transport}</Tag><Tag>{runtimeStatus}</Tag>
                    {typeof server.runtimeToolCount === "number" ? <Tag>{server.runtimeToolCount} tools</Tag> : null}
                    <span className={styles.description}>{server.description}</span>
                  </div>
                  {server.runtimeErrorMessage ? <code className={styles.runtimeError}>{server.runtimeErrorMessage}</code> : null}
                </div>;
              })}
            </div>}
          </section>

          <section className={styles.section}>
            <header><h3>Tools 与角色</h3><span>{data.tools.length} tools · {data.roles.length} roles</span></header>
            <div className={styles.tags}>
              {data.tools.map((tool) => <Tag key={tool.name}>{tool.enabled ? "可用" : "停用"} · {tool.name}</Tag>)}
              {data.roles.map((role) => <Tag key={role.id}>角色 · {role.name}</Tag>)}
            </div>
          </section>

          {data.diagnostics.length > 0 ? <section className={styles.section}>
            <header><h3>Diagnostics</h3><span>{data.diagnostics.length} 条</span></header>
            <div className={styles.diagnostics}>{data.diagnostics.map((diagnostic, index) => <div key={index} data-level={diagnostic.level}>{diagnostic.level} · {diagnostic.message}</div>)}</div>
          </section> : null}
        </>
      ) : null}
    </ModalShell>
  );
}
