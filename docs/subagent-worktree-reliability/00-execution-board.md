# 00 执行看板与里程碑

## 估算口径

- 单位是 1 名熟悉 TypeScript/Node/Git 的工程师日，只用于相对排期。
- 估算包含模块内单元测试，不包含最终跨模块 E2E 和独立审查。
- P0 建议 2 名工程师结对处理 Git 数据安全路径；Apply 与 cleanup 不应由互不沟通的两条分支同时修改状态机。
- 每个工作包必须独立提交、独立验证，不在一个提交中混入格式化或无关重构。

## 依赖图

```text
WP0 临时保护
  -> WP1 契约/Manifest
      -> WP2 Git 执行层
          -> WP3 创建事务
          -> WP4 Diff/Artifact
              -> WP5 原子 Apply
              -> WP6 恢复/清理
                  -> WP7 Store/API
                      -> WP8 前端闭环
WP3 -> WP9 环境准备
WP1..WP7 -> WP10 安全/观测
所有工作包 -> WP11 E2E/故障注入 -> WP12 灰度发布
```

## WP0：危险行为临时保护，0.5-1 人日

- [x] `BRD-0001` 在旧 Apply 入口识别空选择并返回非成功结果。
- [x] `BRD-0002` 临时拒绝包含二进制文件的 Apply，并保留 Worktree。
- [x] `BRD-0003` 临时拒绝一次请求应用多个 Worker。
- [x] `BRD-0004` 停用启动时无条件删除 Run 目录，改为只记录待协调数量。
- [x] `BRD-0005` 补最小回归测试，证明保护逻辑不会清理成果。

审查记录：WP0 经六轮独立数据安全审查，于 2026-09-04 清零本章 P0/P1 findings；专项测试、TypeScript 类型检查和 `git diff --check` 通过。

**退出条件**：已知 P0 路径无法继续静默丢数据；允许功能暂时受限。

## WP1：契约和 Manifest，2-3 人日

- [x] `BRD-0010` 完成 `CON-0101` 至 `CON-0126`。
- [x] `BRD-0011` 确认状态转换表并冻结 V1 字段命名。
- [x] `BRD-0012` 合入原子写、schema 校验和旧快照兼容测试。
- [x] `BRD-0013` 独立 reviewer 检查所有删除授权是否有持久事实支撑。

审查记录：WP1 经六轮独立契约与持久化审查，于 2026-09-04 清零本章 P0/P1 findings；manifest、setup、兼容专项测试及 TypeScript 类型检查通过。

**退出条件**：创建前可写 pending manifest；损坏/缺失 manifest 时 fail-closed。

## WP2：Git 执行层，2-3 人日

- [x] `BRD-0020` 完成 `GIT-0201` 至 `GIT-0233`。
- [x] `BRD-0021` 迁移 repo identity、status 和 base ref 读取调用方。
- [x] `BRD-0022` 暂不迁移 Apply，先让新旧路径共用稳定 Git 错误类型。

审查记录：WP2 经六轮独立 Git 与锁专项审查，于 2026-09-04 清零本章 P0/P1 findings；Git process、repository、双进程锁测试及 TypeScript 类型检查通过。

**退出条件**：Worktree 主链路没有 shell 字符串 Git 命令；仓库身份可稳定比较。

## WP3：Worktree 创建事务，2-4 人日

- [x] `BRD-0030` 完成 `SET-0301` 至 `SET-0344`。
- [x] `BRD-0031` 将 orchestrator 映射切换为 workerId/index。
- [x] `BRD-0032` 执行逐步骤失败注入，确认无不可达 Worktree。

审查记录：WP3 经五轮独立事务与故障审查，于 2026-09-04 清零本章 P0/P1 findings；创建、回滚、身份与故障矩阵测试及 TypeScript 类型检查通过。

**退出条件**：所有 Worker使用同一 baseCommit；中途失败可完整回滚或留下可恢复 manifest。

## WP4：Diff 与 Artifact，3-4 人日

- [x] `BRD-0040` 完成 `DIF-0401` 至 `DIF-0445`。
- [x] `BRD-0041` 用 tree digest 证明 patch 覆盖文本、新文件、提交和二进制。
- [x] `BRD-0042` 将大 patch 从 Collaboration snapshot 正文迁为 artifact 引用。

审查记录：WP4 经六轮独立 Artifact 与生命周期审查，于 2026-09-04 清零本章 P0/P1 findings；完整树、二进制、大 patch、并发与故障测试及 TypeScript 类型检查通过。

**退出条件**：patch 可从 baseCommit 重建 Worker 最终 Git 树；失败时 Worktree 保留。

## WP5：原子 Apply，4-6 人日

- [x] `BRD-0050` 完成 `APL-0501` 至 `APL-0546`。
- [x] `BRD-0051` 先支持 clean 主仓库，不在本阶段设计 dirty 主仓库 merge。
- [x] `BRD-0052` 对临时 index 预组合算法做独立 Git 专项审查。
- [x] `BRD-0053` 证明多 Worker冲突时主仓库 tree/index/status 零变化。

