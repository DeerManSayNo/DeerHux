# 过渡与骨架屏

本系统约束内容进入、异步等待、错误和恢复时的布局与反馈。

## 当前规则

- 加载反馈应占据最终内容的稳定区域，避免按钮文案、标签或占位内容改变主要布局尺寸。
- 流式消息显示实际已到达内容和当前运行状态；停止、失败与重试保留在对应会话上下文。
- 异步提交期间禁用重复触发，失败后保留有效输入并说明恢复方式。辅助技术需要通过邻近文本或 live region 获得关键状态。
- 短暂加载是否延迟展示由领域实现决定；不得为所有请求无条件显示全屏遮罩。

## 引用

- 实现：`components/SessionLoading.tsx`、`components/ChatWindow.tsx`、`components/MessageView.tsx`、`components/AppShell.tsx`。
- 样式：`components/SessionLoading.module.css`、`components/chat-surface.css`。

## 例外或待确认

状态为待补齐。项目尚无统一的加载阈值、骨架与最终内容映射、超时和重试契约；新增共享加载模式前需在代表性页面验证。
