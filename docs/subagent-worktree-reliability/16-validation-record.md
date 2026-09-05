# 16 本地验证记录与发布边界

日期：2026-09-05。以下为实际运行证据，不是线上发布报告。未运行 `next build`，未提交、推送或部署。

## 测试分层

- 单元/真实 Git/API handler：`npm run test:core` 包含 Store CAS、固定基线 capture、atomic Apply、Continue/Discard、环境 hook、管理安全、观测、跨进程 E2E 和 rollout 前置门禁。
- 浏览器：`npm run test:worktree-browser` 使用本机 Chromium、真实 React 组件与 mock HTTP；验证桌面/移动、键盘焦点、选择、未知响应、冲突、Continue TTL 与强确认/部分 Discard。**不是浏览器连接真实后端的全栈 E2E**。
- API handler E2E：`test-subagent-worktree-e2e.ts` 启动两个独立 Node 进程；真实 Store、SessionManager、session registry、manifest、Git 和 Request/Response handler，仅替换模型执行并禁止网络。create 阶段开关为 1，restart 阶段为 0，验证现存 Run 不因停新建而失去恢复能力。
- 平台：macOS 本机通过；Linux 一次性 `node:24-bookworm-slim`（Node 24.19.0、Git 2.39.5）容器通过 manifest、Git process/repository、artifact、atomic Apply、reconciler，以及新增 crash/restart 与完整 handler/fresh-process E2E。源码只读挂载，临时 Git fixture 位于容器 tmpfs，未写宿主工作树。
- 资源退出门禁：package 中 39 个去重 Worktree 测试脚本及其直接子进程通过 fresh-child runner 使用各自登记的私有 TMPDIR/TMP/TEMP 与 agent 根；仅允许空 `deerhux-runs`、空 `agent/tasks` 外壳。它曾真实检出 crash child 的 Apply scratch 外泄；公共 fixture 删除前另核对 Worktree、branch、Git metadata、锁及 capture/apply 临时 index。独立终审补齐 `deerhux-capture-index-` 漏检后通过。

## 16 项历史问题与行为回归

| 问题 | 实际行为测试 |
|---|---|
| 1. 新文件丢失 | `test-worktree-artifacts.ts`：含 untracked 的 patch 重建目标 tree |
| 2. Worker commit 后 Diff 为空 | 同上：相对创建 baseCommit 而非当前 HEAD 捕获 |
| 3. 二进制失败 | artifacts + `test-atomic-apply.ts`：binary patch 应用与内容校验 |
| 4. 空选择误报成功 | atomic Apply：拒绝空 Worker/空文件，主仓库不变 |
| 5. 多 Worker 部分写入 | atomic Apply + handler E2E：全选/子集成功，冲突 409 前后 HEAD/index/文件不变 |
| 6. 重启破坏 Continue | handler E2E：新 Node 恢复真实 Session 历史并 Continue→Apply；restart 红队保护终态 |
| 7. 跨实例误删 | `test-git-repository.ts`：真实双进程锁；reconciler 活跃 owner 保留决策 |
| 8. 跨仓库 Git 元数据 | `test-worktree-security-redteam.ts --http`：foreign repository/ref 授权拒绝、原资源不变 |
| 9. 重复名称覆盖 | handler E2E：真实 admission 拒绝，模型未启动且零资源残留 |
| 10. 中途创建泄漏 | `test-worktree-setup-manifest.ts`：多阶段真实 Git 故障与逆序回滚 |
| 11. dirty 源工作区 | `test-worktree-admission-redteam.ts`：tracked/staged/untracked 三态拒绝且零新增资源 |
| 12. Shell 拼接/同步 Git | `test-git-process.ts`：恶意路径 argv、timeout/output cap/Abort；仓库写锁行为测试。管理 CLI 少量同步 metadata Git 有明确超时，不称全代码无同步 Git |
| 13. Worktree 不是安全边界 | security 红队真实共享 config 实证，管理读取不执行 filter/fsmonitor；OS sandbox 仍未实现 |
| 14. ignored 环境缺失 | environment integration/redteam：none 不复制凭据、可信 hook 独立依赖、synthetic 身份与进程组约束 |
| 15. 前端无 Apply 入口 | Chromium 实际组件交互测试，HTTP 为 mock；后端另有真实 handler 测试 |
| 16. 自动化缺口 | package 必跑 core + 独立 browser/stress，跨进程、Linux、故障注入与对抗审查 |

16 项均有行为测试。**不能据此倒推本轮曾对所有旧版本逐一运行“先红”**；原 session 已继承的修复保留其历史记录。本轮确实先红再绿的新问题包括：reconciler 将 captured/applied 错降为 preserved，导致恢复后 Apply/历史重放失败；管理 Git status 执行 clean filter；伪造清理快照/仓库身份；synthetic HEAD/index 漏检等。

