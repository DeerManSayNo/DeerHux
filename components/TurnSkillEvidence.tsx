import type { TurnSkillEvidence as Evidence } from "@/lib/turn-skill-evidence";

export function TurnSkillEvidence({ evidence }: { evidence: Evidence }) {
  const groups = [
    { label: "用户选择", items: evidence.selected },
    { label: "上下文注入", items: evidence.injected },
    { label: "工具读取", items: evidence.read },
    { label: "入口调用", items: evidence.invoked },
  ];
  return <section aria-label="本轮 Skill 记录" style={{ borderTop: "1px solid var(--border)", padding: "12px 18px", maxHeight: 220, overflowY: "auto", flexShrink: 0 }}>
    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>本轮 Skill 记录</div>
    {groups.map(group => <div key={group.label} style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
      <span style={{ flexShrink: 0, fontSize: 12, color: "var(--text-muted)" }}>{group.label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minWidth: 0 }}>
        {group.items?.length ? [...new Set(group.items.map(item => item.name))].map(name => <span key={name} title={group.items!.filter(item => item.name === name).map(item => item.detail).join("\n")} style={{ padding: "2px 8px", borderRadius: 999, fontSize: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", overflowWrap: "anywhere" }}>{name}</span>)
          : <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{group.items === undefined ? "此回合未记录" : "暂无记录"}</span>}
      </div>
    </div>)}
    <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>按本轮选择、注入记录和成功的工具操作展示；胶囊悬停可看路径。复杂命令或缺少来源的操作可能无法归属，不代表未使用。</div>
  </section>;
}