审查记录：WP5 经九轮独立 Git 事务、恢复与 API 审查，于 2026-09-04 清零本章 P0/P1 findings；原子组合、并发、故障阶段和真实进程崩溃测试及 TypeScript 类型检查通过。

**退出条件**：Apply 具有事务 ID、幂等语义和明确结果枚举。

## WP6：Continue、恢复和清理，4-6 人日

- [x] `BRD-0060` 完成 `LIF-0601` 至 `LIF-0654` 的生产安全闭环；物理 Discard 授权留到 WP7 confirmation token。
- [x] `BRD-0061` 替换 instrumentation 启动清理为只协调 reconciler。
- [x] `BRD-0062` 执行跨实例租约、进程身份、崩溃 journal 与跨仓库恢复测试。

审查记录：WP6 经多轮恢复、清理与故障注入审查，于 2026-09-05 清零本章 P0/P1 findings。自动 reconciler 对任何仍存在/注册的 Worktree fail-closed 保留，只清理 Worktree 已缺失且无成果的空分支；Continue strict binding、重新 capture、旧 artifact 保留、失败后重试及启动 journal 恢复均通过专项测试、TypeScript 类型检查和 `git diff --check`。

**退出条件**：重启不会破坏 TTL 内 Continue；自动删除均有新鲜 Git 事实授权。

## WP7：Store 与 API，2-4 人日

- [x] `BRD-0070` 完成 `API-0701` 至 `API-0752` 的安全基线；新 capture 提供经 immutable Git tree 验证的逐文件类型、旧/新 blob 字节数和文本行统计，旧 capture 缺字段时保持未知；完整物理 Discard 受下述保留限制约束。
- [x] `BRD-0071` 发布兼容事件和 workerNames 迁移窗口。
- [x] `BRD-0072` 冻结 Apply/Discard/Diff API contract 并生成真实 Git 测试 fixture。

审查记录：WP7 于 2026-09-05 完成实现与独立交叉复审，已发现 P0/P1 清零。新增真实 Git 回归覆盖 capture 中 Abort、setup/final snapshot 落盘失败、Apply manifest/journal 双写崩溃窗口、持续落盘失败、用户后续 commit/edit 后幂等重试、超限 artifact 与重建资源；末次元数据审查另覆盖 rename/typechange/空文件/二进制旧新大小、旧 manifest 兼容与出站脱敏。核心全集、末次受影响专项、TypeScript、lint（0 错误、36 条既有警告）及 `git diff --check` 通过。现存 Worktree 和既有 patch 保守保留，partial cleanup 不返回整体成功；同步 Git 对账/全 Run 扫描是已记录 P2 性能限制。详见 07 当前实现与客户端契约。

**退出条件**：HTTP/SSE/Store 对同一事务给出一致状态，且无内部路径泄漏。

## WP8：前端产品闭环，3-5 人日

- [x] `BRD-0080` 完成 `UI-0801` 至 `UI-0854` 的交互闭环；新 capture 展示精细文件类型、旧/新 blob 大小与增删行，旧 capture 明确显示未知。
- [x] `BRD-0081` Run 级全量审阅/Apply 与部分文件选择已实现并验收；生产能力开关与分阶段开放留给 WP12，不视为已经发布。
- [x] `BRD-0082` 完成桌面/390px 移动/浅色截图和键盘操作验收。

审查记录：WP8 于 2026-09-05 完成实现、独立浏览器与代码交叉验收，已发现 P0/P1 清零。修复提交中 Escape 关闭、重开多 Worker 后全选遗漏、同版本 capture 覆盖、局域网 HTTP 随机键兼容、未知 5xx 保留原请求等边界。客户端专项、Mux 契约、TypeScript、lint（0 错误、36 条既有警告）、真实 Chromium/CDP 全交互和 `git diff --check` 通过。浏览器使用实际组件与 Mock HTTP，不声称跨浏览器/线上端到端已验证；没有运行 Next build。截图由主 agent 亲自核验。

**退出条件**：用户能在协作卡片完成审阅、Apply、Continue 和 Discard。

## WP9：依赖环境，2-4 人日

- [x] `BRD-0090` 完成 `ENV-0901` 至 `ENV-0944` 的 V1 `none + hook` 基线；自动 isolated-install、包管理器/网络安装失败与缓存优化明确未交付。
- [x] `BRD-0091` 第一版只交付 `none + hook`；isolated-install 请求固定拒绝，不隐式执行或共享依赖。
- [x] `BRD-0092` 默认不创建可写共享 `node_modules`，真实双 Worker 自有依赖测试确认不修改主项目依赖；不承诺阻止恶意同 UID hook 主动越界。

审查记录：WP9 于 2026-09-05 完成独立安全审查，已发现 P0/P1 清零。移除 synthetic 物理删除，修复 HEAD tracked 后从 index 移除绕过、macOS 大小写路径别名，以及父 hook 退出后残留孙进程继续写入。真实 Git 环境模块/集成/独立红队、Worker Bash 环境继承、旧 setup/manifest/artifact、受影响 API 全组、TypeScript、lint（0 错误、36 条既有警告）和 `git diff --check` 通过。敏感变量过滤不是 OS 沙箱；Windows/Linux 环境行为未在本机冒充验收。

