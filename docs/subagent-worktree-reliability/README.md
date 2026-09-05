# Subagent Worktree 可靠性研发计划

> 状态：首版代码改造完成，WP0–WP11 的 P0/P1 章节开发、独立审查和自动化验收已通过；WP12 发布控制代码已落地，尚未灰度或发布。范围只覆盖 `isolated_coding` 的创建、执行、Diff、Apply、Continue、Discard、清理和界面闭环。生产 Agent Loop 仍由 `DeerLoopEngine` 持有。各工作包的验证记录以执行看板和 16 验证记录为准，延后的 P2、长期/人工/发布门禁不视为完成。

## 文档导航

| 文件 | 模块 | 优先级 |
|---|---|---|
| [00-execution-board.md](./00-execution-board.md) | 里程碑、依赖、排期和责任边界 | 总控 |
| [01-contracts-and-state.md](./01-contracts-and-state.md) | 契约、状态机、持久化模型 | P0 |
| [02-git-command-layer.md](./02-git-command-layer.md) | Git 命令执行层与仓库身份 | P0 |
| [03-worktree-setup.md](./03-worktree-setup.md) | Worktree 创建、基线、回滚 | P0 |
| [04-diff-and-artifacts.md](./04-diff-and-artifacts.md) | Diff、二进制、未跟踪文件、Artifact | P0 |
| [05-atomic-apply.md](./05-atomic-apply.md) | 选择校验与原子 Apply | P0 |
| [06-lifecycle-recovery-cleanup.md](./06-lifecycle-recovery-cleanup.md) | Continue、重启恢复、清理 | P0 |
| [07-store-and-api.md](./07-store-and-api.md) | Store、API、事件兼容 | P1 |
| [08-frontend-workflow.md](./08-frontend-workflow.md) | Diff 审阅、Apply、Discard UI | P1 |
| [09-dependencies-and-environment.md](./09-dependencies-and-environment.md) | ignored 环境和依赖策略 | P1 |
| [10-security-boundary.md](./10-security-boundary.md) | 执行边界和风险声明 | P1/P2 |
| [11-observability.md](./11-observability.md) | 指标、日志、诊断 | P1 |
| [12-test-matrix.md](./12-test-matrix.md) | 单元、集成、故障注入、E2E | P0-P2 |
| [13-migration-and-release.md](./13-migration-and-release.md) | 迁移、灰度、发布、回滚 | P0-P2 |
| [14-open-decisions-and-risks.md](./14-open-decisions-and-risks.md) | 待决策项、风险和停止条件 | 总控 |
| [16-validation-record.md](./16-validation-record.md) | 本地行为验证、压力数据与未完成发布门禁 | 验收 |

## 不变量

- 未确认存在可恢复成果前，不删除 dirty Worktree 或有分叉提交的临时分支。
- Apply 返回失败时，主工作区内容和索引必须与调用前完全一致。
- Worktree 的 Diff 永远相对创建时固化的 `baseCommit`，不得相对 Worker 当前 `HEAD`。
- 未跟踪文件和 Git 可表达的二进制文件必须进入 patch。
- 运行身份使用 `runId + workerId`；Worker 名称不是主键。
- 默认拒绝 dirty 源仓库；允许 dirty 的实验路径不得进入默认产品链路。
- Session 浏览继续由 `lib/session-reader.ts` 直接读取 JSONL，不创建运行时 Wrapper。
- 不改变 SSE 对新旧压缩事件名的兼容处理。

## 阶段门禁

### Phase 0：冻结危险行为

- [x] `REL-0001` 为旧 Apply 路径加临时保护：二进制、空选择、多 Worker 请求直接拒绝，直到原子 Apply 上线。
- [x] `REL-0002` 停止启动时无条件删除 `/tmp/deerhux-runs`。
- [x] `REL-0003` 为所有新增字段设计向后兼容读取默认值。

### Phase 1：P0 数据安全闭环

- [ ] `REL-0010` 完成 01 至 06 模块全部 P0 TODO。
- [x] `REL-0011` 完成 12 模块的 P0 自动化测试。
- [x] `REL-0012` 通过故障注入证明：创建、捕获、Apply、持久化任一步失败均不丢成果。

### Phase 2：产品闭环

- [x] `REL-0020` 完成 API 和前端 Apply/Discard 流程。
- [x] `REL-0021` 为 Continue、过期和恢复状态提供明确操作入口。
- [x] `REL-0022` 接入固定维度诊断指标。

### Phase 3：环境与安全强化

- [x] `REL-0030` 落地首版 `none + trusted hook` 依赖准备策略，不自动引入可写共享 `node_modules`；isolated-install 延后。
- [x] `REL-0031` 明确 Worktree 与进程沙箱的边界、环境模式与独立 ADR；OS sandbox/network policy 延后。
- [ ] `REL-0032` 完成长时间运行、双实例和进程崩溃测试。

## 审查发现映射

| 原问题 | 任务文件 |
|---|---|
| 新文件丢失、Worker commit 后 Diff 为空、二进制失败 | 04 |
| 空选择误报成功、多 Worker部分应用 | 05 |
| 重启破坏 Continue、跨实例误删、跨仓库 Git 元数据 | 06 |
| 重复名称覆盖、创建中途泄漏、dirty 源工作区 | 01、03 |
| Shell 拼接和同步 Git 命令 | 02 |
| Worktree 不是安全边界 | 10 |
| ignored 依赖和环境缺失 | 09 |
| 前端没有 Apply 入口 | 08 |
| 自动化测试缺口 | 12 |

## 全局完成定义

- [x] 每个状态转换都由集中式 Store/manifest transition 负责，并先持久化意图、后执行不可逆动作。
- [x] 每个危险操作都有事务/确认身份、前置条件、结构化结果和可审计事件；Apply 另使用幂等键。
- [x] 所有受管 Git/artifact/环境路径均经过仓库或受管根相对解析和越界检查。
- [x] 默认 Run/SSE API 不返回 `sessionId`、`worktreePath`、主机绝对路径或内联 patch 正文；用户显式审阅时仅由受控 Diff endpoint 校验并读取对应 artifact。
- [x] `node_modules/.bin/tsc --noEmit` 通过。
- [x] `npm run lint` 通过（0 error、36 条既有 warning）；开发阶段未执行 `next build`。
- [x] P0/P1 测试矩阵全部通过，`git diff --check` 无错误。
- [x] 独立对抗性审查没有未处理的 P0/P1 发现。
