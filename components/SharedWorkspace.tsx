"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./sharing/sharing.module.css";
import { ShareBrand, ShareIcon, ShareNotice, expiryLabel } from "./sharing/ShareUI";
import { useTheme } from "@/hooks/useTheme";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";

type Catalog = { name: string; writable: boolean; expiresAt: number | null; models: { provider: string; modelId: string }[]; projects: { id: string; name: string; roles: { id: string; name: string }[] }[] };
type Session = { id: string; name: string; projectId: string; roleId: string; model: Catalog["models"][number]; running: boolean };
type Snapshot = { messages: AgentMessage[]; partial?: AgentMessage; running: boolean; error?: string };

class ShareHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(url: string, value?: unknown): Promise<T> {
  const response = await fetch(url, { method: value === undefined ? "GET" : "POST", cache: "no-store", headers: value === undefined ? {} : { "Content-Type": "application/json", "X-DeerHux-Share": "1" }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok) throw new ShareHttpError(data.error ?? "请求失败", response.status);
  return data as T;
}

function SharedChat({ base, session, catalog, onHide }: { base: string; session: Session; catalog: Catalog; onHide: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ messages: [], running: false });
  const input = useRef<ChatInputHandle>(null);
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const reading = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const data = await request<Snapshot>(`${base}/sessions/${session.id}`);
    setSnapshot(data); setError("");
  }, [base, session.id]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try { await load(); } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "连接中断");
        if (err instanceof ShareHttpError && [401, 404, 410].includes(err.status)) { if (alive) setBlocked(true); return; }
      }
      if (alive) timer = setTimeout(() => void tick(), 700);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [load]);
  useEffect(() => { if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [snapshot, follow]);
  useEffect(() => {
    if (!reading.current) return;
    const observer = new ResizeObserver(() => {
      if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(reading.current);
    return () => observer.disconnect();
  }, [follow]);
  async function send(text: string) {
    if (!text.trim() || pending || snapshot.running || blocked) return;
    setPending(true); setError("");
    try { await request(`${base}/sessions/${session.id}`, { type: "prompt", message: text }); setFollow(true); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "发送失败，请检查会话后重试"); input.current?.insertText(text); }
    finally { setPending(false); }
  }
  const toolResults = new Map<string, ToolResultMessage>();
  for (const item of snapshot.messages) if (item.role === "toolResult") toolResults.set(item.toolCallId, item);
  const project = catalog.projects.find(p => p.id === session.projectId);
  return <section className={styles.chat} aria-label={`${project?.name ?? "分享"}聊天窗口`}>
    <header className={styles.chatHeader}><div className={styles.chatIdentity}><ShareIcon name="window" size={18} /><div><strong>{project?.name}</strong><small title={session.model.modelId}>{project?.roles.find(r => r.id === session.roleId)?.name} · {session.model.modelId}</small></div></div><button className={styles.iconButton} onClick={onHide} title="收起窗口，保留会话" aria-label="收起聊天窗口"><ShareIcon name="close" size={15} /></button></header>
    <div className={styles.conversationArea}><div ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }} className={styles.chatMessages} data-ai-output onClickCapture={event => {
      const link = (event.target as HTMLElement).closest("a");
      if (link) { event.preventDefault(); const href = link.getAttribute("href") ?? ""; if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer"); }
    }}>
      <div ref={reading} className={styles.readingColumn} data-share-reading-column>
      {snapshot.messages.length === 0 && <div className={styles.chatEmpty}><span className={styles.contextLabel}>{project?.name}</span><h2>开始新对话</h2><p>{catalog.writable ? "此窗口可读取和修改项目文本文件。" : "此窗口仅可读取项目文件。"}</p></div>}
      {snapshot.messages.filter(m => m.role !== "toolResult").map((item, i) => <MessageView key={`${item.timestamp}-${i}`} message={item} toolResults={toolResults} onRestoreToInput={item => input.current?.insertText(typeof item.content === "string" ? item.content : item.content.filter(b => b.type === "text").map(b => b.text).join("\n"))} />)}
      {snapshot.partial && <MessageView message={snapshot.partial} isStreaming toolResults={toolResults} />}
      {snapshot.running && !snapshot.partial && <p className={styles.processing}><span className={styles.dot} />正在处理…</p>}
      </div>
    </div>
    {!follow && <button className={styles.pillButton} onClick={() => setFollow(true)}>↓ 回到底部</button>}</div>
    {(error || snapshot.error) && <div className={styles.chatNotice}><div className={styles.composerInner}><ShareNotice>{error || snapshot.error}</ShareNotice></div></div>}
    <div className={styles.composer}><div className={styles.composerInner} data-share-composer-column><ChatInput ref={input} textOnly compact fitContainer model={session.model}
      agentMode={catalog.writable ? "agent" : "ask"}
      isStreaming={!blocked && snapshot.running}
      onBeforeSend={() => !pending && !snapshot.running && !blocked}
      onSend={text => { void send(text); }}
      onAbort={() => { void request(`${base}/sessions/${session.id}`, { type: "abort" }).catch(err => setError(String(err))); }}
    /><div className={styles.composerMeta}><span>{catalog.writable ? "允许读写" : "只读访问"}</span><span>Enter 发送 · Shift + Enter 换行</span></div></div></div>
  </section>;
}

