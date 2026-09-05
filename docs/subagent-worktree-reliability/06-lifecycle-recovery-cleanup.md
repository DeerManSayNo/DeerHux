# 06 生命周期、重启恢复与清理

## 目标

用 manifest、进程所有权和实时 Git 事实决定清理资格，替换启动时删除所有临时 Run 目录的行为。

## 涉及文件

- `lib/parallel-agent/worktree.ts`
- `lib/parallel-agent/subagent-persistence.ts`
- `lib/parallel-agent/collaboration-orchestrator.ts`
- `instrumentation-node.ts`
- 新增 `lib/parallel-agent/worktree-reconciler.ts`

## 生命周期 TODO

- [x] `LIF-0601` 明确 Run、Worker、Worktree、patch、Session 各自生命周期和所有者。
- [x] `LIF-0602` Continue TTL 与 cleanup eligibility 使用同一来源计算，禁止分别硬编码。
- [x] `LIF-0603` Worker 运行中、可 Continue、capture 失败、Apply 失败时默认保留 Worktree。
- [x] `LIF-0604` Apply 成功后可删除 Worktree，但 patch 按审计保留期保存。
- [x] `LIF-0605` Discard 必须显式确认；有未捕获变化时使用更高级别确认。
- [x] `LIF-0606` 超过 Continue TTL 只改变继续资格，不自动证明成果可删除。

## 实例所有权 TODO

- [x] `LIF-0610` 每个 Node 进程生成 `instanceId` 和进程启动标识。
- [x] `LIF-0611` Run manifest 记录 owner PID、instanceId、heartbeatAt 和 active operation。
- [x] `LIF-0612` 活跃 Run 定期刷新有界 heartbeat；终态停止刷新。
- [x] `LIF-0613` 判断进程存活时同时验证 PID 和启动标识，规避 PID 复用。
- [x] `LIF-0614` 另一个实例拥有且仍活跃的 Run 永远不可清理。
- [x] `LIF-0615` heartbeat stale 仅表示“需协调”，不能单独授权删除。

## 启动恢复 TODO

- [x] `LIF-0620` 从 `instrumentation-node.ts` 移除/停用无条件 `cleanupOrphanedRuns()` 删除逻辑。
- [x] `LIF-0621` 启动时只扫描合法 manifest，不把未知目录视为可删除资源。
- [x] `LIF-0622` 对每个 manifest 核对 repo identity、Git worktree list、路径归属、branch、HEAD 和 dirty 状态。
- [x] `LIF-0623` 将进程中断且 Worktree 存在的 Run 恢复为 `recoverable`。
- [x] `LIF-0624` Worktree 缺失但有效 patch 存在时恢复为 `captured`，允许 Apply，不允许 Continue。
- [x] `LIF-0625` Worktree 和 patch 都缺失时标记 `recovery_failed`，保留诊断证据。
- [x] `LIF-0626` manifest 为 applying 时读取 transaction journal，判断已应用、未应用或需人工恢复。
- [x] `LIF-0627` 启动恢复不得创建 `AgentSessionWrapper`；Resume 时才按既有 JSONL 路径重开。

## 清理资格 TODO

- [x] `LIF-0630` 实现纯函数 `planCleanup(manifest, gitFacts, now)`，返回逐 Worker决策和原因。
- [x] `LIF-0631` 自动清理仅允许：无变化；已完整 Apply；已明确 Discard；有效 patch 已持久化且产品策略明确允许移除。
- [x] `LIF-0632` dirty Worktree 无有效 patch 时必须 preserved。
- [x] `LIF-0633` branch 相对 baseCommit 有提交且无有效 patch 时必须 preserved。
- [x] `LIF-0634` 路径、branch、repo identity 任一不匹配时必须 preserved。
- [x] `LIF-0635` 删除 Worktree 后再删除对应分支；任一步失败均记录 partial cleanup。
- [x] `LIF-0636` 只有该 Run 所有资源已结算才删除 Run 目录。
- [x] `LIF-0637` 对 manifest 中涉及的每个仓库分别执行 `git worktree prune`，不使用 `process.cwd()` 替代。
- [x] `LIF-0638` prune 前获取对应 repo 锁。

## Continue TODO

- [x] `LIF-0640` Continue 前验证 Worktree、agentCwd、Session JSONL、baseCommit 和未 Applied 状态。
- [x] `LIF-0641` Continue 期间续租 manifest，防止并发 cleanup。
- [x] `LIF-0642` Continue 与 Apply/Discard 使用互斥状态转换。
- [x] `LIF-0643` Continue 完成后重新捕获 patch，旧 patch 保留到新 patch 原子落盘。
- [x] `LIF-0644` Continue 失败时恢复为可重试或 preserved，不删除旧成果。

## 测试 TODO

- [ ] `LIF-0650` 正常重启、SIGTERM、SIGKILL、崩溃、机器休眠后恢复测试。正常重启、实际 SIGTERM/SIGKILL 与三个 setup 崩溃窗口已自动化通过；机器休眠仍需人工验收。
- [x] `LIF-0651` 两个 DeerHux 实例共享临时目录，一个实例启动不得删除另一个实例资源。
- [x] `LIF-0652` 两个不同项目仓库残留 Worktree，分别 prune 正确 common dir。
- [x] `LIF-0653` Continue TTL 前后、patch 有无、dirty/clean、branch ahead 的清理决策表测试。
- [x] `LIF-0654` symlink 替换 Run 目录和篡改 manifest 的 fail-closed 测试。

## 验收标准

- [x] 应用重启后，两小时内的可 Continue Run 仍可继续。
- [x] 未应用成果不会因进程重启或另一个实例启动而消失。
- [x] 清理计划对每个保留/删除决定都给出稳定原因码。
