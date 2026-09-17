# 布局

布局系统组织工作台区域、弹窗、响应式重排、滚动和溢出关系。

## 当前规则

- 主工作台由左侧项目与会话导航、中部一个或多个聊天窗口、右侧按需出现的资源管理器或文件预览组成。
- 每个持续内容区域负责自身滚动；页面壳保持视口高度，浮层不改变底层布局。固定和吸附区域不得遮挡关键内容。
- 可调整区域设置明确 min/max；多聊天窗口使用稳定网格槽位，动态状态不能改变轨道结构。
- 二级配置使用 `ModalShell`：`split` 用于列表加编辑区，`confirm` 用于短确认。内容区和侧栏分别管理滚动。
- 窄屏保持主任务和关键操作可达，次级区域可重排、收起或独立显示；页面留白按间距规则收紧。
- 长路径、模型名和会话名可以截断，但必须通过 title、展开或复制能力访问完整值；正文和错误允许换行。

## 引用

- 实现：`components/AppShell.tsx`、`components/ChatWorkspace.tsx`、`components/workbench.css`、`components/workspace-panel.css`、`components/ui/Modal.tsx`。
- 页面模式：`docs/design-system/patterns/workbench.md`。
- 间距与尺寸：`docs/design-system/systems/spacing.md`、`docs/design-system/systems/sizing.md`。

## 例外或待确认

领域页面的响应式规则仍部分分散；新增布局先验证桌面和窄屏，再决定是否提升为共享模式。