export function SharedWorkspace({ shareId }: { shareId: string }) {
  const base = `/api/share/${shareId}`;
  const { isDark, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expired, setExpired] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [visible, setVisible] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [modelIndex, setModelIndex] = useState(0);

  const enter = useCallback(async () => {
    const data = await request<Catalog>(`${base}/catalog`);
    const list = await request<Session[]>(`${base}/sessions`);
    setCatalog(data); setSessions(list); setVisible(list.slice(-1).map(s => s.id));
    setProjectId(data.projects[0]?.id ?? ""); setRoleId(data.projects[0]?.roles[0]?.id ?? "");
  }, [base]);
  useEffect(() => { void enter().catch(err => { if (err instanceof ShareHttpError && err.status === 410) { setExpired(true); setError(err.message); } }); }, [enter]);
  async function login() {
    const code = codeInput.current?.value.trim() ?? "";
    if (!/^\d{6}$/.test(code)) { setError("请输入 6 位数字匹配码"); return; }
    setBusy(true); setError("");
    try { await request(`${base}/auth`, { code }); await enter(); }
    catch (err) { if (err instanceof ShareHttpError && err.status === 410) setExpired(true); setError(err instanceof Error ? err.message : "连接失败，请稍后重试"); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!catalog) return;
    setBusy(true); setError("");
    try {
      const result = await request<{ id: string }>(`${base}/sessions`, { projectId, roleId, ...catalog.models[modelIndex] });
      setSessions(await request<Session[]>(`${base}/sessions`));
      setVisible(current => [...current.slice(-2), result.id]);
    } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); }
    finally { setBusy(false); }
  }

  const themeButton = <button className={styles.iconButton} aria-label={isDark ? "切换浅色主题" : "切换深色主题"} title={isDark ? "切换浅色主题" : "切换深色主题"} onClick={event => toggleTheme({ x: event.clientX, y: event.clientY })}><ShareIcon name={isDark ? "sun" : "moon"} /></button>;
  if (!catalog) return <main className={`${styles.scope} ${styles.webSurface} ${styles.loginPage}`}>
    <header className={styles.loginTop}><ShareBrand />{themeButton}</header>
    <div className={styles.loginLayout}>
      <section className={styles.loginCard}>
        <span className={styles.contextLabel}>共享工作区</span>
        <div className={styles.loginCardHeading}><h2>{expired ? "分享已结束" : "登录分享窗口"}</h2><p>{expired ? "请联系主人获取新的分享链接。" : "输入主人提供的 6 位数字匹配码"}</p></div>
        {!expired && <form className={styles.loginForm} onSubmit={event => { event.preventDefault(); if (ready) void login(); }}>
          <label className={styles.fieldLabel}>匹配码<input ref={codeInput} className={styles.codeInput} aria-label="匹配码" placeholder="000000" autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required maxLength={6} aria-describedby="share-code-help" /></label>
          {error && <ShareNotice>{error}</ShareNotice>}
          <button className={`${styles.primary} ${styles.full}`} disabled={!ready || busy}>{!ready ? "页面加载中…" : busy ? "验证中…" : "进入分享窗口"}{ready && !busy && <ShareIcon name="arrow" size={17} />}</button>
          <p id="share-code-help" className={styles.muted}>没有匹配码？请向分享主人获取。</p>
        </form>}
        <div className={styles.loginFootnote}><ShareIcon name="lock" size={14} /><span>匹配码验证后才可访问。主人设备需要保持在线，分享停止后访问会自动结束。</span></div>
      </section>
    </div><footer className={styles.loginBottom}>DeerHux / Shared workspace</footer>
  </main>;
  const project = catalog.projects.find(p => p.id === projectId);
  return <main className={`${styles.scope} ${styles.webSurface} ${styles.workspace}`}>
    <header className={styles.workspaceHeader}><div className={styles.workspaceTitle}><button className={styles.iconButton} aria-label={sidebarOpen ? "收起资源与窗口" : "展开资源与窗口"} aria-expanded={sidebarOpen} aria-controls="share-sidebar" onClick={() => setSidebarOpen(open => !open)}><ShareIcon name="window" size={17} /></button><ShareBrand /><div className={styles.workspaceName}><strong>{catalog.name}</strong><div className={styles.headerMeta}><span className={`${styles.badge} ${styles.accentBadge}`}><ShareIcon name={catalog.writable ? "edit" : "lock"} size={11} />{catalog.writable ? "允许读写" : "只读访问"}</span><span>{expiryLabel(catalog.expiresAt)}</span></div></div></div>{themeButton}</header>
    <div className={styles.workspaceBody}>
      <aside id="share-sidebar" hidden={!sidebarOpen} className={styles.sidebar} aria-label="分享资源与会话">
        <section className={styles.resourcePanel}><h2 className={styles.sideHeading}>新建窗口<span>授权资源</span></h2>
          <div className={styles.resourceFields}>
            <label className={styles.fieldLabel}>项目<select className={styles.select} aria-label="项目" value={projectId} onChange={e => { setProjectId(e.target.value); setRoleId(catalog.projects.find(p => p.id === e.target.value)?.roles[0]?.id ?? ""); }}>{catalog.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className={styles.fieldLabel}>角色<select className={styles.select} aria-label="角色" value={roleId} onChange={e => setRoleId(e.target.value)}>{project?.roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className={styles.fieldLabel}>模型<select className={styles.select} aria-label="模型" value={modelIndex} onChange={e => setModelIndex(Number(e.target.value))}>{catalog.models.map((m, i) => <option key={i} value={i}>{m.modelId} · {m.provider}</option>)}</select></label>
          </div>
          <button disabled={busy || sessions.length >= 12} className={`${styles.primary} ${styles.full}`} onClick={() => void create()}><ShareIcon name="plus" size={16} />{busy ? "正在创建…" : "新建窗口"}</button>
          <p className={styles.muted}>{sessions.length >= 12 ? "已达到 12 个会话的上限" : "所选资源只应用于新窗口"}</p>
        </section>
        <section className={styles.sessionPanel}><h2 className={styles.sideHeading}>我的窗口<span>{sessions.length} / 12</span></h2>
          <nav className={styles.sessionList} aria-label="会话窗口">{sessions.map((s, i) => <button key={s.id} className={styles.sessionButton} aria-pressed={visible.includes(s.id)} title={visible.includes(s.id) ? "收起窗口，保留会话" : "展开窗口"} onClick={() => setVisible(current => current.includes(s.id) ? current.filter(id => id !== s.id) : [...current.slice(-2), s.id])}><ShareIcon name="window" size={15} /><span>{s.name === "新窗口" ? `窗口 ${i + 1}` : s.name}</span>{visible.includes(s.id) && <span className={styles.dot} style={{ flex: "none" }} />}</button>)}</nav>
          {!sessions.length && <p className={styles.emptySmall}>新建的窗口会出现在这里</p>}
        </section><div className={styles.sidebarFoot}>最多并排展示 3 个窗口<br />收起窗口不会删除聊天记录</div>
      </aside>
      <div className={styles.workspaceMain}>
        {error && <div className={styles.workspaceNotice}><ShareNotice>{error}</ShareNotice></div>}
        <div className={styles.canvas} data-window-count={visible.length}>{visible.map(id => { const session = sessions.find(s => s.id === id); return session && <SharedChat key={id} base={base} session={session} catalog={catalog} onHide={() => setVisible(current => current.filter(item => item !== id))} />; })}
          {visible.length === 0 && <div className={styles.emptyWorkspace}><span className={styles.contextLabel}>{catalog.name}</span><h2>{sessions.length ? "选择一个对话" : "新建一个对话"}</h2><p>{sessions.length ? "展开已有窗口，或创建一个新窗口。" : "窗口使用下方的项目与模型，聊天记录相互独立。"}</p><div className={styles.contextChips}><span><ShareIcon name="folder" size={14} />{project?.name}</span><span>{catalog.models[modelIndex]?.modelId}</span></div><button className={styles.textButton} onClick={() => setSidebarOpen(true)}>调整资源 / 查看窗口</button><button disabled={busy || sessions.length >= 12} className={styles.primary} onClick={() => void create()}><ShareIcon name="plus" size={17} />{busy ? "正在创建…" : "新建窗口"}</button><small className={styles.muted}>{catalog.writable ? "当前分享允许新增和修改项目文本文件" : "当前分享仅可读取项目文件"}</small></div>}
        </div>
      </div>
    </div>
  </main>;
}
