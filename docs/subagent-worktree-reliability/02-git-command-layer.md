# 02 Git 命令执行层

## 目标

统一 Git 子进程调用、错误分类、超时和仓库身份解析，移除 Worktree 主链路中的 shell 字符串拼接。

## 涉及文件

- `lib/parallel-agent/worktree.ts`
- 新增 `lib/parallel-agent/git-process.ts`
- 新增 `lib/parallel-agent/git-repository.ts`

## 命令封装 TODO

- [x] `GIT-0201` 实现 `runGit(cwd, args, options)`，底层使用 `execFile`/`spawn` 且 `shell: false`。
- [x] `GIT-0202` 参数始终以数组传递；禁止调用方自行添加引号或拼接命令字符串。
- [x] `GIT-0203` 返回 `exitCode`、`signal`、`stdout`、`stderr`、`durationMs`，错误中保留脱敏后的子命令名称。
- [x] `GIT-0204` 为读命令和写命令设置独立超时；超时后终止整个子进程组并等待退出。
- [x] `GIT-0205` 对 stdout/stderr 设置显式上限；大 patch 使用 `--output=<file>`，不经 Node 字符串缓冲。
- [x] `GIT-0206` Git 不存在、非仓库、锁冲突、ref 不存在、patch 冲突、超时分别映射稳定错误码。
- [x] `GIT-0207` 日志不得记录 patch 正文、环境变量或主机绝对路径。

## 仓库身份 TODO

- [x] `GIT-0210` 使用 `git rev-parse --show-toplevel` 获取 repo root。
- [x] `GIT-0211` 使用 `git rev-parse --git-common-dir` 获取共享 Git 元数据目录，并解析 realpath。
- [x] `GIT-0212` 将调用 cwd 转为 repo root 下的 `sourceCwdRelative`；拒绝 `..` 越界。
- [x] `GIT-0213` 使用 `git rev-parse <baseRef>^{commit}` 将基线固化为 commit SHA。
- [x] `GIT-0214` 检查 SHA 对应对象类型必须是 commit。
- [x] `GIT-0215` 仓库身份比较使用 realpath 后的 `gitCommonDir`，支持从仓库子目录启动。

## 并发与锁 TODO

- [x] `GIT-0220` 为同一 `gitCommonDir` 建立进程内互斥队列，串行化 Worktree add/remove/prune 和 Apply。
- [x] `GIT-0221` 设计跨进程锁文件，内容包括 `instanceId`、PID、进程启动标识、创建时间和操作类型。
- [x] `GIT-0222` 获取锁时使用排他创建，不覆盖现有锁。
- [x] `GIT-0223` 释放锁前校验所有权，禁止删除其他实例锁。
- [x] `GIT-0224` stale lock 判断同时检查 PID、启动标识和 TTL，不能仅检查文件年龄。
- [x] `GIT-0225` 锁等待支持 AbortSignal；超时只终止当前请求，不删除任何 Worktree。

## 测试 TODO

- [x] `GIT-0230` 覆盖路径含空格、单引号、双引号、美元符号和 Unicode。
- [x] `GIT-0231` 覆盖 stdout 超限、stderr 超限、超时和信号终止。
- [x] `GIT-0232` 覆盖嵌套 cwd、普通仓库、linked worktree 和 bare common dir 解析。
- [x] `GIT-0233` 覆盖两个进程竞争同一 repo 锁，证明不会并发 Apply。

## 验收标准

- [x] `lib/parallel-agent/worktree.ts` 不再包含用于 Git 的 `execSync("...")` 字符串命令。
- [x] 任意合法文件系统路径都按单一 argv 参数传给 Git。
- [x] 大 patch 不受默认 `maxBuffer` 限制。
