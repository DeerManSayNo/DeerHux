# 构建资源控制

`npm run tauri:build` 仍是桌面打包入口。前端使用 webpack 持久缓存，
`verify-message-css.js` 在打包前检查消息样式及明暗主题 accent，校验失败即停止。
不要通过每次删除 `.next` 或 `src-tauri/target` 来解决构建卡顿，那会丢失增量缓存。

默认资源预算：

- Next 页面 worker 为 2，webpack 在独立 worker 中编译，启用内存优化。
- webpack 模块编译并发为 8，避免默认 100 个任务同时分配原生内存。
- 构建 Node 的 old-space 上限为 4096 MiB；这不是整个进程树的内存上限。
- 构建环境的 Rayon 与 Tokio 原生线程池默认为 2。
- Tauri 目录的 Cargo 配置限制同时编译任务为 2。

已有 `NODE_OPTIONS` 堆配置、`RAYON_NUM_THREADS`、`TOKIO_WORKER_THREADS` 和 `CARGO_BUILD_JOBS` 可以覆盖
相应预算。并发限制用较长的冷构建时间换取桌面响应空间，不保证 CPU 完全空闲。

Tailwind 在 `app/globals.css` 使用 `source(none)`，只扫描 `app`、`components`、
`hooks`、`lib`。自动扫描曾把 `src-tauri` 注册为目录依赖，而 Next 的 PostCSS loader
只保留目录、忽略 glob 限定，导致 webpack 递归快照整个 `target`。
诊断客户端 worker 的系统报告记录过 28.7 GiB 的 physical-footprint 峰值；
仅看 RSS 或限制 V8 堆都不足以发现或控制它。
新增前端源码根目录时要同步 `@source` 和边界测试，不能恢复仓库根目录自动扫描。

回归检查：`node scripts/test-build-css-sources.js`、`node scripts/test-build-tracing.js`。

`next.config.ts` 在 webpack 入口追踪和最终文件清单两个阶段排除旧 Tauri 产物、
参考仓库及临时构建目录。前期适配依赖 Next 16.2.1 的 `TraceEntryPointsPlugin`；
升级 Next 后如果接口变化，会明确报错，必须检查适配后再打包，不能静默移除检查。
技能路径的静态分析会生成 `**/SKILL.md` 扫描，它会遍历旧构建目录；仅排除最终
文件不能避免遍历。因此前期追踪跳过此类技能资产，随后由 `prune-standalone.js`
明确复制五个内置技能目录。用户技能仍在运行时从用户配置的位置加载。

验证前端生产构建时可使用独立目录，避免覆盖正在运行的开发输出：

```sh
DEERHUX_BUILD_DIR=.next-build-check npm run build
```

连续执行两次可检查缓存复用。该目录仅用于验证；普通 Tauri 打包仍读取 `.next`，
不要把上述环境变量带入 `tauri:build`。开发和正式打包仍不应同时写入默认 `.next`。

验证时检查完整生产构建、CSS 校验、standalone 启动、技能资源、依赖清单中没有
`src-tauri/target` 和 `codeAgent`，并记录构建进程树 RSS、换页增量及各阶段耗时。
RSS 采样和历史耗时只能描述对应那一次运行，不能替代整机响应或完整 DMG 验收。

## 2026-09-18 本机验证

- 24 GiB / 10 核 macOS，最终构建仍使用系统 Node 26.7.0，没有通过切换 Node 掩盖问题。
- 故障客户端 worker 的 `sample` / `vmmap` 记录 physical-footprint 峰值 28.7 GiB。
- 收紧 Tailwind 目录后，一次完整生产构建的进程树 footprint 采样峰值约 2.8 GiB；
  这是约 3 秒间隔的采样，不是内核记录的精确峰值，两者不能用来计算精确降幅。
- 该次 `globals.css` 模块编译 5.2 秒；历史同项记录约 177 秒。
- 随后的缓存构建完整通过，客户端 webpack 阶段 0.84 秒，全流程约 162 秒。
  工作区并行活动和系统换页状态不同，耗时不是严格同条件基准。
- 80 份路由依赖清单未包含旧 `target` / `codeAgent` 产物；5 个内置技能与源码一致。
- standalone 在隔离用户目录中启动：首页实际渲染及 `/`、`/file-preview`、
  `/api/models`、`/api/skills` 的 HTTP 200 检查通过，临时服务已清理。
- 类型检查、扫描回归、Token/主题/生产 CSS 门禁通过；lint 为 0 错误、36 个已有警告。
- 本次没有重建完整 DMG 或替换已安装应用；Cargo 的并发限制属于配置验证。
