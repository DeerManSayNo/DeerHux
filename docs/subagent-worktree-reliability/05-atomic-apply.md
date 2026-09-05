# 05 原子 Apply 与文件选择

## 目标

一次 Apply 请求只有两种可观察结果：全部选中变更成功落地，或主工作区和索引保持调用前状态。

## 涉及文件

- `lib/parallel-agent/worktree.ts`
- `lib/parallel-agent/collaboration-orchestrator.ts`
- `lib/parallel-agent/collaboration-types.ts`
- `app/api/agent-runs/[runId]/apply/route.ts`

## 请求校验 TODO

- [x] `APL-0501` API 接受 `workerIds`，逐步淘汰 `workerNames`；过渡期禁止两者同时出现。
- [x] `APL-0502` 拒绝空 Worker 数组、重复 Worker ID、未知 Worker、未完成 Worker 和无 capture Worker。
- [x] `APL-0503` 对 `files` 做仓库相对路径规范化，拒绝绝对路径、空字符串、`.`、`..` 和越界路径。
- [x] `APL-0504` 文件选择必须是所选 Worker changedFiles 的非空子集。
- [x] `APL-0505` 指定文件没有任何 patch 内容时返回 `no_changes_selected`，不得返回成功。
- [x] `APL-0506` 主仓库必须处于允许状态；默认要求 HEAD、index、worktree 全部干净。
- [x] `APL-0507` 核对当前 repo identity 与 manifest 一致。
- [x] `APL-0508` 核对 patch digest 与 manifest 一致。
- [x] `APL-0509` Run 已 Applied 时按 transaction/idempotency key 返回已有结果，不重复修改文件。

## 预组合事务 TODO

- [x] `APL-0510` 获取仓库级跨进程 Apply 锁，并在锁内重新执行全部前置检查。
- [x] `APL-0511` 创建临时 Git index，初始化为主仓库当前 HEAD 的树。
- [x] `APL-0512` 按明确 Worker 顺序将过滤后的 patch 逐个应用到临时 index。
- [x] `APL-0513` 第二个及后续 patch 必须基于前一个 patch 的临时结果检查，捕获 Worker 间冲突。
- [x] `APL-0514` 过滤文件时使用 Git pathspec/结构化 patch 能力，不使用易错的文本段落切割。
- [x] `APL-0515` 从临时 index 生成单个 `--binary --full-index` 合并 patch。
- [x] `APL-0516` 合并 patch 为空时结束为 `no_changes`，不清理 Run。
- [x] `APL-0517` 对主工作区执行最终 `git apply --check --index`。

## 提交与回滚 TODO

- [x] `APL-0520` Apply transaction 在任何文件变化前持久化为 `prepared`。
- [x] `APL-0521` 使用一次 Git apply 调用应用合并 patch，不逐 Worker修改主工作区。
- [x] `APL-0522` Apply 后读取实际 changed files 并与预期集合比较。
- [x] `APL-0523` 只有文件校验和 transaction 持久化均成功后，Run 才转为 `applied`。
- [x] `APL-0524` Git apply 失败时记录冲突文件和错误码，Run 返回 `complete/captured` 可重试态。
- [x] `APL-0525` 若出现“文件已变但结果未持久化”的异常窗口，启动恢复必须检测 transaction journal，禁止盲目重试。
- [x] `APL-0526` 不使用 `git reset --hard` 回滚用户数据；回滚只能针对锁内确认由本 transaction 引入的变化。
- [x] `APL-0527` transaction 无法安全判定时标记 `manual_recovery_required`。

## 状态与结果 TODO

- [x] `APL-0530` 定义结果枚举：`applied | no_changes | conflict | precondition_failed | error | recovery_required`。
- [x] `APL-0531` `success` 仅在 `applied` 时为 true；`no_changes` 必须单独表达。
- [x] `APL-0532` 返回实际 applied Worker ID 和文件，不复制请求数组充当结果。
- [x] `APL-0533` 事件增加 transaction ID、阶段和固定错误码，不发送 patch 正文。
- [x] `APL-0534` Apply 失败后 `canContinue` 和 `canApply` 根据 Worktree/capture 实际状态重算。

## 测试 TODO

- [x] `APL-0540` 两 Worker修改同一行：整体冲突且主仓库零变化。
- [x] `APL-0541` 两 Worker修改不同文件：一次性全部应用。
- [x] `APL-0542` 同文件不相交 hunk、重命名冲突、删除/修改冲突测试。
- [x] `APL-0543` 二进制与文本混合、多 Worker混合测试。
- [x] `APL-0544` 空选择、未知文件、重复文件、路径越界测试。
- [x] `APL-0545` 两个客户端并发 Apply 同一 Run 和不同 Run 到同一 repo。
- [x] `APL-0546` 在 prepared、checked、applied、persisted 四个阶段注入崩溃并验证恢复。

## 验收标准

- [x] 任意失败响应后，主仓库 HEAD、index 和工作树与请求前完全一致，或明确返回 recovery_required。
- [x] 不存在“前一个 Worker 已应用、后一个失败但整体 success=false”的状态。
- [x] 空选择永远不会触发 Run 清理。
