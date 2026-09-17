# 按钮

按钮系统表达操作层级、尺寸、图标组合和基础交互状态。

## 当前规则

- 共享按钮使用 `Button`。`primary` 是当前范围的唯一主操作；`secondary` 用于常规操作；`ghost` 用于取消、返回等弱操作；`danger` 用于破坏性操作；`iconButton` 用于工具栏和面板工具动作。
- `variant` 表达操作层级，`size` 表达尺寸。`md` 用于主操作和表单操作，`sm` 用于标题行和密集工具区。
- 纯图标按钮使用 `icon` 并提供 `aria-label`；图标加文字使用 `leadingIcon`。链接导航使用链接语义，不用按钮模拟。
- 异步操作期间由调用方禁用按钮并阻止重复提交，在邻近上下文提供进行中、成功或失败反馈。
- 调用方不覆盖共享按钮的圆角、字号、字重和内边距。

## 引用

- Token：`app/design-tokens.css`、`app/globals.css`。
- 实现：`components/ui/Button.tsx`、`components/ui/Button.module.css`。
- 图标：`components/AppIcon.tsx`。

## 例外或待确认

历史领域按钮尚未全部迁移到共享组件；仅在当前任务影响其行为或形成稳定复用时迁移。
