# 图标

图标系统统一常见动作和状态图形的来源、尺寸、描边与可访问名称。

## 当前规则

- 常见动作通过 `AppIcon` 使用 `lucide-react`，优先复用已注册名称，不为库中已有动作手绘 SVG。
- 尺寸使用 `inline`、`compact`、`toolbar`、`section` 四档；描边宽度与对齐由 `AppIcon` 统一维护。
- 控件自身提供 `aria-label`；独立表达状态的图标使用 `label`；装饰图标对辅助技术隐藏。
- 领域专用图形和文件类型图标可独立实现，但必须保持作用域明确，不进入通用动作集合。

## 引用

- 实现：`components/AppIcon.tsx`。
- 依赖：`lucide-react`，版本以 `package.json` 为准。
- 示例：`components/ui/Button.tsx`。

## 例外或待确认

部分历史组件保留内联 SVG；在相关组件维护时评估语义和视觉兼容后迁移。
