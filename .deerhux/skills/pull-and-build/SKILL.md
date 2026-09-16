---
name: pull-and-build
description: |
  拉取 DeerHux 最新代码并打 Tauri Windows 构建包（NSIS 安装包）。
  当用户说"拉代码并打包"、"拉取最新代码并构建"、"打个构建包"、"同步并打包"、"pull and build"等时使用。
  仅拉取+构建，不提交不推送。
---

# 拉取最新代码并打构建包

在项目根目录（DeerHux 仓库）执行，流程分两步：同步远程代码 → Tauri 构建。

## 第一步：拉取最新代码

1. `git fetch origin`，然后 `git status --short --branch` 查看本地与远程差异。
   - 注意：此环境访问 GitHub 偶发 `curl 56 Connection was reset`。只要 fetch 已成功（`origin/main` 已更新），直接 `git merge --ff-only origin main` 本地快进即可，无需重试网络。
2. 若本地有未提交改动，先用 `git diff --name-only` 与 `git diff --name-only HEAD origin/main` 比对是否文件重叠；无重叠可直接快进合并，改动会保留。
   - 若改动仅是 LF/CRLF 行尾差异（git diff 无实际内容输出），可忽略，不影响构建。
3. 快进合并：`git merge --ff-only origin main`。
   - 若本地有领先提交导致无法快进，参考 ccomit-auto-git 技能处理，或询问用户。

## 第二步：安装依赖（关键，勿跳过）

本机全局 npm 配置了 `omit=dev`，普通 `npm install` 会跳过并**删除**所有 devDependencies（`@tauri-apps/cli`、tailwind 等都在其中）。必须：

```bash
npm install --include=dev
```

拉取后若 package.json / package-lock.json 有变化，必须先执行此步，否则构建报 `matter-js` 之类的缺包错误，或 `tauri.js` 消失。

## 第三步：构建

不要用 `npx tauri build`（此环境 npx 解析失败）。直接：

```bash
node_modules\.bin\tauri.exe build
```

- beforeBuildCommand 会自动执行 `npm run build`（next build --webpack + CSS 校验 + standalone 裁剪），这是 release 流程，允许运行 next build。
- Rust release 编译约 1~2 分钟；`scheduler_lock_path` 未使用的 dead_code 警告无害。

## 产物位置

- NSIS 安装包：`src-tauri\target\release\bundle\nsis\DeerHux_{版本}_x64-setup.exe`
- 裸可执行文件：`src-tauri\target\release\deerhux.exe`

## 安装包图标（必查项）

`tauri.conf.json` 中 `bundle.icon` 只决定应用本体（deerhux.exe）图标；NSIS 安装包（setup.exe）与卸载器必须显式配置，否则嵌入的是 NSIS 默认图标：

```json
"nsis": {
  "installMode": "currentUser",
  "installerIcon": "icons/icon.ico",
  "uninstallerIcon": "icons/icon.ico"
}
```

构建后可抽查 setup.exe 是否内嵌自定义图标：用 PowerShell P/Invoke `EnumResourceNames`(RT_ICON=3) 列出图标资源大小，与 `icons/icon.ico` 各条目 bytes 对比；全不匹配即未嵌入。`icons/icon.ico` 需含 16~256 多尺寸条目。

构建成功后向用户报告产物路径与大小。

## 环境注意

- Shell 是 Windows cmd：没有 `head`/`tail`，用 `dir /b`、`findstr` 代替；多命令串联用 `&`。
- 前置依赖（正常情况均已就绪）：`cargo`/`rustc` 工具链、`src-tauri\binaries\node-x86_64-pc-windows-msvc.exe`、`src-tauri\resources\deerhux-server.js`、项目根 `skills` 目录。
- 构建超时给足：建议 30 分钟。
