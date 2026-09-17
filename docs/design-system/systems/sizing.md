# 尺寸

尺寸系统约束控件、图标容器、固定格式区域和可调整面板的占用空间。

## 当前规则

- 通用按钮使用 `md` 与 `sm` 两档；纯图标按钮保持正方形，具体值由组件样式维护。
- 图标使用 `inline`、`compact`、`toolbar`、`section` 四档，不由调用方传入任意像素值。
- 文本按钮按内容自适应并保持内边距；长文案允许换行的容器不得依赖固定高度。
- 固定格式区域显式定义宽高、aspect-ratio、网格轨道或 min/max，避免加载、标签和状态变化导致布局跳动。
- 可调整侧栏和资源面板由工作台实现维护最小值、最大值和持久化策略；窄屏优先保持主任务可用。

## 引用

- 实现：`components/ui/Button.module.css`、`components/AppIcon.tsx`、`components/AppShell.tsx`、`components/ui/Modal.module.css`。
- 布局规则：`docs/design-system/systems/layout.md`。

## 例外或待确认

项目尚无全局 sizing Token；组件已有稳定尺寸继续由组件源码作为权威来源。
