# Token 使用

## 来源

- 权威来源：`app/design-tokens.css` 维护跨主题固定的圆角、排版和层级；`app/globals.css` 维护颜色、阴影、字体、主题值与 Tailwind `@theme` 映射。
- 格式与生成：Token 直接以 CSS 自定义属性维护，没有独立生成步骤。不要引入平行 JSON 色板或在 `tailwind.config.ts` 复制具体值。

## 使用规则

- 组件优先引用语义 Token；只有无法形成共享语义的局部结构值可以留在组件作用域内。
- 命名按用途使用 kebab-case，例如表面 `--bg-panel`、文字 `--text-muted`、控件圆角 `--radius-control`。
- 浅色主题定义于 `:root`，深色主题定义于 `html.dark`，默认主题为深色；切换、持久化和多窗口同步入口见 `lib/theme.ts`、`hooks/useTheme.ts` 与 `app/layout.tsx`。
- 新增主题语义必须同时覆盖明暗模式，并检查实际前景与背景配对。别名必须存在、类型兼容且无循环。
- 共享值只在权威源修改；修改前检查消费方、Tailwind 映射、主题覆盖和验证脚本。

## 入口

- 基础值：`app/design-tokens.css` 中的字号、字重、行高、圆角与 z-index 档位。
- 语义值：`app/globals.css` 中的表面、文字、操作、状态、聊天表面、阴影和字体。
- 组件值：由 `components/ui/*.module.css` 在组件作用域内组合语义 Token，尚无独立组件 Token 文件。
- Tailwind：`app/globals.css` 的 `@theme` 只映射现有语义 Token。
- 校验：

```sh
node scripts/test-design-tokens.mjs
node scripts/test-theme-colors.mjs
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-theme-sync.ts
node scripts/test-production-theme-css.js
```

现有回归只约束脚本列出的 Token、已迁移模块和颜色配对，不能据此认定全部历史样式已经 Token 化。
