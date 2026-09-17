# 图标

图标系统统一常见动作和状态图形的来源、尺寸、描边与可访问名称。

## 当前规则

- 常见动作通过 `AppIcon` 使用 `lucide-react`，优先复用已注册名称，不为库中已有动作手绘 SVG。
- 尺寸使用 `inline`、`compact`、`toolbar`、`section` 四档；描边宽度与对齐由 `AppIcon` 统一维护。
- 控件自身提供 `aria-label`；独立表达状态的图标使用 `label`；装饰图标对辅助技术隐藏。
- 领域专用图形和文件类型图标可独立实现，但必须保持作用域明确，不进入通用动作集合。

## 引用

- 品牌采用已选定的 A 方案（橙色曲面鹿形）。浅色、深色母版分别为 `public/brand/deerhux-a-light.png`、`public/brand/deerhux-a-dark.png`；网页图标跟随应用主题。首页空白区不展示图形 Logo，保留文字与新建会话入口。
- `node scripts/sync-brand-icons.mjs` 从 PNG 母版生成网页缩略图及桌面 PNG／ICNS／ICO。桌面安装包固定使用浅色 A，不随应用主题切换；深色 A 保留用于网页主题适配。旧 v2 SVG 与字标作为历史资产保留，不再作为图标生成输入。

- 实现：`components/AppIcon.tsx`。
- 依赖：`lucide-react`，版本以 `package.json` 为准。
- 示例：`components/ui/Button.tsx`。

## 例外或待确认

部分历史组件保留内联 SVG；在相关组件维护时评估语义和视觉兼容后迁移。
