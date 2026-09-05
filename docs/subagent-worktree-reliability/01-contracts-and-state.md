# 01 契约、状态机与持久化模型

## 目标

先定义可恢复事实，再修改 Git 行为。现有 `CollaborationRunState` 可继续作为运行快照，但 Worktree 生命周期必须有独立、原子写入的 manifest。

## 涉及文件

- `lib/parallel-agent/collaboration-types.ts`
- `lib/parallel-agent/collaboration-store.ts`
- `lib/parallel-agent/subagent-persistence.ts`
- 新增 `lib/parallel-agent/worktree-manifest.ts`

## 数据模型 TODO

- [x] `CON-0101` 定义 `WorktreeManifestV1`，包含 `version`、`runId`、`instanceId`、`repoRoot`、`gitCommonDir`、`sourceCwdRelative`、`baseCommit`、`createdAt`、`updatedAt`、`expiresAt`。
- [x] `CON-0102` 定义 Worker 条目：`workerId`、`displayName`、`index`、`worktreePath`、`agentCwd`、`branch`、`provider`、`state`。
- [x] `CON-0103` 定义 capture 条目：`patchPath`、`patchSha256`、`patchBytes`、`changedFiles`、`binaryFiles`、`capturedAt`、`captureError`。
- [x] `CON-0104` 定义 Apply 条目：`transactionId`、`requestedWorkerIds`、`requestedFiles`、`startedAt`、`finishedAt`、`outcome`、`errorCode`。
- [x] `CON-0105` 定义 cleanup 条目：`intent`、`eligibility`、`checkedAt`、`worktreeRemoved`、`branchRemoved`、`reason`。
- [x] `CON-0106` 将 manifest 状态限定为 `planning | setting_up | running | captured | applying | applied | preserved | discarded | cleanup_error`。
- [x] `CON-0107` 编写状态转换表，逐项列出允许的起点、终点、调用者和持久化时点。
- [x] `CON-0108` 禁止从 `running` 直接转为 `discarded`，除非存在明确确认和 Worker 已终止证明。
- [x] `CON-0109` 禁止从 `captured` 转为清理完成，除非 patch 文件存在、摘要匹配且 manifest 已落盘。

## 身份与唯一性 TODO

- [x] `CON-0110` 将 `workerId` 改为必填稳定 ID，不再允许运行时用名称回退。
- [x] `CON-0111` 在 Planner 输出规范化后校验同一 Run 内 `workerId` 唯一。
- [x] `CON-0112` 对重复显示名称给出 400/规划错误；即使未来允许重复显示，也不得影响内部寻址。
- [x] `CON-0113` 将 `dependsOn` 从名称引用迁移为 `workerId` 引用，保留旧快照读取兼容层。
- [x] `CON-0114` Worktree 数组按 `index` 保存；禁止使用 `Map<displayName, path>` 作为持久事实。
- [x] `CON-0115` Apply、Resume、事件和 UI key 全部使用 `workerId`。

## 原子持久化 TODO

- [x] `CON-0120` 实现同目录临时文件写入、`fsync`、rename 的原子 JSON 写入函数。
- [x] `CON-0121` manifest 首次写入必须发生在第一个 `git worktree add` 之前。
- [x] `CON-0122` 每次不可逆动作前写入 pending 状态，动作完成后写入 settled 状态。
- [x] `CON-0123` 写入失败时停止后续清理，保留 Worktree 并返回可操作错误。
- [x] `CON-0124` 读取时校验版本、必填字段、绝对路径、时间戳和枚举；非法 manifest 只能进入人工处理状态。
- [x] `CON-0125` 对 manifest 设置仅当前用户可读写权限；创建目录时拒绝符号链接。
- [x] `CON-0126` 为 manifest 写入增加注入式失败点，供断电/磁盘满测试使用。

## 快照兼容 TODO

- [x] `CON-0130` 在 `CollaborationRunState` 增加可选 `worktreeManifestPath` 的内部字段，并在脱敏层移除。
- [x] `CON-0131` 增加 `baseCommit`、`captureState`、`applyState` 的可选投影字段，旧 JSON 缺失时安全降级。
- [x] `CON-0132` 旧 Run 没有 manifest 时标为 `legacy_recovery_required`，禁止自动 Apply 和自动清理。
- [x] `CON-0133` 不重写历史 JSONL；迁移只作用于 collaboration snapshot/manifest。
- [x] `CON-0134` 为每个兼容默认值写单元测试，防止旧快照读取崩溃。

## 验收标准

- [x] 任意进程崩溃点之后，都能仅凭 manifest 和 Git 事实判断“可继续、可应用、可清理、需人工处理”。
- [x] 重复名称不会覆盖 Worker、Worktree、Diff、事件或 Apply 结果。
- [x] manifest 损坏、缺失或写入失败时，不执行删除。
