# 交互行为

交互系统统一键盘、指针、焦点、状态反馈、取消与错误恢复。

## 当前规则

- 所有交互可通过键盘到达，并使用 `:focus-visible` 显示清晰焦点。触摸和指针不能成为完成任务的唯一输入方式。
- 弹窗打开后聚焦首个可操作项，Tab 保持在弹窗内，Escape 或关闭操作退出后恢复到触发控件。
- 展开控件同步 `aria-expanded`，当前项使用 `aria-current` 或 `aria-pressed`，图标按钮提供准确的 `aria-label`。
- hover、focus、selected、disabled、loading、empty、error 和 success 按任务覆盖；禁用状态不能代替错误说明。
- 失败保留有效输入并提供恢复路径；可取消的长任务提供停止操作，并明确停止后的状态。

## 引用

- 实现：`components/ui/Button.tsx`、`components/ui/Modal.tsx`、`components/ui/Form.module.css`。
- 动效：`docs/design-system/systems/motion.md`。
- 页面模式：`docs/design-system/patterns/workbench.md`。

## 例外或待确认

历史组件仍有自定义弹窗和交互实现；在相关任务中按共享契约核对，不进行无关的全量重写。
