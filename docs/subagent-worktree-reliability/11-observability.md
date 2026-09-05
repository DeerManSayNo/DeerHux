# 11 可观测性与运行诊断

## 目标

让创建、捕获、Apply、Continue 和清理失败可解释，同时控制指标维度和敏感信息。

## V1 实现与读取方式（2026-09-05）

`GET /api/runtime/diagnostics` 新增 `worktrees.metrics` 和 `worktrees.inventory`。metrics 是当前进程内固定维度计数与最多 200 条结构化事件；没有按 runId、workerId、cwd、文件名建立永久指标维度。事件可携带校验后的 Run/Worker/事务 ID，但仓库只以进程盐匿名摘要出现，原始路径、Prompt、工具参数、patch 和 Git stderr 不进入这些字段。

setup、capture、Apply、Continue、Discard preview/commit、cleanup plan/execute 已接入。Apply 真正 check 后记录 checkpoint，幂等重放不伪造新 check；每次调用仍计入一次终态，因此 `applied` 是成功调用数（含重放），不是唯一 Git 提交数。捕获记录 patch 字节/二进制/文件数和保留数量，setup 失败会读取有界 manifest 的保留声明。操作返回进程生命周期成功率；时长除 count/total/max 外，还基于每类最多 200 个终态样本返回 recent P95。Counter 与样本随进程重启重置，不声称持久化历史监控。

inventory 只读取通过 schema 校验的 manifest 声明，不访问 patch 或 Session JSONL，不启动 Git，不执行恢复/清理。异步最多扫描 256 项，每个 manifest 最多 1 MiB，总读取最多 16 MiB；超过阈值明确返回 `truncated`/`oversizedManifests`。管理路径通用 manifest 读写上限为 8 MiB，超过 inventory 小上限的有效大 manifest 只是未计入本次盘点，不能据此判定损坏。权限、symlink、固定 FD 和读取前后变化均验证。

`managedWorktrees`、`activeWorktrees`、`preservedWorktrees`、pending/recoverable/manual 数及最老年龄均为声明统计；`patchDeclaredBytes` 不是实测磁盘占用。默认告警阈值为最老未结算 Run 7 天、声明 patch 1 GiB、保留 Worktree 32 个，超过只提示，不自动删除。

只读命令：

```bash
npm run --silent inspect:worktrees -- --json
npm run --silent inspect:worktrees -- --runs-root /absolute/managed/runs --git --json
```

不加 `--git` 只返回 inventory，实时对账数量为 `null`。显式 `--git` 最多 32 个 Run / 128 个 Worker / 256 个候选目录项，30 秒软截止，每条同步 Git 命令另有 10 秒上限（软截止不保证立即打断当前事实读取）。它不读 patch 正文，只读取受限 metadata；不调用 `status/add/apply/write-tree`、reconciler 或 cleanup execute，计划固定 `retain`。输出 orphan（没有观察到 Worktree/registration/branch）、missing Worktree、已证实的 untracked 未捕获变化、stale transaction 和 content-unverified 数量。无法验证的 tracked 内容不会被报告成 clean，零 untracked 也不表示没有源码变化。

这些诊断不会修改 Worktree、index、refs、Git config、manifest 或 Run 状态。reset 入口仅允许测试运行时，production 显式拒绝。`npm run test:worktree-observability` 覆盖模块、inventory、独立安全 HTTP 红队、真实创建/capture/二进制/Apply 重放/partial Discard 接线，以及 CLI 无副作用和截断测试，已加入 core 前置门禁。

## 涉及文件

- `lib/parallel-agent/collaboration-store.ts`
- `lib/parallel-agent/worktree.ts`
- `app/api/runtime/diagnostics/route.ts`
- 可新增 `lib/parallel-agent/worktree-diagnostics.ts`

## 指标模型 TODO

- [x] `OBS-1101` 定义只增 Counter：setup started/completed/failed。
- [x] `OBS-1102` 定义 capture completed/empty/failed、binary patch 和 preserved Counter。
- [x] `OBS-1103` 定义 Apply checked/applied/conflicted/precondition-failed/recovery-required Counter。
- [x] `OBS-1104` 定义 cleanup planned/removed/preserved/partial/failed Counter。
- [x] `OBS-1105` 定义 Gauge：active Worktrees、preserved Worktrees、pending Apply transactions。
- [x] `OBS-1106` 定义 Max/Total：setup、capture、Apply、cleanup 时长和 patch 字节。
- [x] `OBS-1107` reason 维度使用固定枚举；禁止按 runId、workerId、cwd、文件名建立永久 Map。

## 结构化日志 TODO

- [x] `OBS-1110` 为每个操作生成 operationId，并串联 runId、workerId、transactionId。
- [x] `OBS-1111` 日志只记录仓库匿名摘要，不记录绝对路径和 patch 内容。
- [x] `OBS-1112` Git 错误映射固定错误码，原始 stderr 仅进入受限本地诊断。
- [x] `OBS-1113` 对 preserved 状态记录具体原因：dirty uncaptured、manifest invalid、owner active、digest mismatch 等。
- [x] `OBS-1114` 对恢复决策记录输入事实摘要和计划结果，便于解释为何未清理。
- [x] `OBS-1115` 成功清理记录 Worktree 和 branch 两个独立结果。

## 诊断 API TODO

- [x] `OBS-1120` 扩展 runtime diagnostics，返回固定字段快照和当前阈值。
- [x] `OBS-1121` 不遍历 patch 正文或 Session JSONL；诊断读取必须是常数级/有界扫描。
- [x] `OBS-1122` 提供受管 Run 数、可恢复数、需人工处理数和最老年龄。
- [x] `OBS-1123` 多仓库统计只提供总数，不公开仓库路径。
- [x] `OBS-1124` 增加测试重置入口，仅在测试环境可用。

## 运维检查 TODO

- [x] `OBS-1130` 编写脚本输出 manifest/Git worktree 对账摘要，默认只读。
- [x] `OBS-1131` 脚本列出 orphan manifest、missing Worktree、uncaptured dirty 和 stale transaction 数量。
- [x] `OBS-1132` cleanup plan 以 JSON 和人类可读格式输出，不自动执行删除。
- [x] `OBS-1133` 为磁盘占用设置告警阈值，但达到阈值时仍不得删除未确认成果。

## 验收标准

- [x] 每个 preserved/recovery_required 状态都能从诊断中找到稳定原因。
- [x] 指标基数有界且不暴露路径、文件名、Prompt 或工具参数。
- [x] 诊断路径不改变任何 Worktree、Git ref 或 Run 状态。