## 崩溃与终态

`test-worktree-setup-crash.ts` 对 planning manifest 落盘、真实 Worktree 创建后/Worker 启动前，以及 stand-in Worker 写入 tracked/binary untracked 后/capture 前三个窗口分别真正退出进程，并新增父进程实际发送 SIGTERM/SIGKILL 的两个窗口；另起新 Node 执行恢复。原 owner 已死、finally 未运行，manifest 与已有资源、未捕获字节均保留，全部 cleanup plan 为 retain。

`test-worktree-lifecycle-matrix.ts` 覆盖 3,024 个不可变 cleanup/owner 决策组合，包括 TTL 边界、capture、dirty/unknown、branch ahead、目录/注册存在性和审计保留；另以真实存活 PID 验证正确/错误启动身份、fresh/stale heartbeat 和新旧锁组合。它验证 PID 复用防护的身份语义，不声称实际耗尽内核 PID 制造号码复用。

`test-worktree-crash-redteam.ts` 使用真正子进程 `process.exit`，不是 throw 后执行 finally：Apply prepared/checked 后退出，主文件/index 不变、同 key 恢复成功；patch rename/fsync 后、manifest settled 前退出，未结算 artifact/Worker/branch 全部保留。已有 atomic 测试包含 afterApplied 真退出及持久化异常恢复。

`test-worktree-restart-redteam.ts` 验证完整 captured 保持可应用，applied/discarded 不因资源保留而降级；已 applied 后用户 commit/edit，原 key 重放不写用户内容；中断 Continue 的旧 capture 不可被当成最新结算成果。并非所有进程退出点、真实 PID 重用均已穷举，不能宣称等价于掉电或文件系统失效实验。

## 压力实测

| 场景 | 实际规模与结果 |
|---|---|
| 同仓库并发 | 6 Run × 5 Worker，30 个 Worktree/capture；11.53 秒，最大锁等待约 5.69 秒，仓库写临界区峰值 1 |
| 多仓库并发 | 6 仓库各 5 Worker，共 30；6.42 秒，最大锁等待约 1.55 秒，独立仓库写临界区峰值 6 |
| 大 patch | 1 Run × 5 Worker，114,875,320 字节 patch（约 109.55 MiB）；capture 7.65 秒，Apply/校验/fixture 清理合计约 3.27 秒，5 个输出文件 SHA-256 全匹配 |
| 内存口径 | 上述大 patch 整轮父 Node 峰值 448,217,088 字节（427.45 MiB）；不含子 Git 进程，不是系统总内存峰值 |
| 1000 Run | 独立完整执行 1000 Run × 1 Worker、1000 capture，579.979 秒，exit 0；refs/worktree 注册/index/锁/临时路径全部回到基线。父 Node RSS 基线 144.64 MiB、回收后最大 202.38 MiB、结束 129.28 MiB；全程峰值 203.36 MiB（不含子 Git） |
| 24 小时 | harness 提供 `--duration-hours 24`，尚未运行，也未创建后台自动任务 |

压力测试复用 production setup/capture/atomic Apply；30 Worker 表示 Git 资源/捕获并发，不是 30 个真实模型 runtime。耐久回收是**私有 fixture 的显式清理**，不证明生产保守自动 cleanup 会删除成果。每批核验 refs、worktree list、index、锁和临时 metadata；只清理预登记的随机 Run/Worker/ref，绝不扫描删除全局 runs。Git 对象库存储增长可来自正常 capture 写入的 unreachable objects，报告必须与目录/锁泄漏区分。

## 剩余发布门禁

- 24 小时实际运行、机器休眠/更广掉电点的验证仍未完成；PID 启动身份与 stale lock 组合已经自动化，未实际耗尽内核 PID。
- 尚无浏览器对真实网络后端的完整全栈场景；Tauri 本地后端重启人工验收未完成。
- Stage A–E 实际部署 cohort、每阶段至少 2 小时完整保留窗口、默认启用后观察和一周线上监控未执行。
- 未拆分 PR、未提交/发布；旧 legacy 使用量未向真实用户历史做全量调查。未删除兼容 guard。
- 最后 codegraph callers/impact 检查：旧 `applyPatch` 没有生产调用者，仅保留固定拒绝的兼容 guard；`generateDiff` 已无符号。没有为收口删除未知用户历史或未结算资源。
- 新建默认关闭。已存在 v2 的恢复与人工成果读取保留；不要把本地测试通过写成已上线或整个研发计划全部完成。
