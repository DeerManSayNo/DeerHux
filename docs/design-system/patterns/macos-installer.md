# macOS 安装窗口

DMG 使用 Finder 原生图标视图。左侧为可拖动的 DeerHux 应用，右侧为指向 `/Applications` 的系统文件夹链接；背景只承载品牌、方向提示和安装说明。

## 设计依据

- 品牌区沿用默认深色主题的背景、文字与品牌 Token；拖拽区沿用浅色主题的 `--bg-panel`、`--border`、`--text-muted`、`--accent`。Finder 在图片背景上显示黑色文件名，浅色表面确保原生名称可辨识；橙色突出拖动方向。
- 上部为品牌和简短介绍，下部在一个连续表面内呈现安装动作，底部说明安装后的打开位置。
- 标题是安装封面的局部展示文案，使用 `--text-xl` 的两倍字号；其余文字与字重沿用现有档位。这一比例只适用于静态安装封面，不扩充产品 UI 字阶。
- 使用系统中文无衬线字体。箭头来自现有 `lucide-react`，应用和文件夹使用 Finder 真实图标，不烘焙进背景。
- 背景为静态深色品牌区与浅色安装区，不跟随系统主题切换；Finder 标题栏与原生文件名由 macOS 管理。窗口高度包含标题栏空间，避免底部说明被裁切。

## 实现与验证

- [背景生成器](../../../scripts/render-dmg-background.js) 直接读取 Token 源码，输出 SVG、PNG 与包含普通／Retina 两档的 TIFF。
- [布局配置](../../../scripts/dmg-layout.json) 统一维护背景尺寸和 Finder 图标位置；[打包脚本](../../../scripts/package-mac-dmg.js) 自动生成背景并将窗口布局写入 DMG。
- `npm run tauri:build` 使用完整发布流程；`npm run package:mac-dmg -- --output <独立输出路径.dmg>` 可复用已有 app bundle 验证安装窗口，不代表应用源码已重新构建。
- 验收应重新挂载最终压缩 DMG，检查标题、说明、图标、文件名与底部文案均完整可见，确认 Applications 链接指向系统应用程序目录，并执行 `hdiutil verify`。

生成的图片不是独立设计值来源；更新配色、字号或布局后应重新运行生成器。Finder 背景没有网页语义，操作对象始终保留原生可访问名称和键盘操作。
