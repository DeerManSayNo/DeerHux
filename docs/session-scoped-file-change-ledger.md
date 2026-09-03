# 多 Chat Session 文件变更归属改造方案

## 1. 背景与问题

同一项目下允许多个 Chat Session 同时运行。当前实现会在每个回合开始、结束时分别读取一次共享工作区的 `git status`，再把状态差异附到该 Session 的 `agent_end.changedFiles`。

这个方案在单 Session 下可以补齐 Bash、MCP 等没有显式返回文件路径的工具，但在并发 Session 下无法判断改动来源：两个 Session 看到的是同一个工作区，任一 Session 结束时都可能把其他 Session 在其运行窗口内产生的变化认领为自己的变化。

前端的事件总线和展示状态已经按 `sessionId` 隔离，因此本次改造聚焦后端的“文件变更事实如何产生及归属”。

## 2. 目标

1. 每个文件变更必须优先归属于明确的 `sessionId + turnId + toolCallId`。
2. 同一工作区内，可能修改文件的工具执行不能互相穿插，避免前后快照混入其他 Session 的工具改动。
3. `write`、`edit` 保持精确、实时的显式文件上报。
4. `bash`、可写 MCP 和其他未知工具通过“工具执行前后快照”补齐文件路径。
5. `agent_end.changedFiles` 只从当前回合账本汇总，不再使用整个回合跨度的共享 Git baseline 推断。
6. Git 不可用、快照失败或非 Git 项目时，工具仍正常执行，并降级到显式 `changedFiles`。
7. 不改变生产 Agent Loop 宿主，不引入 Session runtime wrapper，不改变现有 SSE 新旧事件兼容。

## 3. 非目标与限制

- 本期不为普通 Chat Session 创建独立 Git worktree。
- 本期不尝试把用户在外部编辑器中的修改归属给某个 Chat Session。
- Shell 命令主动把后台进程脱离工具生命周期后，后台进程产生的延迟修改无法可靠归属；这类修改只会在后续工具快照中表现为外部变化。
- 非 Git 项目不做全工作区内容扫描；`write`、`edit` 仍可精确记录，Bash/MCP 仅使用它们显式返回的路径。
- 账本先保持回合期内存语义，不新增历史 Session JSONL 格式；刷新后的历史变更卡片恢复不在本期范围。

## 4. 核心设计

### 4.1 项目级修改协调器

新增 `WorkspaceMutationCoordinator`，以规范化后的工作区路径作为锁 key。

```text
Session A / Tool 1 ─┐
Session B / Tool 2 ─┼─> workspace mutation queue ─> snapshot before
Session C / Tool 3 ─┘                              ─> execute tool
                                                     ─> snapshot after
                                                     ─> calculate changed files
                                                     ─> release lock
```

锁只覆盖“可能修改工作区”的单次工具调用，不覆盖模型推理、读取、搜索或整个回合。这样多个 Session 仍能并发推理和读取，但写入事实按项目串行产生。

等待锁时必须响应 `AbortSignal`。工具执行成功、失败、抛错或中止都必须通过 `finally` 释放锁。

### 4.2 工具分类

只读内置工具采用白名单：

- `read`
- `grep`
- `find`
- `ls`
- `code_search`
- CodeGraph 的查询类工具
- `subagent`（只在隔离 worktree 产出 diff，不直接应用到主工作区）

下列工具按可能修改工作区处理：

- `write`
- `edit`
- `bash`
- MCP 工具和无法证明只读的未知工具

分类原则是“未知即可能写”。这会让部分只读 MCP 调用进入项目队列，但不会影响正确性；后续可在 MCP capability 中增加显式 `readOnly` 元数据优化并发度。

### 4.3 Git 工具级快照

工具加锁后、执行前后各读取一次 Git 工作区快照。快照只覆盖 `git status --porcelain=v1 -z --untracked-files=all --no-renames -- .` 返回的脏文件，不扫描所有干净文件。

每个路径的签名包含：

```ts
interface WorkspaceFileSignature {
  status: string;
  fingerprint: string;
}
```

`fingerprint` 对普通文件使用内容 hash，对符号链接使用链接目标，对删除或不可读路径使用稳定哨兵值。这样可以识别：

- 干净文件变为修改、删除或未跟踪；
- 回合开始前已经是 `M` 的文件被工具再次修改；
- 已有未跟踪文件内容被工具再次修改；
- 工具把原有脏文件恢复为干净状态。

差分采用前后快照 key 的并集；状态或 fingerprint 不同即属于当前工具。

### 4.4 回合变更账本

后端维护以 `sessionId + turnId` 为作用域的内存账本：

```ts
interface TurnFileChangeRecord {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  filePath: string;
}
```

最小实现不要求长期保存每条 record，但必须保证以下语义：

