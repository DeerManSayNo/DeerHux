# 10 执行安全边界

## 目标

准确表达并逐步收紧 isolated coding 的执行权限。Git Worktree 只隔离常规源码写入，不承担恶意代码或任意 shell 的安全边界。

## 当前安全基线与独立审查（2026-09-05）

安全部分独立审查通过，已复现 P0/P1 清零。保护对象包括主工作区、其他 Worktree、Git common dir、凭据、其他用户文件和网络服务；当前管理端的校验只能保护管理操作不因不可信参数越界，不隔离高权限 Worker Bash 对这些对象的主动访问。完整威胁模型和后续准入门槛见 [进程隔离 ADR](./15-process-isolation-adr.md)。

本章真实 Git 红队发现并修复：陈旧 cleanup plan 被替换 namespace；整体伪造 manifest repo/common 指向另一仓库；Discard 仅信 manifest 自洽而缺失独立创建身份；`git status` 触发仓库 clean filter。回归不是只检查错误码，还核对 victim ref、Store、文件及 filter marker 均未变化。

Manifest 采用 8 MiB 读写同限、固定 FD 分块读取、owner/mode 与父链 symlink 检查及读取前后身份比较。run/artifacts 目录为 0700、文件为 0600；已有 runsRoot 可为当前 owner 的不可组/其他用户写入目录，保留 macOS 系统 `/var`、`/tmp` 别名兼容，不自动修改用户目录权限。reconciler 验证 artifact 前先校验受管路径，最大 256 MiB，按实际大小增量 hash。

清理执行必须重新比对完整 manifest 快照和资源 namespace，不能只比较 `updatedAt`。启动恢复中的孤儿 manifest 没有独立可信创建锚点，因此即使 namespace/OID 自洽，也不删除仍存在的 Worktree 或 branch。已有资源保留，完全缺失的资源才可结算状态；这比早期“自动删除无变化分支”计划更保守。

显式 Discard 由 API 从宿主 Store 的 `cwd`、固定 `baseCommit` 解析可信 repo/common 身份，独立于 manifest 和 HTTP 参数。preview 缺少该身份或不匹配就不发 token；一次性 token 绑定独立身份与 manifest digest，commit 在锁前和锁内再次核验。现存 Worktree 与 patch 的保留限制没有放宽。

管理端事实读取不再调用 `status/add/apply/write-tree` 重建工作区；这些路径可能执行 Git filter 或写入对象。只读 metadata 命令禁用 hooks/fsmonitor，限制时间/输出并清除 Git 注入环境。非 ignored untracked 文件可证明 `dirty=true`，其余工作区内容保持未知而非 clean。Discard 对未知内容展示 `WORKTREE_CONTENT_UNVERIFIED`，要求确认且保留现存资源。

验证入口：`scripts/test-worktree-security-redteam.ts --http`（随 `npm run test:worktree-observability` 运行），另有 manifest/reconciler/Discard/Continue/Apply 专项。OS 沙箱、跨平台隔离和网络策略并未在本章实现。

## 威胁模型 TODO

- [x] `SEC-1001` 列出保护对象：主工作区、其他 Worktree、Git common dir、凭据、用户其他文件、网络服务。
- [x] `SEC-1002` 列出可信主体：父进程、用户确认操作、用户侧可信配置；Worker输出、仓库声明和 manifest 内容需要再次核验。
- [x] `SEC-1003` 区分误操作、失控命令、恶意 Prompt/仓库和供应链脚本四类威胁。
- [x] `SEC-1004` 明确当前 Bash 可访问任意绝对路径、共享 Git refs/config/hooks，因此当前能力等级是“协作隔离”。
- [x] `SEC-1005` 当前卡片/文档明确协作隔离，不使用“安全沙箱”宣传；未新增安全设置开关。

## 路径与 Git 保护 TODO

- [x] `SEC-1010` 生产管理路径采用 canonical containment 与身份校验；无身份时拒绝或保留。
- [x] `SEC-1011` 删除前拒绝 symlink，且使用 `lstat` 核对预期文件类型。
- [x] `SEC-1012` manifest 自洽不构成删除授权；显式 Discard 另核对独立 Store 身份，孤儿自动清理保留。
- [x] `SEC-1013` 显式分支删除限制在固定 namespace，并核对独立 repo/base、token 与实时 OID。
- [x] `SEC-1014` Worktree cleanup 不直接拼接 `.git/worktrees/<basename>` 手动删锁。
- [x] `SEC-1015` patch 文件读取限制在受管 artifact root，并校验 owner、模式和 digest。

## Worker 能力 TODO

- [x] `SEC-1020` Worker 仅使用既定 read/bash/edit/write/grep/find/ls/code_search/codegraph 集合，禁嵌套 subagent 和 Session/Run 管理工具。
- [x] `SEC-1021` 工具默认 cwd 为 agentCwd，卡片明确协作隔离限制；read/Bash 权限并非局限在该路径。
- [x] `SEC-1022` Bash 仍开放时记录为高权限能力，不能宣称路径隔离。
- [x] `SEC-1023` 调研 macOS sandbox/Linux namespace 等可选进程隔离，形成单独 ADR 后再实施；结论见 `15-process-isolation-adr.md`，本版不启用 OS 沙箱。
- [ ] `SEC-1024` 若启用进程沙箱，显式挂载 Worktree、必要工具链和只读缓存，主工作区不挂载或只读挂载。
- [ ] `SEC-1025` 网络访问策略独立配置，不与 Worktree 开关隐式绑定。

## 管理操作授权 TODO

- [x] `SEC-1030` Apply 只允许落到创建 Run 时记录的 repo identity。
- [x] `SEC-1031` Discard 未捕获/未核验变化必须有一次性确认 token，现存成果仍保留。
- [x] `SEC-1032` cleanup plan 与 cleanup execute 分离，执行时重新检查完整快照与实时事实。
- [x] `SEC-1033` API 请求不能传任意 manifestPath、worktreePath 或可信 repo identity 作为删除授权。
- [x] `SEC-1034` 跨实例操作使用所有权与启动身份核验；陈旧 PID/heartbeat 单独不能授权操作或删除。

## 对抗测试 TODO

- [x] `SEC-1040` Worker 尝试通过 `../`、绝对路径和 symlink 写出 Worktree；红队实证三种写法均可越界，确认当前只是协作隔离而非 OS 沙箱。
- [x] `SEC-1041` 篡改 manifest 指向其他仓库、Worktree和任意分支的真实回归。
- [x] `SEC-1042` Run/root/祖先 symlink 被拒绝，恢复和 Discard 保留资源。
- [x] `SEC-1043` patch artifact 被替换、权限改变、digest 改变的真实回归。
- [x] `SEC-1044` 实证 shared Git config 风险，管理端读取不执行 clean filter；不承诺隔离 Worker 主动写 refs/hooks。

## 验收标准

- [x] 已知管理端越界删除路径经真实红队修复验证；无独立授权的资源保守保留。
- [x] 产品明确区分源码协作隔离与操作系统进程沙箱。
- [x] 高风险操作具备显式授权、二次校验和固定字段审计事件。
