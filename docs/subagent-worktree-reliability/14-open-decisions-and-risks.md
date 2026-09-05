# 14 待决策项与风险登记

## 使用方式

每项决策在实施对应工作包前关闭。关闭时补充决定、日期、依据和接受的剩余风险；没有结论时采用本文件给出的保守默认值。

## 必须在 WP1 前决定

- [x] `DEC-1401` **Artifact 根目录**。2026-09-05：采用 Session 作用域专用受管状态目录（目录 0700、文件 0600）；外部 API 不暴露绝对路径。
- [x] `DEC-1402` **Manifest 与 Collaboration snapshot 的事实优先级**。2026-09-05：manifest 管 Worktree/Git 生命周期，snapshot 管 UI 投影；冲突时禁止删除。
- [x] `DEC-1403` **Worker 显示名称是否允许重复**。2026-09-05：Planner/API 拒绝重复；内部身份、路径和请求只使用 workerId。
- [x] `DEC-1404` **有效 patch 捕获后是否立即删除 Worktree**。2026-09-05：Continue TTL 内保留；自动 reconciler 对仍存在/注册的 Worktree 更保守地要求显式 Discard。
- [x] `DEC-1405` **Patch 审计保留期**。2026-09-05：Apply/Discard 后至少 7 天；旧 manifest 无可靠审计起点或未结算 patch 不按固定时间自动删除。

## 必须在 WP5 前决定

- [x] `DEC-1410` **主仓库 dirty 策略**。2026-09-05：创建和 Apply 都要求 clean；V1 不实现 dirty merge。
- [x] `DEC-1411` **Worker patch 顺序**。2026-09-05：使用请求显式顺序，缺失时按 Worker index；最终顺序写入 transaction。
- [x] `DEC-1412` **部分文件 Apply 后能否继续同一 Worker**。2026-09-05：禁止 Continue；未选成果保留，可在后续独立 Apply 处理中结算。
- [x] `DEC-1413` **Apply 是否写入 Git index**。2026-09-05：预组合使用临时 index；提交阶段以 `git apply --index` 原子落到目标工作树与 index，不替用户 commit。
- [x] `DEC-1414` **HEAD 已前进但工作树干净时是否允许 Apply**。2026-09-05：首版直接拒绝；HEAD 必须仍等于固定 baseCommit，不在请求中隐式 rebase。

## 必须在 WP6 前决定

- [x] `DEC-1420` **Continue TTL**。2026-09-05：统一为 2 小时，由同一常量计算 Continue 与清理资格。
- [x] `DEC-1421` **进程 heartbeat 周期和 stale 阈值**。2026-09-05：周期 15 秒、stale 90 秒；stale 不能单独授权删除。
- [x] `DEC-1422` **自动清理范围**。2026-09-05：无独立授权时不删除仍存在/注册的 Worktree；只有资源已缺失且状态/成果事实满足时结算空分支或 Run。
- [x] `DEC-1423` **旧无 manifest Run 的处理**。2026-09-05：仅生成有界脱敏元数据恢复报告；不自动补写 manifest、基线或删除授权。
- [x] `DEC-1424` **跨进程锁实现**。2026-09-05：自研排他锁文件 + PID/启动标识 + heartbeat/年龄校验，不引入新锁依赖。

## 必须在 WP9 前决定

- [x] `DEC-1430` **默认环境模式**。2026-09-05：采用 `none`；按 WP9 看板第一版只交付 `none + hook`，声明 `isolated-install` 但请求时明确拒绝，不隐式安装依赖。
- [x] `DEC-1431` **项目 setup hook 权限**。2026-09-05：仅用户侧 agent 目录配置按 canonical repoRoot 显式启用仓库 tracked Node 脚本；仓库声明本身不构成授权。验证脚本与 baseCommit 一致，通过 argv/结构化 stdin 执行，有超时、输出上限、AbortSignal。synthetic 仅在 capture 临时 index 排除，不物理删除。与 Worker 一样不具备 OS 沙箱隔离。
- [x] `DEC-1432` **是否支持共享依赖**。2026-09-05：不创建指向主项目的可写依赖 symlink，不自动复制环境文件；未来只读共享方案需单独验证强制只读语义。
- [x] `DEC-1433` **包管理器范围**。2026-09-05：沿用看板 `BRD-0091` 的 V1 范围，暂不自动调用包管理器；可信 hook 可显式准备每个 Worker 自有环境。npm/frozen lockfile 自动安装和缓存优化仍未交付，不以 hook 代替这些验收项。

## 风险登记

| ID | 风险 | 概率 | 影响 | 缓解/停止条件 |
|---|---|---:|---:|---|
| `RSK-01` | 原子 Apply 预组合算法遗漏 rename/binary/mode | 中 | 严重 | tree digest 测试失败即停止灰度 |
| `RSK-02` | manifest 与 snapshot 写入顺序产生矛盾 | 中 | 高 | manifest 优先，矛盾进入 recovery_required |
| `RSK-03` | 外部 Git 操作绕过 DeerHux repo 锁 | 高 | 高 | Apply 锁内重新读取 HEAD/index/status；变化即终止 |
| `RSK-04` | 启动恢复误判其他实例已死 | 低-中 | 严重 | stale 仅触发协调，不直接删除 |
| `RSK-05` | preserved Worktree长期占用磁盘 | 高 | 中 | 指标、告警、显式 cleanup plan；不以自动丢数据换空间 |
| `RSK-06` | patch artifact 泄露源代码 | 中 | 高 | 0600、受管目录、API 脱敏、保留期 |
| `RSK-07` | 依赖安装引入网络/供应链执行 | 中 | 高 | 默认 none；isolated-install 显式开启 |
| `RSK-08` | Worker shell 越过 Worktree修改主仓库 | 高 | 高 | 明示边界、管理端复核；OS 沙箱列为 P2 |
| `RSK-09` | legacy Run 被新 reconciler 误删 | 低 | 严重 | 无 V1 manifest 不自动清理 |
| `RSK-10` | API 兼容期名称映射存在歧义 | 中 | 高 | 歧义直接 400，不猜测 Worker |

## 明确不采用的方案

- [x] `DEC-1440` 不以 Worker 当前 `HEAD` 作为 Diff 基线。
- [x] `DEC-1441` 不通过忽略错误或返回空 patch 推进清理状态。
- [x] `DEC-1442` 不顺序修改主工作区后再尝试补偿回滚多个 Worker patch。
- [x] `DEC-1443` 不使用 `git reset --hard` 恢复 Apply 失败。
- [x] `DEC-1444` 不在启动时按目录年龄批量 `rm -rf` 未知 Run。
- [x] `DEC-1445` 不把显示名称、路径 basename 或 PID 单独作为所有权证明。
- [x] `DEC-1446` 不自动创建指向主项目的可写 `node_modules` symlink。
- [x] `DEC-1447` 不把 Worktree 宣传为恶意代码安全沙箱。

## 发布停止条件

- [x] `DEC-1450` 2026-09-05 接受：任一失败响应后主仓库发生未申明变化，立即停止发布。
- [x] `DEC-1451` 2026-09-05 接受：任一 capture complete patch 无法重建 Worker Git 树，立即停止发布。
- [x] `DEC-1452` 2026-09-05 接受：任一重启流程删除 recoverable/uncaptured Worktree，立即停止发布。
- [x] `DEC-1453` 2026-09-05 接受：任一 API/SSE 泄露内部绝对路径或 Session ID，阻断发布。
- [x] `DEC-1454` 2026-09-05 接受：多实例测试出现跨实例删除或锁所有权错误，阻断发布。
