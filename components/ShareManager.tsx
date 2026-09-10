"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import styles from "./sharing/sharing.module.css";
import { CopyField, ShareIcon, ShareNotice, expiryLabel } from "./sharing/ShareUI";

type Model = { id: string; provider: string; name: string };
type Share = { id: string; name: string; writable: boolean; expiresAt: number | null; urls: string[]; code: string | null };

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "请求失败");
  return data;
}

export function ShareManager({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: { cwd: string; displayName: string }[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [tab, setTab] = useState<"create" | "manage">("create");
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const [name, setName] = useState("我的分享窗口");
  const [selectedProjectCwds, setChosenProjects] = useState<string[]>([]);
  const chosenProjects = useMemo(() => selectedProjectCwds.filter(cwd => projects.some(project => project.cwd === cwd)), [selectedProjectCwds, projects]);
  const [models, setModels] = useState<Model[]>([]);
  const [chosenModels, setChosenModels] = useState<string[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [chosenRoles, setChosenRoles] = useState<string[]>(["default"]);
  const [writable, setWritable] = useState(false);
  const [hours, setHours] = useState<number | null>(8);
  const [shares, setShares] = useState<Share[]>([]);
  const [result, setResult] = useState<{ urls: string[]; code: string } | null>(null);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [result, tab]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (items: string[], item: string) => items.includes(item) ? items.filter(i => i !== item) : [...items, item];

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all(chosenProjects.length ? chosenProjects.map(cwd => api(`/api/roles?cwd=${encodeURIComponent(cwd)}`)) : [api("/api/roles")]).then(results => {
      if (!alive) return;
      const common = (results[0].roles as { id: string; name: string }[]).filter(role => results.every(result => result.roles.some((r: { id: string }) => r.id === role.id)));
      setRoles(common); setChosenRoles(current => current.filter(id => common.some(role => role.id === id)));
    }).catch(() => { if (alive) setError("项目角色加载失败，请重试"); });
    return () => { alive = false; };
  }, [chosenProjects, open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    async function load() {
      setBusy(true); setError("");
      try {
        const [modelData, shareData] = await Promise.all([api("/api/models"), api("/api/shares")]);
        if (!alive) return;
        setModels(modelData.modelList ?? []); setShares(shareData.shares ?? []);
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : "加载失败"); }
      finally { if (alive) setBusy(false); }
    }
    void load();
    return () => { alive = false; };
  }, [open]);

  async function create() {
    setBusy(true); setError(""); setResult(null);
    try {
      const selected = models.filter(m => chosenModels.includes(JSON.stringify([m.provider, m.id]))).map(m => ({ provider: m.provider, modelId: m.id }));
      const created = await api("/api/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, projects: chosenProjects, models: selected, roleIds: chosenRoles, writable, hours }) });
      setResult(created); setShares((await api("/api/shares")).shares);
    } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function generateCode(id: string) {
    setBusy(true); setError("");
    try {
      const { code } = await api("/api/shares", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      setShares(current => current.map(share => share.id === id ? { ...share, code } : share));
    } catch (err) { setError(err instanceof Error ? err.message : "生成匹配码失败"); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true); setError("");
    try { await api("/api/shares", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); setShares((await api("/api/shares")).shares); setResult(null); }
    catch (err) { setError(err instanceof Error ? err.message : "停止失败"); }
    finally { setBusy(false); }
  }

  const query = projectQuery.trim().toLowerCase();
  const filteredProjects = projects.filter(project => [project.displayName, project.cwd].some(value => value.toLowerCase().includes(query)));
  const valid = !!name.trim() && chosenProjects.length > 0 && chosenModels.length > 0 && chosenRoles.length > 0 && (hours === null || (hours >= 1 && hours <= 168));
  return <>
    <dialog ref={dialog} className={`${styles.scope} ${styles.dialog}`} aria-label="分享窗口" onCancel={() => onClose()} onClose={() => onClose()} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={styles.modalShell}>
        <header className={styles.modalHeader}>
          <div className={styles.modalHeading}><span className={styles.brandMark}><ShareIcon name="share" /></span><div><h2>分享窗口</h2><p className={styles.muted}>邀请他人，在你设定的范围内协作</p></div></div>
          <button type="button" className={styles.iconButton} aria-label="关闭分享窗口" onClick={() => onClose()}><ShareIcon name="close" /></button>
        </header>
        <div className={styles.tabs} role="tablist" aria-label="分享管理" onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "create" : event.key === "End" ? "manage" : tab === "create" ? "manage" : "create"; setTab(next); dialog.current?.querySelector<HTMLButtonElement>(`#share-tab-${next}`)?.focus(); } }}>
          <button id="share-tab-create" role="tab" aria-controls="share-panel" tabIndex={tab === "create" ? 0 : -1} aria-selected={tab === "create"} className={styles.tab} onClick={() => setTab("create")}>创建分享</button>
          <button id="share-tab-manage" role="tab" aria-controls="share-panel" tabIndex={tab === "manage" ? 0 : -1} aria-selected={tab === "manage"} className={styles.tab} onClick={() => setTab("manage")}>正在分享 <span className={styles.tabCount}>{shares.length}</span></button>
        </div>
        <div ref={content} id="share-panel" className={styles.modalScroll} role="tabpanel" aria-labelledby={`share-tab-${tab}`}>
          {error && <div className={styles.workspaceNotice}><ShareNotice>{error}</ShareNotice></div>}
          {tab === "create" && (result ? <div className={styles.success}>
            <div className={styles.successHeading}><span className={styles.successMark}><ShareIcon name="check" size={26} /></span><h3>分享已准备好</h3><p className={styles.muted}>将链接和匹配码发送给访客，即可开始协作。</p></div>
            {result.urls.map(url => <CopyField key={url} value={url} label={url.startsWith("https:") ? "公网分享链接" : "局域网分享链接"} />)}
            <CopyField value={result.code} label="6 位匹配码" code />
            <p className={styles.muted}>保持主人设备联网、DeerHux 运行。应用重启或分享停止后，此链接将失效。</p>
            <div className={styles.successActions}><button className={styles.secondary} onClick={() => setResult(null)}>再创建一个</button><button className={styles.primary} onClick={() => setTab("manage")}>管理分享<ShareIcon name="arrow" size={16} /></button></div>
          </div> : <div className={styles.ownerGrid}>
            <div className={styles.ownerForm}>
              <label className={styles.fieldLabel}>分享名称<input className={styles.input} placeholder="例如：产品设计协作" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
              <section className={styles.section} aria-label="选择项目">
                <div className={styles.sectionTitle}><h3><ShareIcon name="folder" size={16} />项目</h3><span className={styles.selectionCount}>已选 {chosenProjects.length}</span></div>
                <input type="search" aria-label="搜索项目" className={styles.input} placeholder="搜索项目名称或路径" value={projectQuery} onChange={event => setProjectQuery(event.target.value)} />
                <div className={styles.choiceList}>{projects.length === 0 && <p className={styles.emptySmall}>{busy ? "正在加载项目…" : "请先在左侧添加项目"}</p>}
                  {filteredProjects.map(project => <label key={project.cwd} className={styles.choice}><input type="checkbox" checked={chosenProjects.includes(project.cwd)} onChange={() => setChosenProjects(toggle(chosenProjects, project.cwd))} /><span className={styles.choiceText}><strong>{project.displayName}</strong><small title={project.cwd}>{project.cwd}</small></span></label>)}
                  {projects.length > 0 && filteredProjects.length === 0 && <p className={styles.emptySmall}>没有匹配的项目，试试其他关键词</p>}
                </div>
              </section>
              <section className={styles.section} aria-label="选择模型">
                <div className={styles.sectionTitle}><h3><ShareIcon name="model" size={16} />模型</h3><span className={styles.selectionCount}>已选 {chosenModels.length}</span></div>
                <div className={`${styles.choiceList} ${styles.modelChoices}`}>{models.map(m => { const key = JSON.stringify([m.provider, m.id]); return <label key={key} className={styles.choice}><input type="checkbox" checked={chosenModels.includes(key)} onChange={() => setChosenModels(toggle(chosenModels, key))} /><span className={styles.choiceText}><strong>{m.name}</strong><small>{m.provider}</small></span></label>; })}</div>
                {!models.length && <p className={styles.emptySmall}>{busy ? "正在加载模型…" : "暂未配置可用模型"}</p>}
              </section>
              <section className={styles.section} aria-label="选择角色">
                <div className={styles.sectionTitle}><h3><ShareIcon name="role" size={16} />角色</h3><span className={styles.selectionCount}>已选 {chosenRoles.length}</span></div>
                <div className={styles.roleChoices}>{roles.map(r => <label key={r.id} className={styles.choice}><input type="checkbox" checked={chosenRoles.includes(r.id)} onChange={() => setChosenRoles(toggle(chosenRoles, r.id))} />{r.name}</label>)}</div>
                <p className={styles.muted}>{roles.length ? "仅展示所选项目共有的角色" : "所选项目暂无共同角色，请调整项目选择"}</p>
              </section>
              <section className={styles.section} aria-label="文件权限"><div className={styles.sectionTitle}><h3><ShareIcon name="lock" size={16} />文件权限</h3></div>
                <div className={styles.permissions}>
                  <button className={styles.permission} aria-pressed={!writable} onClick={() => setWritable(false)}><ShareIcon name="lock" /><strong>只读访问</strong><small>查看与分析，不修改项目文件</small></button>
                  <button className={styles.permission} aria-pressed={writable} onClick={() => setWritable(true)}><ShareIcon name="edit" /><strong>允许读写</strong><small>可新增和修改项目文本文件</small></button>
                </div>
              </section>
              <section className={styles.section}><div className={styles.sectionTitle}><h3><ShareIcon name="clock" size={16} />有效期</h3></div><div className={styles.durationRow}>
                {[1, 8, 24, null].map(n => <button key={n ?? "permanent"} className={styles.durationChip} aria-pressed={hours === n} onClick={() => setHours(n)}>{n === null ? "永久" : `${n} 小时`}</button>)}
                <input aria-label="自定义有效期（小时）" className={styles.input} type="number" min={1} max={168} placeholder="自定义" value={hours ?? ""} onChange={e => setHours(Number(e.target.value))} /><span className={styles.muted}>小时</span>
              </div>{hours === null && <p className={styles.muted}>不按时间过期；应用重启或手动停止分享后失效。</p>}</section>
            </div>
            <aside className={styles.ownerSummary}><div className={styles.summarySticky}>
              <span className={styles.summaryEyebrow}>分享预览</span><h3 className={styles.summaryTitle}>{name.trim() || "未命名分享"}</h3>
              <span className={`${styles.badge} ${styles.accentBadge}`}><ShareIcon name={writable ? "edit" : "lock"} size={13} />{writable ? "允许读写" : "只读访问"}</span>
              <div className={styles.summaryRows}>{[["项目", `${chosenProjects.length} 个`], ["模型", `${chosenModels.length} 个`], ["角色", `${chosenRoles.length} 个`], ["有效期", hours === null ? "永久" : `${hours || "—"} 小时`]].map(([label, value]) => <div key={label} className={styles.summaryRow}><span>{label}</span><strong>{value}</strong></div>)}</div>
              <button disabled={busy || !valid} className={`${styles.primary} ${styles.full}`} onClick={() => void create()}>{busy ? "处理中…" : "创建分享链接"}<ShareIcon name="arrow" size={16} /></button>
              {!valid && <p className={styles.muted}>填写名称，并至少选择一个项目、模型和角色。</p>}
              <p className={styles.summaryNote}>访客通过链接和 6 位匹配码进入。<br />HTTPS 链接支持公网访问，HTTP 链接仅限可信局域网。<br /><br />使用期间保持主人设备在线。文件权限由服务端校验，终端、MCP 与子 Agent 不开放。</p>
            </div></aside>
          </div>)}
          {tab === "manage" && <div className={styles.manageList}>{shares.length === 0 ? <div className={styles.emptyWorkspace}><span className={styles.emptyIcon}><ShareIcon name="share" size={28} /></span><h2>还没有正在进行的分享</h2><p>创建一个分享，邀请他人进入你的工作空间。</p><button className={styles.primary} onClick={() => { setResult(null); setTab("create"); }}>创建分享<ShareIcon name="plus" size={16} /></button></div> : shares.map(s => <article key={s.id} className={styles.manageCard}>
            <div className={styles.manageHead}><div><div className={styles.manageTitle}><ShareIcon name="window" /><h3>{s.name}</h3></div><div className={styles.manageMeta}><span className={`${styles.badge} ${styles.accentBadge}`}>{s.writable ? "允许读写" : "只读访问"}</span><span className={styles.muted}>{expiryLabel(s.expiresAt)}</span></div></div><button disabled={busy} className={styles.danger} onClick={() => void revoke(s.id)}>停止分享</button></div>
            {s.urls.map(url => <CopyField key={url} value={url} label="分享链接" />)}
            {s.code ? <CopyField value={s.code} label="6 位匹配码" code /> : <div className={styles.section}><p className={styles.muted}>此分享创建于旧版本，原匹配码未保留。生成新码后旧码失效，已登录访客不受影响。</p><button disabled={busy} className={styles.secondary} onClick={() => void generateCode(s.id)}>生成新匹配码</button></div>}
          </article>)}</div>}
        </div>
      </section>
    </dialog>
  </>;
}
