# 颜色

颜色系统为明暗主题提供表面、文字、操作、聊天和状态语义。

## 当前规则

- 表面使用 `--bg`、`--bg-panel`、`--bg-hover`、`--bg-selected`、`--bg-subtle` 与 `--border`；文字使用 `--text`、`--text-muted`、`--text-dim`。
- 列表选中使用中性的 `--bg-selected`，不混入主题强调色；文字或图标可按信息层级补充强调。主操作和焦点反馈使用 `--accent`、`--accent-hover`、`--accent-foreground`。`--action` 系列只沿用已有明确消费场景，新增场景先判断是否属于 accent。
- 状态使用 `--success`、`--warning`、`--danger`、`--info` 及对应背景。状态同时提供文字或图标信息，不能只靠颜色区分。
- 聊天表面使用 `--user-bg`、`--assistant-bg`、`--tool-bg`，不借此扩展全局表面层级。
- 新增配对按 WCAG 2.2 的适用对比度要求验证；当前自动化只覆盖脚本列出的配对。

## 引用

- Token：`app/globals.css`，使用方式见 `docs/design-system/token-contract.md`。
- 映射：`app/globals.css` 的 `@theme`。
- 校验：`scripts/test-theme-colors.mjs`、`scripts/test-production-theme-css.js`。

## 例外或待确认

历史领域组件仍有硬编码颜色和局部表面变量，按实际任务渐进迁移，不视为新增界面的依据。
