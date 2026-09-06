# CodeGraph 桌面打包

CodeGraph 通过子进程运行，Next.js 的静态依赖追踪不会自动收集它。`npm run build` 的 standalone 后处理会调用 `scripts/bundle-codegraph.js`，复制与构建目标匹配的 `@colbymchenry/codegraph-<platform>-<arch>` 完整运行库；Tauri 随 standalone 目录一起打包。

运行时直接调用该包内的 Node 和 CLI 入口，保留上游要求的 `--liftoff-only`，不依赖系统 Node、全局 codegraph 或 npm `.bin` 链接，也不会自动下载运行库。工作目录仍为待分析项目。

目标优先读取 `TAURI_ENV_TARGET_TRIPLE`，否则使用构建主机平台。缺少对应平台包、版本与主包不匹配或缺少运行入口都会使打包失败。跨平台构建必须预先安装目标平台的 optional dependency；不能用主机平台包冒充目标包。

CodeGraph 0.9.9 的 darwin-arm64 完整运行库本机解压约 181 MiB（含其 Node、解析器和依赖），这不是压缩后的安装包增量。

运行时初始化或状态读取失败会输出 `[codegraph]` 诊断，包括项目路径、错误原因和有长度限制的 stderr；桌面启动器会收集到 `~/.deerhux/agent/logs/desktop-startup.log`。工具仅在初始化成功后注册。已有索引的状态读取失败时，不再尝试重新初始化掩盖错误。

## 验证

`npm run test:codegraph` 在临时目录执行真实打包复制，并清空 PATH，验证自动索引、工具注册、符号检索、调用关系、预先取消和缺失运行库时的诊断。临时项目和索引在测试结束后删除，不导入应用项目列表。

当前已验证 macOS ARM64；Windows、Intel Mac 等目标仍需在对应平台运行相同测试。开发验证不运行 `next build`；修改源代码不会更新已安装的 DeerHux.app，需在 release 构建后安装新版并重启应用。
