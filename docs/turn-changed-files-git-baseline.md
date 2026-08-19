# 回合级改动文件汇总（轻量 Git 基线方案）

## 目标

对话回合结束后，在 DeerHux 聊天底部完整展示**本回合**修改的工作区文件，补齐现有仅依赖 `write` / `edit` 工具事件导致的遗漏。

本期必须覆盖最终写入主工作区的以下改动来源：

- `bash` 中的脚本、格式化器、代码生成器、重定向等；
- MCP 工具；
- 子 Agent 完成后合并到主工作区的改动；
- 既有 `write` / `edit` 工具。

## 明确不做

为控制复杂度，本期不做：

- 文件系统监听器；
- 全工作区文件哈希 / 内容快照；
- 变更结果写入会话文件（页面刷新后的历史恢复）；
- 重命名的专门类型；重命名按删除旧路径、增加新路径处理；
- 非 Git 工作区下对 Shell/MCP 的通用检测。

## 已有链路

```text
工具执行结束
  → lib/rpc-manager.ts / AgentSessionWrapper.start()
  → agent_file_changed
  → hooks/useAgentSession.ts 的 changedFilesRef
  → 最终 agent_end
  → onAgentEnd(sessionId, changedFiles)
  → components/ChatWindow.tsx
  → components/ChangedFilesList.tsx
```

当前 `lib/engine/coding-tools.ts` 的 `write`、`edit` 在 `tool_execution_end.changedFiles` 中携带路径；但 `bash`、MCP、子 Agent 不保证携带，造成漏检。

## 最终设计

借鉴 OpenCode 的 Git 状态事实源，但只在**回合开始与最终结束**各扫描一次：

```text
agent_start
  → 读取 Git porcelain 状态基线
  → 保存于当前 AgentSessionWrapper 的内存字段

工具执行期间
  → 保留既有 agent_file_changed 实时路径事件

最终 agent_end（willRetry !== true）
  → 读取 Git porcelain 结束状态
  → 计算相对基线新增或状态变化的路径
  → 合并本回合显式工具路径
  → 将完整、去重、绝对化的 changedFiles 附到 agent_end
  → 前端将 agent_end.changedFiles 与实时路径集合合并后展示
```

## Git 契约

### 命令

必须用无歧义、可处理特殊文件名的 porcelain v1 NUL 格式：

```bash
git status --porcelain=v1 -z --untracked-files=all --no-renames -- .
```

- 工作目录：当前 session 的 `cwd`；
- 不使用 shell 拼接；
- stdout 采用 `\0` 分隔；
- 非零退出、超时、无法启动 Git 都返回 `null` 并降级，**不能阻塞或破坏 agent_end**；
- 命令需有较短的超时保护，建议 3 秒。

### 解析结果

解析为 `Map<relativePath, statusCode>`：

- 每项格式是 2 字符状态、1 个空格、路径；
- 要保留所有已跟踪和未跟踪文件；
- `--no-renames` 下无需处理 porcelain 的双路径重命名格式；
- 路径必须校验为工作区内相对路径，拒绝空串、NUL、绝对路径和 `..` 越界路径。

### 基线差分

结束快照中某个路径满足下列任意条件时，属于本回合 Git 检测结果：

1. 基线不存在、结束存在；
2. 基线和结束的 porcelain 状态码不同。

基线有、结束没有的路径不要仅凭 Git 差分加入：它可能是用户在本回合中清除了历史改动，不属于 Agent 改动。显式工具路径仍可补入，以维持当前语义与兼容性。

该策略刻意不解决：用户在回合开始前已修改某文件且 Agent 通过 Shell 再次修改，若 Git 状态码未变则无法归属到此回合。解决它需要内容哈希，不在本期范围内。

## 运行时与事件契约

### `AgentSessionWrapper`

文件：`lib/rpc-manager.ts`

新增私有状态，最少包括：

```ts
private gitChangedFilesBaseline: Map<string, string> | null = null;
private explicitChangedFilesInTurn = new Set<string>();
```

要求：

