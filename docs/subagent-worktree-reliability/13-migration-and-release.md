# 13 迁移、灰度、发布与回滚

## 目标

在不破坏已有 Collaboration Run、Session 浏览和 SSE 客户端的前提下替换 Worktree 主链路，并为异常状态提供退路。

## 当前实现与发布边界（2026-09-05）

本轮只交付代码、测试与运行手册，没有 commit/拆 PR、推送、构建发布包、部署或修改用户运行环境。下方 PR、灰度和观察项不能用本地测试替代。

| 控制 | 行为 |
|---|---|
| `SUBAGENT_WORKTREE_V2` 未设置或非 `1`/`true` | 拒绝新 isolated Run，返回 503 `WORKTREE_V2_DISABLED`；analysis 不受影响 |
| `SUBAGENT_WORKTREE_V2=1` | 显式启用新 v2 Run，仍要求 clean Git 仓库及配额 |
| `SUBAGENT_WORKTREE_V2_APPLY=0` | 拒绝新 Apply，返回 503 `APPLY_DISABLED`；artifact 读取与已核验 applied 历史重放保留。未设置时已有 v2 Run 可正常 Apply；未知值保守禁用 |
| `GET /api/agent-runs/capabilities` | no-store 服务端开关快照；Run/Mux 快照包含 `worktreeCapabilities`，前端不读取环境变量。缺失能力字段的旧快照不授权新变更 |
| `GET /api/agent-runs/:id/recovery` | legacy 的有界脱敏 JSON 元数据下载。冷缓存只读最多 8 MiB Store 历史尾部，不执行恢复写入、Git 或 Session I/O；报告生成纯函数，不导出旧 Diff 正文，不授权迁移或清理 |

**`RLS-1311` 安全偏差**：关闭 v2 时停止新隔离 Run，不重新引入旧创建/捕获链。旧链缺少可靠创建基线，复活会绕过已经完成的安全修复。已有 format v1 manifest 始终使用 v2；新增可选 `implementationVersion: 2`，不支持的值拒绝，不降级。缺失 manifest 的 v2 标记 Run 进入人工恢复，不当作 legacy 自动处理。legacy applied 仅保留历史声明，不能据此重新清理。

Stage A–E 是尚未执行的**部署 cohort 验收流程**，不是当前已实现的逐能力 feature flags。仅提供 admission 与紧急 Apply 刹车；不得宣称已完成逐阶段开放或默认上线。每阶段先由操作员选择对应测试 cohort，观察至少完整 2 小时保留窗口并记录 metrics/inventory，再决定扩展；Stage E 默认启用必须另行授权。关闭创建开关不会即时中断已接纳的 Run，也不撤销已提交的 Git 操作；紧急刹车仅阻止接纳新的 Apply，不能撤销已经进入执行的事务。

回滚顺序：先关闭新建，按需关闭新 Apply；保存私有 Run manifest/artifact 与只读盘点结果；保持具备 v2 读取/恢复能力的版本处理现存 Run，**不能部署旧 cleanup 对其执行删除**。不运行 reset hard、批量删除临时根或全局 prune。没有可信 legacy 基线时保留副本并人工恢复，不从当前 HEAD 猜测。旧 Diff 正文可能含凭据，因此只导出元数据；本轮没有自动转换能力。

本地必跑命令：`npm run test:core`、`npm run test:worktree-browser`、`npm run test:worktree-stress -- --large`、`node_modules/.bin/tsc --noEmit`、`npm run lint`、`git diff --check`。可用 `npm run test:worktree-validation` 聚合前三项，**不调用 build/publish**。24 小时耐久命令为 `npm run test:worktree-stress -- --duration-hours 24`，尚未执行，也未安排后台自动运行；Node 父进程 RSS 不包含子 Git 峰值。真实 HTTP+浏览器全栈、Tauri 人工重启、2 小时灰度窗口与一周观察仍待发布前完成。

## 开发分支顺序 TODO

- [ ] `RLS-1301` PR 1：Git command layer、repo identity、manifest 类型和纯函数测试。
- [ ] `RLS-1302` PR 2：固定 baseCommit、唯一 workerId、创建回滚和 capture artifact。
- [ ] `RLS-1303` PR 3：原子 Apply transaction 与 API v2 兼容层。
- [ ] `RLS-1304` PR 4：启动 reconciler、Continue/Discard/cleanup plan。
- [ ] `RLS-1305` PR 5：前端审阅和操作闭环。
- [ ] `RLS-1306` PR 6：环境 hook、诊断、耐久测试和旧代码删除。
- [ ] `RLS-1307` 每个 PR 独立可回滚，不把 UI 与未完成的危险后端路径同时启用。

## Feature Flag TODO