**退出条件**：依赖准备不污染主项目、Diff 或敏感环境。

## WP10：安全与观测，2-4 人日

- [x] `BRD-0100` 完成 `SEC-1001` 至 `SEC-1044` 的 P1 管理安全基线；无独立创建授权的自动清理保留全部现存资源。
- [x] `BRD-0101` 完成 `OBS-1101` 至 `OBS-1133` 的 V1 固定指标、有界声明 inventory 与只读 Git 核对；磁盘占用只提供声明字节告警，不冒充逐目录实际占用。
- [x] `BRD-0102` OS 沙箱明确留为独立 P2 ADR，不阻塞 P0 可靠性验证；未宣称已具备进程或网络隔离。

审查记录：WP10 于 2026-09-05 完成安全、观测、真实操作接线和 CLI 独立审查，已发现 P0/P1 清零。真实红队修复陈旧 plan 改目标分支、整体伪造 repo/common、Discard 缺独立 Store 身份、只读 status 执行 clean filter；新增 manifest/artifact 固定 FD 限额读取与权限/身份检查。metrics/inventory、安全 HTTP 红队、真实 setup/capture/binary/Apply 重放/partial Discard、CLI 无副作用专项通过，TypeScript、lint（0 错误、36 条既有警告）、diff check 通过。CLI 永远 retain；未知 tracked 内容不报告 clean。详见 10/11 与进程隔离 ADR。

**退出条件**：管理端路径安全、风险描述准确、失败可诊断且指标有界。

## WP11：跨模块验证，5-8 人日

- [x] `BRD-0110` 完成 `TST-1201` 至 `TST-1246`。
- [x] `BRD-0111` 逐项运行 16 个历史问题的行为回归；证据映射见 16，不倒推所有旧版本均亲测先红。
- [ ] `BRD-0112` 完成并发、耐久和 Artifact 泄漏测试。
- [x] `BRD-0113` 独立对抗性 reviewer 输出 findings；本轮发现的恢复终态降级 P1 已修，真实先红测试转绿。

**退出条件**：无未解决 P0/P1；失败场景没有静默数据损失。

当前记录：WP11 有界功能/故障/平台审查通过；真实 macOS 与 Linux handler/fresh-Node E2E、三处 setup 进程退出、实际 SIGTERM/SIGKILL、capture 发布窗口、Apply prepared/checked 与 applied 恢复、3,024 项清理矩阵及 Chromium 组件交互已验证。package 中 39 个去重 Worktree 测试脚本接入私有资源退出门禁，曾真实检出并修复 crash child Apply scratch 与 capture index 漏检，独立终审 P0/P1 清零。30 Worker 同/多仓库、109.55 MiB patch 与独立 1000 Run 实测通过；24 小时、机器休眠及完整 HTTP+浏览器/Tauri 验收未完成，故不将 BRD-0112 整组勾完。详细口径见 [16-validation-record.md](./16-validation-record.md)。

## WP12：灰度与收口，3-5 人日

- [ ] `BRD-0120` 完成 `RLS-1301` 至 `RLS-1364`。
- [ ] `BRD-0121` 按 Stage A-E 逐步开放能力，不跨阶段一次全开。
- [ ] `BRD-0122` 默认启用 v2 后观察一个完整保留窗口。
- [ ] `BRD-0123` 删除旧路径前执行 callers/impact 和 legacy Run 使用量检查。

**退出条件**：所有新 Run 进入 v2，旧路径无生产调用，仍保留 v2 人工恢复能力。

代码收口记录：新建开关默认关闭，紧急 Apply 刹车独立；已有 v2 生命周期不降级，format v1 manifest 支持可选 implementationVersion 2 并拒绝未知版本；server capabilities、前端禁用提示和 legacy 元数据只读下载已接线。legacy 冷加载报告使用有界原始 Store snapshot，不触发恢复写入；实际 handler 红队验证关闸零写、旧 key 重放、Diff 下载与 cold legacy 不变。RLS-1311 改为禁新建而非复活旧创建链，安全偏差已明文记录。未执行 PR/发布、Stage A–E、完整保留窗口或一周线上观察，WP12 不标整体完成。

## 总体量级

| 范围 | 估算 |
|---|---:|
| P0 数据安全与恢复底座（WP0-WP6） | 17.5-27 人日 |
| API/UI/环境/安全观测（WP7-WP10） | 9-17 人日 |
| 跨模块验证和发布（WP11-WP12） | 8-13 人日 |
| 合计 | 34.5-57 人日 |

估算上限主要来自崩溃恢复和原子 Apply。若缩减第一版，允许延后 isolated-install、操作系统沙箱和耐久测试扩展，不允许删除二进制、原子性、manifest 或重启恢复任务。
