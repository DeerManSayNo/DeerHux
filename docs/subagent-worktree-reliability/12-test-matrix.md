# 12 自动化测试矩阵

## 目标

建立真实 Git 仓库驱动的测试层，覆盖数据完整性、原子性、并发和崩溃恢复。静态字符串断言只能补充契约，不能代替 Git 行为测试。

## 测试基础设施 TODO

- [x] `TST-1201` 新增统一临时 Git 仓库 fixture，自动配置 user、初始提交和清理。
- [x] `TST-1202` fixture 暴露 repoRoot、nestedCwd、baseCommit、worktree list 和 tree digest。
- [x] `TST-1203` 提供 tracked/untracked/binary/rename/symlink 文件生成器。
- [x] `TST-1204` 提供 Git 命令失败、文件系统失败、manifest 写失败的注入点。
- [x] `TST-1205` package 中每个 P0/P1 Worktree 测试脚本及直接子进程在私有临时根退出，统一断言无意外 Worktree、branch、锁、capture/apply 临时 index 和非空临时目录；不扫描宿主全局临时目录。
- [x] `TST-1206` 测试清理只删除 fixture 自己创建的路径，禁止扫描全局 `/tmp/deerhux-runs`。

## P0 单元测试 TODO

- [x] `TST-1210` manifest schema、状态转换、原子写和损坏读取。
- [x] `TST-1211` workerId/重复名称/dependsOn 规范化。
- [x] `TST-1212` Git argv 构造和路径边界。
- [x] `TST-1213` NUL status/numstat 解析：空格、换行、Unicode、重命名。
- [x] `TST-1214` cleanup eligibility 决策表全组合（3,024 个不可变决策组合）。
- [x] `TST-1215` Apply 请求校验、空选择和 changedFiles 子集判断。
- [x] `TST-1216` API 错误码和脱敏结果。

## P0 Git 集成测试 TODO

- [x] `TST-1220` clean repo 创建多个 Worker且基线相同。
- [x] `TST-1221` dirty repo 默认拒绝且零资源残留。
- [x] `TST-1222` Worker 新文件、删除、重命名、chmod 和 commit 后完整捕获。
- [x] `TST-1223` 二进制新建/修改/删除后 patch 实际应用并逐字节比较。
- [x] `TST-1224` 大于 10 MB patch 捕获不发生 maxBuffer 错误。
- [x] `TST-1225` 第 N 个 Worktree 创建失败后逆序回滚。
- [x] `TST-1226` capture 任一步失败后 Worktree 和 branch 保留。
- [x] `TST-1227` 多 Worker冲突 Apply 后主仓库 tree/index/status 与调用前一致。
- [x] `TST-1228` 多 Worker无冲突 Apply 后实际文件集合和内容完全匹配。
- [x] `TST-1229` 部分文件选择只应用被选路径，其余成果仍可后续处理。

## 恢复与故障注入 TODO

- [x] `TST-1230` manifest pending 后进程退出，启动恢复不删除资源。
- [x] `TST-1231` Worktree 创建后、Worker 启动前崩溃。
- [x] `TST-1232` Worker 写文件后、capture 前崩溃。
- [x] `TST-1233` patch rename 后、manifest settled 前崩溃。
- [x] `TST-1234` Apply prepared/check/commit/persist 各阶段崩溃。
- [x] `TST-1235` patch 存在但 Worktree 缺失，仍可 Apply 且不可 Continue。
- [x] `TST-1236` Worktree 存在但 patch 缺失，必须 preserved。
- [x] `TST-1237` PID 复用、stale heartbeat 和 stale lock（真实存活 PID 的正确/错误启动身份及新旧锁组合；不以耗尽内核 PID 伪造测试）。
- [x] `TST-1238` 两实例共享目录，互不删除活跃资源。
- [x] `TST-1239` 两仓库资源并存，cleanup/prune 作用于正确 common dir。

## API 与 UI E2E TODO

- [x] `TST-1240` 创建 isolated Run、等待 capture、加载 Diff、选择文件、Apply 成功。
- [x] `TST-1241` 冲突返回 409，UI 保留选择且主工作区不变。
- [x] `TST-1242` Apply 请求响应丢失后按 idempotency key 恢复结果。
- [x] `TST-1243` Continue 后 patch 更新，旧 UI 选择失效。
- [x] `TST-1244` Discard preview、确认 token、manifest 变化后 token 失效。
- [x] `TST-1245` 重启服务后可恢复 Run 仍能 Continue/Apply。
- [x] `TST-1246` 环境式 Run API/SSE 不包含 sessionId、worktreePath、patchPath；显式 Worker 卡片导航接口仅按 runId + workerId 定向返回 Session ID。

## 性能与耐久 TODO

- [x] `TST-1250` 单 Run 5 Worker、全进程 30 Worker并发创建/捕获。
- [x] `TST-1251` 同仓库 30 Worker和多仓库 30 Worker分别测量锁等待与吞吐。
- [x] `TST-1252` 连续创建/清理 1000 个 Run，检查目录、Git metadata 和内存增长。
- [x] `TST-1253` 100 MB 总 patch 的捕获和 Apply 内存峰值。
- [ ] `TST-1254` 进程运行 24 小时，检查 preserved 资源、artifact 和锁泄漏。

## 执行门禁 TODO

- [x] `TST-1260` 将 P0 单元/Git 集成测试加入 `npm run test:core` 或独立必跑脚本。
- [x] `TST-1261` 执行 `node_modules/.bin/tsc --noEmit`。
- [x] `TST-1262` 执行 `npm run lint`。
- [x] `TST-1263` 执行 `git diff --check`。
- [x] `TST-1264` 开发期间不运行 `next build`。
- [x] `TST-1265` 发布前由独立 reviewer 按失败优先方式审查 P0/P1。

## 验收标准

- [ ] 所有 16 项已复现问题都有至少一个先失败、修复后通过的回归测试。
- [x] P0 测试不依赖网络、真实用户仓库或人工清理。
- [x] 失败测试不会污染当前 DeerHux 工作树；每个入口使用登记的私有 temp/agent 根并在退出时核验。
