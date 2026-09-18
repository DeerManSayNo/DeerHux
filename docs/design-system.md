# DeerHux 设计系统

DeerHux 是面向持续编码工作的桌面 Agent 工作台，采用安静、紧凑、可扫描的工作界面。现有体系由项目 CSS Token、共享 React 组件和领域组件共同组成。

界面任务先读取本入口与相关系统规则，再审查现有组件，决定复用、改造或构建。具体视觉值由 Token 源码维护，组件参数与行为由组件源码维护。

## 设计依据

[设计依据](design-system/design-basis.md) 记录用户任务、信息关系、视觉方向和范围取舍。

## 公共入口

- Token：[Token 使用契约](design-system/token-contract.md)；权威源为 `app/design-tokens.css` 与 `app/globals.css`。
- 组件：`components/ui/`、`components/AppIcon.tsx`；公开 API 以源码为准。
- 页面与任务模式：[工作台模式](design-system/patterns/workbench.md)。
- 二级窗口：[弹窗与配置窗口](design-system/patterns/modal.md)。
- 安装与分发：[macOS 安装窗口](design-system/patterns/macos-installer.md)。
- 领域契约：`docs/shared-workspace-design.md` 记录分享工作区的产品与安全边界。
- 验证：设计 Token、主题色、主题同步和生产主题门禁脚本，详见 Token 使用契约。

## 系统索引

“可用”表示已有明确规则及可引用资产，不代表所有历史实现均已迁移或所有场景均经过运行验证。

| 系统 | 规范路径 | 状态 |
| --- | --- | --- |
| 颜色 | [color.md](design-system/systems/color.md) | 可用 |
| 按钮 | [button.md](design-system/systems/button.md) | 可用 |
| 滑动条 | [slider.md](design-system/systems/slider.md) | 待补齐 |
| 圆角 | [radius.md](design-system/systems/radius.md) | 可用 |
| 字体 | [typography.md](design-system/systems/typography.md) | 可用 |
| 图标 | [icons.md](design-system/systems/icons.md) | 可用 |
| 阴影 | [elevation.md](design-system/systems/elevation.md) | 可用 |
| 动效 | [motion.md](design-system/systems/motion.md) | 可用 |
| 过渡与骨架屏 | [transition-loading.md](design-system/systems/transition-loading.md) | 待补齐 |
| 交互行为 | [interaction.md](design-system/systems/interaction.md) | 可用 |
| 间距 | [spacing.md](design-system/systems/spacing.md) | 可用 |
| 尺寸 | [sizing.md](design-system/systems/sizing.md) | 可用 |
| 布局 | [layout.md](design-system/systems/layout.md) | 可用 |

## 当前事项

- 当前没有可访问的 Figma 权威来源，不声明代码与 Figma 已同步。
- Slider 尚无共享需求和组件；产生产品需求后再定义受控 API 与完整输入行为。
- 加载状态已有领域实现，但尚无统一的骨架屏、延迟阈值、超时和重试契约。
- 部分历史组件仍含裸字号、阴影、z-index、手绘 SVG 和自定义交互；它们是迁移范围，不自动成为新规范。
