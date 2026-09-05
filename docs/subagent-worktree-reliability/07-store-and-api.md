# 07 Collaboration Store、API 与事件契约

## 目标

让持久状态、HTTP 结果和 SSE 事件准确反映 capture/apply/cleanup 事实，并维持旧客户端可读。

## 当前实现与限制（2026-09-05，章节审查通过）

- Run 状态更新使用版本前置条件；Continue 在 capture 和租约结算结束前保持运行中。捕获、应用、恢复和清理事件保留兼容名称，并使用固定字段投影。
- Diff 默认只返回摘要；正文按需获取。内联上限为 1 MiB，artifact 总上限为 256 MiB；下载校验异步完成，不在请求线程同步扫描整个 patch。
- Discard 的确认 token 一次性使用，有效期 5 分钟，最多保存 256 个，绑定 manifest digest 与预览时的分支提交。同一选择重新预览会替代旧 token。当前实现无法可靠冻结工作树之外仍可能存活的写入者，因此仍存在的 Worktree 会保留，并通过 `retainedResources` 和 `complete: false` 明示结果。
- V1 manifest 缺少 Apply/Discard 后审计保留期起点，不能仅凭旧 capture 时间证明审计期结束；既有 patch 保守保留。完整物理回收需后续持久化审计起点和可靠的写入者控制，不能把本阶段 partial 结果当作全部删除。
- `npm run test:core` 已接入 Continue、Store、capture 生命周期、接口脱敏、Diff、Discard 与 Apply Store/API 专项。完整核心回归及末次受影响专项通过，独立交叉审查已清零本章已发现 P0/P1；具体记录见 00 执行看板。
- Discard 的 patch 校验使用有界异步读取；现有 `collectGitFacts` 内 Git 对账及 Run 目录扫描仍是同步实现，作为后续性能治理项跟踪，不应宣传为完全无阻塞接口。
- WP10 后续加固：Discard preview 另绑定 Store 创建时的 repo/base 身份，token 保存该独立身份，commit 锁前/锁内重新核验；manifest 自洽或仅 path 匹配不能授权删除。管理端不再调用会执行 clean filter 的 `git status`，未知 tracked 内容以 `WORKTREE_CONTENT_UNVERIFIED` 风险显示并要求确认，现存 Worktree 仍保留，文件数未知为 `null`。无独立创建锚点的自动清理不再删除孤儿分支，详见 10。

## 客户端契约（V1）

所有 URL 使用经过编码的稳定 `runId` / `workerId`。客户端不得发送本地路径或通过显示名称猜测 Worker 身份。

| 操作 | 请求 | 结果与处理 |
|---|---|---|
| 读取 Run | `GET /api/agent-runs/:runId` | 直接返回 Run 快照（没有 `{ run }` 包装），以 `version`、capture digest 和实际状态刷新 UI，不根据请求意图推断结果。 |
| Apply | `POST /api/agent-runs/:runId/apply`，`{ workerIds, files?, idempotencyKey }` | 返回 `outcome`、`success`、`transactionId`、`workerIds`、`files`、`runVersion`、`requestId`；只有 `outcome: applied` 是成功。 |
| Diff 摘要 | `GET /api/agent-runs/:runId/diff?workerId=...` | `files` 与 `artifact` 元数据；不包含 patch 正文和内部路径。新 capture 从已验证的不可变 Git tree 返回变更类型、旧/新 blob 字节数与文本增删行；旧 capture 缺字段时返回 `null`，不得伪造为 0。 |
| Diff 正文 / 下载 | 同上增加 `format=patch` / `format=download` | `text/x-diff`，正文最多 1 MiB；更大的合法 artifact 仅允许下载。二进制不得直接渲染为文本。 |
| Continue | `POST /api/agent-runs/:runId/workers/:workerId/resume`，`{ prompt? }` | 返回 `{ run }`；服务端重新验证 Session、仓库、工作树和租约。不可用时 409，不泄漏内部 Session ID。 |
| Discard 预览 | `POST /api/agent-runs/:runId/discard`，`{ mode: preview, workerIds, strongConfirmation? }` | 返回逐 Worker 风险、保留资源、未应用文件数量及一次性确认 token；数量未知时为 `null`。 |
| Discard 确认 | 同上，`{ mode: commit, confirmationToken }` | 检查 `complete` 和每 Worker 的 `retainedResources`；207 表示仍有资源保留，不是完成。token 过期、已用或 manifest/分支变化后重新预览。 |

Apply 的 `files` 省略表示所选 Worker 的全部捕获文件；空数组不是全选。兼容窗口仍接受唯一 `workerNames` 和 `transactionId` 别名，但不能与对应新字段同时使用。无变更、冲突、需恢复返回 409；前置条件变化返回 412；输入错误 400；未知 Run 404；内部错误 500。`recovery_required` 不能显示为普通失败并自动生成新键重试。

网络结果未知时，客户端保留原幂等键与原选择，先读取 Run 的 `applyTransactionId` / `applyState`；仅在确认结果或使用同一键、同一请求重新核验后改变本地状态。不能以新键重复提交。Discard 的强确认文本固定为 `DISCARD_UNCAPTURED_CHANGES`，它确认风险而不是绕过数据保留保护。

