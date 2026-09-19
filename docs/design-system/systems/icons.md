# 图标

图标系统统一常见动作和状态图形的来源、尺寸、描边与可访问名称。

## 当前规则

- 常见动作通过 `AppIcon` 使用 `lucide-react`，优先复用已注册名称，不为库中已有动作手绘 SVG。
- 尺寸使用 `inline`、`compact`、`toolbar`、`section` 四档；描边宽度与对齐由 `AppIcon` 统一维护。
- 控件自身提供 `aria-label`；独立表达状态的图标使用 `label`；装饰图标对辅助技术隐藏。
- 领域专用图形和文件类型图标可独立实现，但必须保持作用域明确，不进入通用动作集合。

## 引用

- 品牌采用 C 折叠路径方案：一条向前折返的连续带状结构表达 Agent 的理解、执行与返回闭环。图形不使用鹿、字母或代码括号等字面元素；空间感仅由三个相邻橙色平面和克制的下沿厚度构成，在 16–32px 小尺寸下仍以单一前进轮廓为第一识别。兼容主题入口分别为 `public/brand/deerhux-c-light.svg`、`public/brand/deerhux-c-dark.svg`，两者有意共享深色底板，保持跨主题品牌一致性。首页空白区不展示图形 Logo，保留文字与新建会话入口。
- `node scripts/sync-brand-icons.mjs` 从 SVG 母版生成网页缩略图及桌面 PNG／ICNS／ICO。macOS 26+ 另使用 `src-tauri/icons/Icon.icon` 的无预裁切分层母版；经过验证的 `src-tauri/icons/Assets.car` 作为原生图标编译产物随 macOS 包复制，避免 Tahoe 下从 npm／Node 实时调用 `actool` 时出现 `Bad file descriptor`。修改分层母版后必须重新生成并验证 `Assets.car`。ICNS 继续作为旧版 macOS 回退，ICO 用于 Windows。桌面安装包和网页均使用深色底板；旧 A 位图、D 路径、v2 SVG 与字标作为历史资产保留，不再作为图标生成输入。

- 实现：`components/AppIcon.tsx`。
- 依赖：`lucide-react`，版本以 `package.json` 为准。
- 示例：`components/ui/Button.tsx`。

## 例外或待确认

部分历史组件保留内联 SVG；在相关组件维护时评估语义和视觉兼容后迁移。