- 新逻辑回合开始时创建空集合；自动重试复用同一集合。
- `tool_execution_end.changedFiles` 写入该事件所属 `turnId` 的集合。
- 实时 `agent_file_changed` 继续发送，并携带既有的 session/turn 事件上下文。
- 最终 `agent_end` 仅消费同一 `turnId` 的集合。
- 异常终止和 destroy 路径消费当前回合集合，不执行额外 Git 扫描。
- 下一回合不能复用、覆盖或清空上一回合尚未结算的集合。

### 4.5 工具结果合并

工具最终文件列表为：

```text
工具显式 changedFiles ∪ 工具锁内 Git 快照差分
```

所有路径必须：

- 转为绝对路径；
- 位于当前 Session cwd 内；
- 去重；
- 拒绝 NUL、绝对越界和 `..` 越界。

显式结果优先保证 `write/edit` 在 Git 失败时仍可工作；快照用于补齐 Bash、MCP、格式化器和代码生成器。

### 4.6 不再使用回合级 Git baseline

删除 `AgentSessionWrapper` 中以下回合级推断状态：

- `gitChangedFilesBaseline`
- `gitChangedFilesTrackingActive`
- `changedFilesFinalizing`

`agent_end` 不再执行 Git 扫描。它只消费工具事件已经归属好的回合账本，因此 Session A 的结束时间不会把 Session B 的改动加入 A。

## 5. 事件链路

```text
ToolExecutor.executeOne
  → 判断工具是否可能修改工作区
  → WorkspaceMutationCoordinator.runExclusive
      → before snapshot
      → tool.execute
      → after snapshot
      → 合并 changedFiles
  → tool_execution_end(sessionId/turnId 由 Wrapper 绑定)
  → AgentSessionWrapper 按 turnId 记账
  → agent_file_changed
  → final agent_end.changedFiles = 当前 turn 账本
  → useAgentSession 合并实时事件与终态事件
  → ChatWindow changedFilesBySession[sessionId]
```

## 6. 失败与并发语义

| 场景 | 行为 |
|---|---|
| Git 仓库、快照成功 | 显式路径与快照差分合并 |
| 非 Git 项目 | 仅显式路径 |
| Git 超时/失败 | 工具正常执行，仅显式路径 |
| 工具抛错 | 仍尝试结束快照，记录实际已经发生的部分修改 |
| 等锁时用户中止 | 取消等待，不执行工具 |
| 执行中用户中止 | 工具自行响应 signal；结束快照后释放锁 |
| 两个 Session 修改不同文件 | 工具串行归属，各自列表互不包含对方文件 |
| 两个 Session 修改同一文件 | 两次工具调用依次执行，各自都记录该文件；不会在工具写入阶段交叉 |
| 外部编辑器恰好在锁窗口修改 | 无法从文件系统证明来源，可能被当前工具快照捕获；记录为已知限制 |

## 7. 验收标准

1. 两个 Session baseline 同时从干净工作区开始，各自通过 Bash 修改不同文件，最终列表互不串线。
2. 回合开始前已经修改的文件，再被 Bash 修改时能够归属到当前工具。
3. `write/edit` 在非 Git目录或 Git 命令失败时仍精确上报。
4. 工具失败但落盘了部分内容时，文件仍进入当前回合账本。
5. 等锁期间 abort 不会执行工具，也不会卡死后续调用。
6. 自动重试不清空前一次尝试已经记录的路径。
7. 连续回合的文件集合互不泄漏。
8. `agent_end` 不再等待最长 3 秒的 Git 扫描。
9. 现有 Session SSE、EventStore 顺序、前端实时文件提示保持兼容。

## 8. 最小化 TODO

- [x] 新增项目级、可中止、异常安全的工具修改锁。
- [x] 新增带内容 fingerprint 的 Git 脏文件快照及对称差分。
- [x] 在 `ToolExecutor` 接入工具分类、锁和前后快照，合并显式路径。
- [x] 将 `cwd` 传入生产 `ToolExecutor`，测试构造保持可选兼容。
- [x] 将 Wrapper 的单集合改为按 `turnId` 结算的回合账本。
- [x] 移除 `agent_end` 的回合级 Git baseline 扫描与 finalizing 等待。
- [x] 添加并发 Session、预先脏文件、abort、失败落盘和非 Git降级测试。
- [x] 运行聚焦测试、`node_modules/.bin/tsc --noEmit` 与 `npm run lint`。

验证结果：`npm run test:core` 全部通过，TypeScript 检查和本次改动文件的 ESLint 检查通过。全仓库 `npm run lint` 已执行，但仓库内 `codeAgent/` 供应商源码存在大量既有 ESLint 错误，因此全仓库命令仍为失败；本次修改文件没有新增 lint 错误。

## 9. 后续可选增强

- MCP 工具 capability 增加 `readOnly` / `mutatesWorkspace` 声明，减少不必要的串行化。
- 将 record 持久化到轻量事件日志，支持刷新后恢复、按工具查看 diff 和回合级撤销。
- 给后台脱离进程增加检测和警告。
- 对高并发编码任务提供独立 worktree Session 模式。