## 涉及文件

- `lib/parallel-agent/collaboration-store.ts`
- `lib/parallel-agent/collaboration-types.ts`
- `lib/parallel-agent/collaboration-sanitize.ts`
- `lib/parallel-agent/subagent-persistence.ts`
- `app/api/agent-runs/[runId]/apply/route.ts`
- `app/api/agent-runs/[runId]/route.ts`
- `app/api/agent-runs/[runId]/events/route.ts`
- 新增 `app/api/agent-runs/[runId]/discard/route.ts`
- 新增 `app/api/agent-runs/[runId]/diff/route.ts`

## Store TODO

- [x] `API-0701` 将 Run 状态转换集中到带前置条件的 Store 方法，调用方不得直接改 `run.status`。
- [x] `API-0702` 增加 compare-and-set 版本号，防止 Apply、Continue、Abort 并发覆盖。
- [x] `API-0703` `applying` 状态必须带 transaction ID 和开始时间。
- [x] `API-0704` 将 `captured`、`preserved`、`recovery_required` 映射到明确的 Run/Worker 投影。
- [x] `API-0705` 对每次状态变化先持久化事实，再广播事件。
- [x] `API-0706` 事件写入失败不能反向撤销已经成功的 Git 操作；需记录 replay/snapshot 可恢复状态。
- [x] `API-0707` Run 事件继续保持最多 1000 条，新增事件不能绕过有界策略。

## Apply API TODO

- [x] `API-0710` 请求 schema 使用 `workerIds: string[]`、可选 `files: string[]`、必填/生成 `idempotencyKey`。
- [x] `API-0711` 对 JSON 类型、数组长度、字符串长度、重复值和未知字段执行严格校验。
- [x] `API-0712` 为 `no_changes` 返回 409 或稳定业务状态，不返回 HTTP 200 + `success:true`。
- [x] `API-0713` 冲突返回 409，前置条件变化返回 412，Run 不存在返回 404，非法请求返回 400。
- [x] `API-0714` 内部错误响应带 request ID 和固定错误码，不向客户端暴露原始绝对路径/命令 stderr。
- [x] `API-0715` `workerNames` 仅在迁移窗口兼容，并在服务端解析为唯一 workerId；有歧义时拒绝。
- [x] `API-0716` Apply 结果返回实际应用文件、Worker、transaction ID 和最终 Run 版本。

## Diff API TODO

- [x] `API-0720` 提供按 `runId + workerId` 获取 Diff 摘要的 GET endpoint。
- [x] `API-0721` patch 正文按需流式返回，设置文本 MIME、下载文件名和 `Cache-Control: no-store`。
- [x] `API-0722` 对 patch 大小设置响应上限；超限时只允许下载 artifact，不把全文塞入 Run JSON。
- [x] `API-0723` 文件列表由 capture 的结构化 changedFiles 提供，不重新解析展示字符串。
- [x] `API-0724` 二进制文件只返回类型和大小，不尝试文本预览。新 capture 持久化 Git blob 旧/新侧精确大小；旧 capture 缺少元数据时明确返回 `null`，不猜测数值。
- [x] `API-0725` endpoint 在读取前重新校验 artifact 路径位于受管目录且 digest 正确。

## Discard API TODO

- [x] `API-0730` 新增 preview 模式，返回会删除的 Worktree、patch 和 Session 能力，不执行删除。
- [x] `API-0731` commit 模式要求确认 token 与 preview 的 manifest digest 匹配。
- [x] `API-0732` manifest 已变化时 token 失效并要求重新确认。
- [x] `API-0733` 未捕获 dirty Worktree 使用单独风险码和二次确认。
- [x] `API-0734` 返回逐 Worker cleanup 结果；partial cleanup 不能表示为整体成功。

## SSE 事件 TODO

- [x] `API-0740` 新增 `worker_capture_started/completed/error`。
- [x] `API-0741` 新增 `patch_apply_checked/committed/recovery_required`。
- [x] `API-0742` 新增 `worktree_preserved/cleanup_completed/cleanup_error`。
- [x] `API-0743` 事件只带 runId、workerId、transactionId、固定状态、数量和原因码。
- [x] `API-0744` 保留现有 `patch_apply_started/applied/error`，在迁移期同时发出兼容事件。
- [x] `API-0745` 不修改压缩事件兼容逻辑和全局 SSE 游标语义。

## 脱敏 TODO

- [x] `API-0750` 扩展 `collaboration-sanitize.ts`，移除 manifestPath、patchPath、worktreePath、gitCommonDir、sessionId。
- [x] `API-0751` 对错误文本做 allowlist 投影，避免 Git stderr 带出路径和 ref。
- [x] `API-0752` 为 GET Run、SSE snapshot、Resume 和 Diff endpoint 分别写脱敏测试。

## 验收标准

- [x] 客户端可区分“无变更、冲突、失败、需恢复、已应用”。
- [x] 同一 Apply 请求重试不会重复修改工作区。
- [x] 所有环境式 Run/SSE 快照继续满足内部路径和 Worker Session 脱敏要求；仅用户主动点击 Worker 卡片时，通过定向解析接口返回对应 Session ID 用于导航。