- [x] `RLS-1310` 增加服务端 `SUBAGENT_WORKTREE_V2` 功能开关，默认关闭进入代码库。
- [ ] `RLS-1311` v2 关闭时保留旧创建/捕获，但应用 Phase 0 危险行为保护。
- [x] `RLS-1312` v2 开启后同一个 Run 全生命周期固定使用 v2，禁止中途切换。
- [x] `RLS-1313` manifest 记录实现版本，恢复时路由到对应 reconciler。
- [x] `RLS-1314` 前端能力从服务端快照读取，不直接读取环境开关。

## 旧 Run 迁移 TODO

- [x] `RLS-1320` 启动时识别没有 manifest 的 legacy Run，但不自动为其伪造 `baseCommit`。
- [x] `RLS-1321` legacy Worktree仍存在时，允许从有界 Store 历史生成只读脱敏元数据恢复报告，不执行 Git/Session/manifest 写入。
- [ ] `RLS-1322` 只有能从创建记录可靠证明基线时才允许转换为 v2 capture。当前实现更保守：一律不自动转换；可靠转换器尚未交付。
- [x] `RLS-1323` 无法证明基线的 legacy Run 禁止自动 Apply，提供导出 Diff/人工处理指引。
- [x] `RLS-1324` legacy 已 applied Run 保持历史展示，不重新触发清理。
- [x] `RLS-1325` 不批量改写 Session JSONL 或创建运行时 Wrapper。

## 灰度 TODO

- [ ] `RLS-1330` Stage A：开发环境启用单 Worker文本 patch，收集 setup/capture 指标。
- [ ] `RLS-1331` Stage B：启用二进制和 Worker commit 场景，验证 tree digest。
- [ ] `RLS-1332` Stage C：启用多 Worker原子 Apply，先限制 clean 主仓库。
- [ ] `RLS-1333` Stage D：启用重启 reconciler 和显式 Discard，保持自动清理保守。
- [ ] `RLS-1334` Stage E：开放前端入口和默认 v2。
- [ ] `RLS-1335` 每一阶段至少观察一个完整保留窗口，并检查 preserved/cleanup_error 数量。

## 发布前检查 TODO

- [x] `RLS-1340` 逐项关闭 README 中 16 个问题映射的 P0/P1 任务；P2/发布期长时门禁保留在 12/13/16。
- [x] `RLS-1341` P0/P1 测试、类型检查、lint、diff check 全绿（lint 为 0 error、36 条既有 warning）。
- [x] `RLS-1342` 在 macOS 与 Linux 至少各跑一次真实 Git E2E。
- [ ] `RLS-1343` 对 Node/Tauri 本地后端重启场景做人工验收。
- [x] `RLS-1344` 审查临时目录权限、manifest 脱敏和 API 错误输出。
- [x] `RLS-1345` 检查磁盘占用和 Artifact 保留策略，不删除未结算成果。
- [x] `RLS-1346` 更新 `docs/project-feature-list.md` 和架构文档的实际能力描述。

## 回滚 TODO

- [x] `RLS-1350` 回滚应用代码前先停止新 Run 创建，不删除 v2 manifest/artifact。
- [x] `RLS-1351` 已创建的 v2 Run 由只读恢复工具列出，不能交给旧 cleanup 处理。
- [x] `RLS-1352` 回滚到旧 Apply 时继续拒绝多 Worker、二进制和空选择。
- [x] `RLS-1353` 保留 v2 Diff 下载和人工恢复能力，直到所有 v2 Run 结算。
- [x] `RLS-1354` 回滚不得执行 `git reset --hard`、批量删除 `/tmp/deerhux-runs` 或清除未知分支。

## 上线后验证 TODO

- [ ] `RLS-1360` 监控 setup/capture/apply/cleanup 的成功率和 P95 时长。
- [ ] `RLS-1361` 每日检查 preserved、recovery_required、partial cleanup 和 stale transaction。
- [ ] `RLS-1362` 对任一数据丢失迹象立即关闭 v2 新 Apply，保留创建和 artifact 读取。
- [ ] `RLS-1363` 一周后评估 legacy 兼容层使用量，再决定删除时间。
- [ ] `RLS-1364` 删除旧路径前再做一次 codegraph callers/impact 检查。

## 最终退出条件

- [x] 所有新接纳的 `isolated_coding` Run 100% 使用 manifest 和固定 baseCommit；analysis Run 不适用。
- [x] 旧 `generateDiff(worktreePath)` 已移除；逐 Worker `applyPatch()` 只保留固定拒绝的兼容 guard，无生产调用方。
- [x] 启动时无条件删除逻辑已移除，启动恢复只生成保守协调/保留决策。
- [x] 前端、API、Store 和 Git 实际状态在自动化重启与失败场景下一致；Tauri 发布包人工重启另列发布门禁。
