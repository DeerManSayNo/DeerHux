# 04 Diff 捕获与持久化 Artifact

## 目标

捕获 Worker 相对固定基线的完整 Git 成果，包括未跟踪文件、删除、重命名、提交和二进制内容；捕获失败时保留原 Worktree。

## 涉及文件

- `lib/parallel-agent/worktree.ts`
- `lib/parallel-agent/collaboration-orchestrator.ts`
- 新增 `lib/parallel-agent/worktree-artifacts.ts`

## 捕获算法 TODO

- [x] `DIF-0401` 捕获前读取并核对 manifest 的 `baseCommit`，禁止使用 Worker 当前 `HEAD` 作为基线。
- [x] `DIF-0402` 暂存前记录 Worker 当前 branch/HEAD，用于审计 Worker 自行 commit 的情况。
- [x] `DIF-0403` 清理已声明 synthetic paths，避免依赖链接、hook 产物进入 patch。
- [x] `DIF-0404` 在 Worker Worktree 执行 `git add -A -- .`，纳入未跟踪文件、删除和重命名。
- [x] `DIF-0405` 使用 `git diff --cached --binary --full-index --no-ext-diff <baseCommit> --output=<tempPatch>`。
- [x] `DIF-0406` 使用 `git diff --cached --numstat -z <baseCommit>` 生成结构化文件统计。
- [x] `DIF-0407` 使用 NUL 分隔解析路径，正确支持空格、换行、重命名和非 ASCII 文件名。
- [x] `DIF-0408` 从 numstat 的 `-` 标记识别二进制文件，不通过文本正则猜测。
- [x] `DIF-0409` patch 为空时记录 `changed: false`，不得伪装为已捕获变更。
- [x] `DIF-0410` Worker 有 commit 但最终树与 `baseCommit` 相同的情况记录为无净变化。

## Artifact 持久化 TODO

- [x] `DIF-0420` patch 先写同目录临时文件，关闭并同步后原子 rename。
- [x] `DIF-0421` 计算 SHA-256、字节数、文件数和二进制文件数并写入 manifest。
- [x] `DIF-0422` patch 文件权限限制为当前用户可读写。
- [x] `DIF-0423` 再次读取 patch 并校验 digest，成功后才标记 capture complete。
- [x] `DIF-0424` 通过独立临时 index 或一次性验证 Worktree检查 patch 对 `baseCommit` 可应用。
- [x] `DIF-0425` 捕获错误写入稳定错误码；禁止用空字符串覆盖此前有效 patch。
- [x] `DIF-0426` Collaboration 快照默认只保存摘要和 artifact 引用，避免大 patch 重复持久化。
- [x] `DIF-0427` API 层继续隐藏本机 patch 绝对路径；需要查看时通过受控 endpoint 返回内容。

## 生命周期保护 TODO

- [x] `DIF-0430` 未生成 patch、digest 不匹配、验证失败或 manifest 写失败时，将 Worker 标为 `preserved`。
- [x] `DIF-0431` `preserved` 状态下禁止自动删除 Worktree 和分支。
- [x] `DIF-0432` 捕获成功后仍保留 patch 至 Apply/Discard 结算及审计保留期结束。
- [x] `DIF-0433` 删除 artifact 前验证没有 Run、Worker、Apply transaction 或恢复记录引用它。

## 测试 TODO

- [x] `DIF-0440` tracked 修改、新文件、删除、重命名、chmod、符号链接测试。
- [x] `DIF-0441` Worker commit、commit 后继续修改、多个 commit 测试。
- [x] `DIF-0442` PNG/字体/随机 NUL 数据的新建、修改、删除测试，并实际 `git apply` 校验字节一致。
- [x] `DIF-0443` 空文件名选择、路径含换行、Unicode 和 `--` 前缀测试。
- [x] `DIF-0444` patch 大于 10 MB 测试，证明不依赖 Node stdout buffer。
- [x] `DIF-0445` patch 写到一半、digest 不符、磁盘满测试，确认 Worktree 保留。

## 验收标准

- [x] 对 Git 可表达的任意成果，patch 应用到 `baseCommit` 后的树对象与 Worker 最终树一致。
- [x] 二进制 patch 包含 `GIT binary patch` 或可应用的完整对象信息。
- [x] 捕获失败绝不触发清理。
