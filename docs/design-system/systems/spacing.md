# 间距

间距系统管理组件内部、元素之间、分组之间和页面区域之间的空间关系。

## 当前规则

- 固定空间采用 4px 基础步距；允许 2px 或 6px 用于紧凑界面的视觉对齐，不据此创建新的全局档位。
- 组件内边距由组件维护，元素间隔由所属布局维护；调用方不覆盖共享按钮和弹窗的内部间距。
- 紧密关联的信息使用较小间隔，分组和区域边界使用更大间隔并结合标题、边框或表面变化。
- 页面留白与 gutter 由布局规则引用；窄屏可以降低区域留白，但保持内容和关键操作可辨识。
- 新增稳定间距在三个以上复用场景出现后再评估语义 Token。

## 引用

- 实现：`components/ui/Button.module.css`、`components/ui/Modal.module.css`、`components/ui/Form.module.css`、`components/workbench.css`。
- 布局规则：`docs/design-system/systems/layout.md`。

## 例外或待确认

项目尚无全局 spacing Token。当前契约可用于新增和局部维护，历史散值按任务渐进收敛。
