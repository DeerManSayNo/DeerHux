# 动效

动效用于解释状态连续性和空间关系，不承担装饰任务。

## 当前规则

- 常规颜色、边框和表面反馈沿用 150ms ease；位移动效仅在能解释元素来源、去向或状态变化时使用。
- 用户输入和取消操作必须可中断动效，不能等待动画结束才能继续任务。
- `prefers-reduced-motion: reduce` 下停用非必要动画、旋转和自动平滑滚动，保留即时状态反馈。
- 主题切换可使用 View Transitions；不支持或减少动效时直接切换，不影响主题结果。

## 引用

- 实现：`app/globals.css`、`components/workbench.css`、`components/ui/Button.module.css`、`hooks/useTheme.ts`。
- 示例：工作台按钮反馈与主题切换。

## 例外或待确认

当前没有全局时长与缓动 Token；新增共享动效形成稳定复用后再评估提升，避免仅为统一格式增加 Token。
