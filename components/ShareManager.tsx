"use client";

import { QRCodeSVG } from "@rc-component/qrcode";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "./ui/Button";
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

function ShareLink({ value, label }: { value: string; label: string }) {
  return <div className={styles.shareLink}>
    <div className={styles.qrCode}>
      <QRCodeSVG value={value} size={132} level="M" marginSize={4} title={`${label}二维码`} />
    </div>
    <div className={styles.shareLinkDetails}>
      <CopyField value={value} label={label} />
      <p className={styles.muted}>扫描二维码打开链接，再输入 6 位匹配码。</p>
    </div>
  </div>;
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
  const validityHint = !name.trim() ? "填写分享名称" : chosenProjects.length === 0 ? "至少选择一个项目" : chosenModels.length === 0 ? "至少选择一个模型" : chosenRoles.length === 0 ? "至少选择一个角色" : "有效期需为 1 至 168 小时";
  const selectionSummary = `${chosenProjects.length} 个项目 · ${chosenModels.length} 个模型 · ${chosenRoles.length} 个角色 · ${hours === null ? "永久有效" : `${hours || "—"} 小时`}`;
  return <>
    <dialog ref={dialog} className={`${styles.scope} ${styles.dialog} app-window-scrollbars`} aria-label="分享窗口" onCancel={() => onClose()} onClose={() => onClose()} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={styles.modalShell}>
        <header className={styles.modalHeader}>
          <div className={styles.modalHeading}><h2>分享窗口</h2></div>
          <Button variant="iconButton" icon="close" aria-label="关闭分享窗口" onClick={() => onClose()} />
        </header>
        <div className={styles.tabs} role="tablist" aria-label="分享管理" onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "create" : event.key === "End" ? "manage" : tab === "create" ? "manage" : "create"; setTab(next); dialog.current?.querySelector<HTMLButtonElement>(`#share-tab-${next}`)?.focus(); } }}>
          <button id="share-tab-create" role="tab" aria-controls="share-panel" tabIndex={tab === "create" ? 0 : -1} aria-selected={tab === "create"} className={styles.tab} onClick={() => setTab("create")}>创建分享</button>
          <button id="share-tab-manage" role="tab" aria-controls="share-panel" tabIndex={tab === "manage" ? 0 : -1} aria-selected={tab === "manage"} className={styles.tab} onClick={() => setTab("manage")}>正在分享 <span className={styles.tabCount}>{shares.length}</span></button>
        </div>
        <div ref={content} id="share-panel" className={styles.modalScroll} role="tabpanel" aria-labelledby={`share-tab-${tab}`}>
          {error && <div className={styles.workspaceNotice}><ShareNotice>{error}</ShareNotice></div>}
          {tab === "create" && (result ? <div className={styles.success}>
            <div className={styles.successHeading}>
              <div className={styles.successTitle}><span className={styles.successMark}><ShareIcon name="check" size={15} /></span><div><h3>分享已创建</h3><p className={styles.muted}>发送链接和匹配码即可加入</p></div></div>
              <span className={styles.successStatus}>正在分享</span>
            </div>
            <div className={styles.successBody}>
              {result.urls.map(url => <ShareLink key={url} value={url} label="局域网分享链接" />)}
              <div className={styles.accessCode}><CopyField value={result.code} label="6 位匹配码" code /></div>
            </div>
            <div className={styles.successFooter}>
              <p className={styles.successNote}><ShareIcon name="clock" size={15} />主人设备需保持联网和运行；应用重启或停止分享后失效。</p>
              <div className={styles.successActions}><button className={styles.secondary} onClick={() => setResult(null)}>新建分享</button><button className={styles.primary} onClick={() => setTab("manage")}>查看正在分享</button></div>
            </div>
          </div> : <div className={styles.ownerCreate}>
            <div className={styles.ownerForm}>
              <section className={`${styles.section} ${styles.settingRow}`} aria-label="分享名称">
                <div className={styles.sectionTitle}><h3>分享名称</h3><span>访客进入后可见</span></div>
                <input aria-label="分享名称" className={styles.input} placeholder="例如：产品设计协作" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
              </section>
              <section className={`${styles.section} ${styles.settingRow}`} aria-label="选择项目">
                <div className={styles.sectionTitle}><h3><ShareIcon name="folder" size={16} />项目</h3><span className={styles.selectionCount}>已选 {chosenProjects.length}</span></div>
                <div className={styles.settingControl}>
                  <input type="search" aria-label="搜索项目" className={styles.input} placeholder="搜索项目名称或路径" value={projectQuery} onChange={event => setProjectQuery(event.target.value)} />
                  <div className={styles.choiceList}>{projects.length === 0 && <p className={styles.emptySmall}>{busy ? "正在加载项目…" : "请先在左侧添加项目"}</p>}
                    {filteredProjects.map(project => <label key={project.cwd} className={styles.choice}><input type="checkbox" checked={chosenProjects.includes(project.cwd)} onChange={() => setChosenProjects(toggle(chosenProjects, project.cwd))} /><span className={styles.choiceText}><strong>{project.displayName}</strong><small title={project.cwd}>{project.cwd}</small></span></label>)}
                    {projects.length > 0 && filteredProjects.length === 0 && <p className={styles.emptySmall}>没有匹配的项目，试试其他关键词</p>}
                  </div>
                </div>
              </section>
              <section className={`${styles.section} ${styles.settingRow}`} aria-label="选择模型">
                <div className={styles.sectionTitle}><h3><ShareIcon name="model" size={16} />模型</h3><span className={styles.selectionCount}>已选 {chosenModels.length}</span></div>
                <div className={`${styles.choiceList} ${styles.modelChoices}`}>{models.map(m => { const key = JSON.stringify([m.provider, m.id]); return <label key={key} className={styles.choice}><input type="checkbox" checked={chosenModels.includes(key)} onChange={() => setChosenModels(toggle(chosenModels, key))} /><span className={styles.choiceText}><strong>{m.name}</strong><small>{m.provider}</small></span></label>; })}</div>
                {!models.length && <p className={styles.emptySmall}>{busy ? "正在加载模型…" : "暂未配置可用模型"}</p>}
              </section>
              <section className={`${styles.section} ${styles.settingRow}`} aria-label="选择角色">
                <div className={styles.sectionTitle}><h3><ShareIcon name="role" size={16} />角色</h3><span className={styles.selectionCount}>已选 {chosenRoles.length}</span></div>
                <div className={styles.settingControl}>
                  <div className={styles.roleChoices}>{roles.map(r => <label key={r.id} className={styles.choice}><input type="checkbox" checked={chosenRoles.includes(r.id)} onChange={() => setChosenRoles(toggle(chosenRoles, r.id))} />{r.name}</label>)}</div>
                  <p className={styles.muted}>{roles.length ? "仅展示所选项目共有的角色" : "所选项目暂无共同角色，请调整项目选择"}</p>
                </div>
              </section>
              <section className={`${styles.section} ${styles.settingRow}`} aria-label="文件权限"><div className={styles.sectionTitle}><h3><ShareIcon name="lock" size={16} />文件权限</h3><span>默认只读</span></div>
                <div className={styles.permissions} role="group" aria-label="文件权限">
                  <button type="button" className={styles.permission} aria-pressed={!writable} onClick={() => setWritable(false)}><ShareIcon name="lock" /><span><strong>只读访问</strong><small>可查看和分析文件</small></span></button>
                  <button type="button" className={styles.permission} aria-pressed={writable} onClick={() => setWritable(true)}><ShareIcon name="edit" /><span><strong>允许读写</strong><small>可新增和修改文本文件</small></span></button>
                </div>
              </section>
              <section className={`${styles.section} ${styles.settingRow}`}><div className={styles.sectionTitle}><h3><ShareIcon name="clock" size={16} />有效期</h3><span>最长 168 小时</span></div><div className={styles.settingControl}>
                <div className={styles.durationRow}>
                  <div className={styles.durationOptions}>{[1, 8, 24, null].map(n => <button type="button" key={n ?? "permanent"} className={styles.durationChip} aria-pressed={hours === n} onClick={() => setHours(n)}>{n === null ? "永久" : `${n} 小时`}</button>)}</div>
                  <label className={styles.customDuration}><input aria-label="自定义有效期（小时）" className={styles.input} type="number" min={1} max={168} placeholder="自定义" value={hours !== null && ![1, 8, 24].includes(hours) ? hours : ""} onChange={e => setHours(e.target.value === "" ? 8 : Number(e.target.value))} /><span>小时</span></label>
                </div>
                {hours === null && <p className={styles.muted}>应用重启或手动停止后仍会失效。</p>}
              </div></section>
            </div>
            <footer className={styles.ownerFooter}>
              <div className={styles.ownerFooterInfo}><strong>{selectionSummary} · {writable ? "允许读写" : "只读访问"}</strong><span>{valid ? "仅限可信局域网；访客还需输入 6 位匹配码。" : validityHint}</span></div>
              <Button variant="primary" disabled={busy || !valid} onClick={() => void create()}>{busy ? "正在创建…" : "创建分享链接"}</Button>
            </footer>
          </div>)}
          {tab === "manage" && <div className={styles.manageList}>{shares.length === 0 ? <div className={styles.emptyWorkspace}><span className={styles.emptyIcon}><ShareIcon name="share" size={28} /></span><h2>还没有正在进行的分享</h2><p>创建一个分享，邀请他人进入你的工作空间。</p><button className={styles.primary} onClick={() => { setResult(null); setTab("create"); }}>创建分享<ShareIcon name="plus" size={16} /></button></div> : shares.map(s => <article key={s.id} className={styles.manageCard}>
            <div className={styles.manageHead}><div><div className={styles.manageTitle}><ShareIcon name="window" /><h3>{s.name}</h3></div><div className={styles.manageMeta}><span className={`${styles.badge} ${styles.accentBadge}`}>{s.writable ? "允许读写" : "只读访问"}</span><span className={styles.muted}>{expiryLabel(s.expiresAt)}</span></div></div><button disabled={busy} className={styles.danger} onClick={() => void revoke(s.id)}>停止分享</button></div>
            {s.urls.map(url => <ShareLink key={url} value={url} label="分享链接" />)}
            {s.code ? <CopyField value={s.code} label="6 位匹配码" code /> : <div className={styles.section}><p className={styles.muted}>此分享创建于旧版本，原匹配码未保留。生成新码后旧码失效，已登录访客不受影响。</p><button disabled={busy} className={styles.secondary} onClick={() => void generateCode(s.id)}>生成新匹配码</button></div>}
          </article>)}</div>}
        </div>
      </section>
    </dialog>
  </>;
}
