# 03 Worktree 创建、基线与失败回滚

## 目标

从明确且稳定的基线创建每个 Worker 工作区，并保证创建到任意一步失败都不会产生不可达资源。

## 涉及文件

- `lib/parallel-agent/worktree.ts`
- `lib/parallel-agent/collaboration-orchestrator.ts`
- `lib/parallel-agent/subagent-planner.ts`
- `lib/parallel-agent/subagent-tool.ts`

## 创建前检查 TODO

- [x] `SET-0301` 验证 Worker 数量在单 Run 上限内且数组非空。
- [x] `SET-0302` 验证 `workerId` 唯一、非空、长度有界；显示名称单独校验。
- [x] `SET-0303` 验证目标是 Git 工作树；稳定产品路径移除非 Git 临时复制的隐式降级。
- [x] `SET-0304` 默认执行 NUL 安全的 `git status --porcelain=v1 -z --untracked-files=all`。
- [x] `SET-0305` 源仓库 dirty 时返回具体文件数量和稳定错误码，不回显敏感绝对路径。
- [x] `SET-0306` 移除 `subagent-tool.ts` 固定传入 `allowDirtyWorktree: true` 的行为。
- [x] `SET-0307` 如保留 dirty 实验开关，要求显式配置、API 权限和醒目标记，且禁止自动 Apply。
- [x] `SET-0308` 在任何目录创建前解析并固化 `baseCommit`。

## 路径和命名 TODO

- [x] `SET-0310` 运行目录使用不可猜测的 `runId`，Worker 目录使用 `index-workerId`，不使用显示名称寻址。
- [x] `SET-0311` 路径必须位于专用根目录，拒绝仓库内部、Git common dir 内部和扩展运行目录内部。
- [x] `SET-0312` 对专用根目录、Run 目录和最终 Worktree 路径执行 realpath/symlink 边界检查。
- [x] `SET-0313` 分支命名包含固定 namespace、Run ID 和 Worker index；创建前执行 ref 格式校验。
- [x] `SET-0314` 保存 `agentCwd = worktreePath/sourceCwdRelative`，并验证该目录存在。
- [x] `SET-0315` 禁止名称规范化碰撞影响路径或映射。

## 创建事务 TODO

- [x] `SET-0320` 在创建第一个 Worktree 前写 pending manifest，列出全部计划资源。
- [x] `SET-0321` 每创建一个 Worktree，立即将实际路径、分支和状态写回 manifest。
- [x] `SET-0322` 使用 `git worktree add -b <branch> <path> <baseCommit>`，不依赖调用时变化的 `HEAD`。
- [x] `SET-0323` 创建后核对 Worktree `HEAD === baseCommit`。
- [x] `SET-0324` 创建后核对 Worktree 的 common dir 与源仓库一致。
- [x] `SET-0325` 所有 Worker 成功后再把 Run 从 `setting_up` 转为 `running`。

## 异常回滚 TODO

- [x] `SET-0330` `setupIsolatedWorkspace()` 自身用 try/catch 包围完整创建循环。
- [x] `SET-0331` 记录成功创建顺序，失败后按逆序移除 Worktree 和临时分支。
- [x] `SET-0332` 当前 Worker 创建到一半失败时，也清理其目录和 ref。
- [x] `SET-0333` 回滚失败时保留 manifest，并逐项记录未删除路径/分支和错误。
- [x] `SET-0334` 只有确认全部 Git 注册已移除后才删除 Run 根目录。
- [x] `SET-0335` 回滚不依赖调用方已拿到 `runDir` 返回值。
- [x] `SET-0336` setup hook 若存在，必须在 manifest 中声明其 synthetic paths，并验证不能覆盖 tracked 路径。

## 测试 TODO

- [x] `SET-0340` 第 1、2、最后一个 Worker 创建失败的参数化测试。
- [x] `SET-0341` 分支已存在、路径已存在、磁盘只读、manifest 写失败测试。
- [x] `SET-0342` 重复中文名称、规范化碰撞、超长名称测试。
- [x] `SET-0343` 从仓库子目录启动后，Worker 真实 cwd 保持对应子目录。
- [x] `SET-0344` Worker 创建期间源 `HEAD` 前进，所有 Worker 仍使用同一 `baseCommit`。

## 验收标准

- [x] 创建失败后 `git worktree list --porcelain` 与调用前一致，或 manifest 明确列出待人工处理资源。
- [x] 同一 Run 的所有 Worker 基于同一个已持久化 commit。
- [x] dirty 源仓库默认无法启动 isolated coding。