- `agent_start` 仅在**新的逻辑用户回合**开始时重置显式集合、获取 Git 基线；自动重试在 `agent_end.willRetry === true` 后再次发出的 `agent_start` 必须复用原基线和集合，不能丢失重试前改动。以 wrapper 的逻辑回合活跃标志或 generation 保护异步基线写入，避免上一回合结果写入下一回合。
- 所有现有 `extractChangedFilePaths()` 产生的、绝对化且工作区内的路径都加入 `explicitChangedFilesInTurn`，并继续发送现有 `agent_file_changed`。
- **最终** `agent_end` 发生时，在 append 到 EventStore、通知 listeners 之前，先收集 Git 结束快照、计算差分、合并显式集合，将 `changedFiles?: string[]` 附到这个最终事件。
- `agent_end` 且 `willRetry === true` 不是最终结算边界，不得清空/结算。
- `agent_end` 的最终事件不能因 Git 读取异常或超时被延迟到不可接受，也不能因异常丢失。Git 失败时仅使用显式集合。
- `AgentEvent` 的类型若未声明 `changedFiles`，应在正确的共享类型位置补齐可选字段，避免不安全的任意类型扩散。
- wrapper 自行补发的异常 `agent_end`、destroy 的 `agent_end` 也应尽可能带上当前显式集合；本期不要求在 destroy 路径执行 Git 扫描，避免复杂异步销毁。

### EventStore 顺序

`agent_end.changedFiles` 是回合最终权威补充。此前实时 `agent_file_changed` 可以先到，前端必须合并而不是覆盖。

### 前端

文件：`hooks/useAgentSession.ts`

- 每次 `agent_file_changed` 继续写入 `changedFilesRef`；
- 在 `agent_end` 的最终处理分支中，读取 `event.changedFiles?: string[]`，校验字符串、与当前 Set 合并、去重；
- 调用 `opts.onAgentEnd(sessionId, [...changedFilesRef.current])` 时保证包含二者；
- 每个新用户回合开始时已有的集合重置行为必须保留，不能让上一回合文件泄漏；
- 不改 `ChatWindow.tsx` / `ChangedFilesList.tsx` 的展示接口，除非类型检查证明必要。

## 非 Git 与失败降级

| 场景 | 结果 |
|---|---|
| Git 仓库且命令成功 | Git 回合差分 ∪ 显式工具路径 |
| 非 Git 工作区 | 仅显式工具路径 |
| Git 不存在、超时、命令失败、解析异常 | 仅显式工具路径 |
| 空改动 | 不附加 `changedFiles` 或附加空数组；前端不显示卡片 |

## 验收标准

1. `write` / `edit` 文件仍在最终列表中。
2. 回合中经 `bash` 写入且回合开始时干净的文件会出现。
3. `bash` 删除文件会出现。
4. Git 未跟踪文件会出现。
5. 回合开始前已有的未提交改动、且本回合没有触碰的文件不会出现。
6. Git 命令失败 / 非 Git 目录时回合仍正常结束，`write` / `edit` 结果仍展示。
7. `agent_end.willRetry === true` 不会提前结算或清空本回合改动。
8. 多回合连续执行时，改动集合不泄漏到下一回合。
9. 现有 SSE EventStore 与 UI 事件顺序不回归。

## TODO（按顺序执行）

1. 在 `lib/rpc-manager.ts` 新增可单测的 Git 状态读取、NUL porcelain 解析、基线差分工具函数；补充必要事件类型。
2. 在 `AgentSessionWrapper.start()` 接入每回合基线、显式路径累计、最终 `agent_end` 事件富化；处理异步竞态和失败降级。
3. 在 `hooks/useAgentSession.ts` 合并 `agent_end.changedFiles` 与实时路径集合。
4. 新增或扩展 Node 脚本测试，覆盖 Git 解析/差分、失败降级、`willRetry`、多回合隔离及前端合并契约。
5. 执行 TypeScript 检查、聚焦测试、lint。
6. 独立进行对抗性审查：特殊路径、NUL 状态解析、并发回合、事件顺序、异常回合、非 Git、恶意/越界路径。
7. 根据审查结果修复并复验；直到没有阻断问题。

## 回滚

本功能只涉及回合事件的可选 `changedFiles` 增强及前端集合合并。若发生问题，回滚 `lib/rpc-manager.ts` 的 Git 结算逻辑即可恢复既有 `write/edit` 路径识别能力；不会改写会话文件或工作区内容。
