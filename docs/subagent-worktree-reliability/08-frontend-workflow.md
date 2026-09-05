# 08 前端 Diff、Apply、Discard 与恢复流程

## 目标

在协作卡片中提供真实可用的成果审阅和操作入口，避免文案声称可应用而界面没有操作。

## 当前实现与验收边界（2026-09-05，章节审查通过）

- 卡片使用稳定 Worker ID，显示捕获/恢复状态、文件与二进制数量、继续能力和成果操作区；完整 Worker 结果可就地展开。Run/SSE 快照不携带内部 Session ID，用户主动点击卡片时才通过定向接口解析并打开对应 Worker Session。
- Mux 使用版本号优先合并，capture digest 变化会先清除旧 artifact 选择资料，再获取详情。不会为了已脱敏的 Session ID 在每次事件上反复获取详情。
- 审阅按需读取摘要与正文；二进制或超过内联上限的 artifact 只下载。新 capture 契约提供新增/修改/删除/重命名/类型变化、Git blob 旧/新侧大小及文本增删行，UI 使用独立图标与标签；旧 capture 缺字段时明示未知，不从 patch 或显示字符串猜测。
- Apply 结果未知时保留原始幂等键和 payload（优先 sessionStorage，不可用时保留内存），核验前禁用新 Apply/Continue/Discard；实际应用文件以服务端刷新结果为准。`recovery_required` 保持人工恢复阻断。
- Discard 先预览再确认，高风险需要明确文本；207 显示部分资源仍保留，不表示清理完成。
- 单元测试接入 `npm run test:worktree-ui`；真实 Chromium 浏览器验收使用 `npm run test:worktree-browser`。浏览器 runner 使用本机已有 Chrome/Edge 和 Next 内置 webpack，在独立临时目录构建真实组件 fixture，不下载浏览器、不创建生产测试路由，也不运行 `next build` 或改写 `.next`。
- 全交互浏览器验收已通过，包含真实鼠标/键盘操作和 Mock HTTP 故障；主 agent 已核验桌面/移动/浅色截图。该证据不替代后续真实服务端 E2E、Safari/Firefox 或生产灰度。

## 涉及文件

- `components/SubagentRunCard.tsx`
- `components/ChatWindow.tsx`
- `components/MessageView.tsx`
- `hooks/useAgentSession.ts`
- 可按现有模式新增 `components/SubagentDiffDialog.tsx`

## 信息架构 TODO

- [x] `UI-0801` 为 isolated coding Run 显示 capture 状态：捕获中、可审阅、捕获失败、已保留。
- [x] `UI-0802` 每个 Worker显示 changed file 数、增删统计、二进制文件数和 Apply 状态。
- [x] `UI-0803` Run 级操作区只显示当前状态允许的命令：审阅、应用、继续、放弃、恢复说明。
- [x] `UI-0804` 显示名称可重复时，辅以稳定短 ID；React key 和请求参数使用完整 workerId。
- [x] `UI-0805` 不在界面显示 Worktree 绝对路径、Session ID 或 manifest 路径。

## Diff 审阅 TODO

- [x] `UI-0810` 点击审阅后按 Worker加载文件列表，不预加载全部 patch 正文。
- [x] `UI-0811` 文件列表使用 checkbox 多选，并提供全选/清空；Apply 按钮在零选择时禁用。
- [x] `UI-0812` 文本文件支持按需加载 unified diff；大文件显示截断状态和下载入口。
- [x] `UI-0813` 二进制文件显示文件名、变更类型和大小，不渲染乱码。
- [x] `UI-0814` 重命名、删除、新建使用不同图标和文本标签。
- [x] `UI-0815` Worker 间同路径冲突在提交前展示预检查结果。
- [x] `UI-0816` Dialog 关闭重开后保持本地选择，但 Run 版本变化时清空旧选择。

## Apply TODO

- [x] `UI-0820` 使用清晰的 Apply 命令按钮并配合现有图标库图标和 tooltip。
- [x] `UI-0821` 点击后先提交预检/Apply 请求，期间禁用 Continue、Discard 和重复 Apply。
- [x] `UI-0822` 成功后依据服务端实际结果更新 Worker 文件状态，不乐观伪造 appliedFiles。
- [x] `UI-0823` 冲突时保留选择，展示冲突文件和重新审阅入口。
- [x] `UI-0824` `no_changes` 显示为未执行，不使用成功色或“已应用”文案。
- [x] `UI-0825` `recovery_required` 显示阻断状态和诊断入口，禁止一键重试。
- [x] `UI-0826` 网络中断后先按 idempotency key 查询结果，再允许重试。

## Continue 与 Discard TODO

- [x] `UI-0830` Continue 仅在 `canContinue` 且 Worktree 存在时可用。
- [x] `UI-0831` 展示 Continue 到期时间；到期后刷新服务端状态，不能仅依赖浏览器计时。
- [x] `UI-0832` Discard 先请求 preview，在确认框列出会失去的能力和未应用文件数量。
- [x] `UI-0833` 未捕获 dirty 变更需要用户输入明确确认，不复用普通确认按钮。
- [x] `UI-0834` partial cleanup 显示“部分资源仍保留”并提供重试/诊断，不能显示完成。

## 响应式与可访问性 TODO

- [x] `UI-0840` 卡片和 Dialog 在窄屏不出现文字/按钮重叠。
- [x] `UI-0841` 工具栏使用固定尺寸图标按钮，未知图标带 tooltip 和 aria-label。
- [x] `UI-0842` Dialog 支持键盘焦点循环、Escape 关闭和提交中的关闭保护。
- [x] `UI-0843` 状态不能只靠颜色表达；必须有文字或图标语义。
- [x] `UI-0844` 长文件名允许换行/中间省略，并提供完整 title。

## 测试 TODO

- [x] `UI-0850` 组件测试覆盖所有 Run/Worker 状态和按钮显隐。
- [x] `UI-0851` Mock API 覆盖 200、409、412、500、断网和重复提交。
- [x] `UI-0852` Playwright 覆盖选择两个 Worker、部分文件 Apply、冲突后重试、Discard。
- [x] `UI-0853` 截图检查桌面和移动 viewport，无重叠、截断错误或空白 Dialog。
- [x] `UI-0854` 扩展 `scripts/test-perf-mux-ui-contracts.ts` 的脱敏和兼容断言。

## 验收标准

- [x] 用户无需调用 API 即可完成审阅、按文件 Apply、Continue 和 Discard。
- [x] UI 展示结果始终来自服务端事实，不把请求意图当作完成结果。
- [x] 错误后成果仍可访问，界面给出下一步操作。
