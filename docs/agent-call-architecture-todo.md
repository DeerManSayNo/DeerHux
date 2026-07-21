# DeerHux Agent 调用架构 TODO 清单

> 来源：`docs/agent-call-architecture-issues.md` 及当前代码只读核对。  
> 目标：把架构问题拆成可执行、可验收、可分批落地的 TODO。

---

## 1. 总览

| 优先级 | TODO | 主要文件 | 状态 |
|---|---|---|---|
| P0 | 收敛 `AgentEnginePort`，不要继承完整 `AgentSessionLike` | `lib/engine/port.ts`, `lib/deerhux-types.ts`, `lib/rpc-manager.ts`, `lib/engine/deer-loop.ts` | 仍存在 |
| P0 | 修复 `DeerLoopEngine.sessionFile` 永远 `undefined` | `lib/engine/deer-loop.ts` | 仍存在 |
| P0 | 统一 `sessionId` / `realSessionId` / `tempKey` 身份体系 | `lib/rpc-manager.ts`, `lib/parallel-agent/subagent-runner.ts`, `lib/session-reader.ts` | 仍存在 |
| P1 | 明确 subagent 默认激活策略 | `lib/rpc-manager.ts`, `lib/parallel-agent/subagent-tool.ts` | 仍存在，需产品语义确认 |
| P1 | 修复 `ToolExecutor` 改变 LLM toolCall 源序的问题 | `lib/engine/tool-executor.ts` | 仍存在 |
| P1 | 给 subagent toolCall / worker 并发加硬限制 | `lib/parallel-agent/subagent-tool.ts`, `lib/parallel-agent/collaboration-orchestrator.ts` | 仍存在 |
| P1 | 给用户传入的 `params.workers` 加数量上限 | `lib/parallel-agent/subagent-tool.ts` | 仍存在 |
| P1 | 显式化 subagent worker 生命周期与 continue 能力 | `lib/parallel-agent/collaboration-orchestrator.ts`, `lib/parallel-agent/subagent-runner.ts` | 部分缓解但仍不完整 |
| P1 | 文件变更事件优先消费 `changedFiles[]` | `lib/rpc-manager.ts`, `lib/engine/tool-executor.ts` | 仍存在 |
| P1 | 收口 `modelRegistry` 空代理问题 | `lib/engine/deer-loop.ts`, `lib/rpc-manager.ts` | 仍存在 |
| P2 | `ToolResultMessage` 回填 `details` | `lib/engine/deer-loop.ts` | 仍存在 |
| P2 | 更新 `DeerLoopEngine` 文件头注释 | `lib/engine/deer-loop.ts` | 仍存在 |

---

## 2. P0 TODO

### P0-1：拆分并收敛 `AgentEnginePort` 边界

#### 当前问题

当前 `lib/engine/port.ts` 中：

```ts
export interface AgentEnginePort extends AgentSessionLike {
  setSystemPromptPersistent(prompt: string): void;
  applyToolExecutionModes(): void;
  installRetryHardening(): void;
  replaceCustomTools(...): void;
}
```

而 `AgentSessionLike` 仍暴露大量旧 pi-coding-agent 风格字段：

- `sessionManager`
- `settingsManager`
- `modelRegistry`
- `agent.state`
- `navigateTree`
- `compact`
- `setThinkingLevel`
- `steer`
- `followUp`

导致 `DeerLoopEngine` 虽然已经是自研 loop，但仍需伪装成旧 `AgentSession`。

#### TODO

- [ ] 新增更小的 port 分层，例如：
  - [ ] `AgentRuntimePort`
  - [ ] `SessionPort`
  - [ ] `ModelPort`
  - [ ] `ToolPort`
  - [ ] `CompactionPort`
  - [ ] `QueuePort`
- [ ] 将 `AgentSessionWrapper` 从依赖完整旧 session 形状，迁移到依赖显式端口组合。
- [ ] `DeerLoopEngine` 不再直接实现完整 `AgentSessionLike`。
- [ ] 对仍需兼容 pi 风格字段的地方增加临时 adapter，例如 `LegacyAgentSessionAdapter`。
- [ ] 在 adapter 中明确标注迁移边界和删除计划。

#### 验收标准

- [ ] `AgentEnginePort` 不再 `extends AgentSessionLike`。
- [ ] `DeerLoopEngine` 不再提供无意义旧字段。
- [ ] `rpc-manager.ts` 只依赖明确端口能力。
- [ ] TypeScript 类型检查通过。

---

### P0-2：修复 `DeerLoopEngine.sessionFile`

#### 当前问题

当前 `lib/engine/deer-loop.ts`：

```ts
get sessionFile(): string | undefined {
  return undefined;
}
```

但 `startDeerLoopSession()` 已经创建了真实 `SessionManager`。

#### TODO

- [ ] 修改 `DeerLoopEngine.sessionFile`：

```ts
get sessionFile(): string | undefined {
  return this._sessionManager?.getSessionFile?.() ?? undefined;
}
```

- [ ] 同步更新注释，删除或改写 “M1 不持久化” 的旧描述。
- [ ] 增加测试：新建 session 后 `get_state.sessionFile` 非空。
- [ ] 增加测试：fork 不再触发 `Persisted session is missing a session file`。

#### 验收标准

- [ ] `get_state` 返回真实 `sessionFile`。
- [ ] fork 能正常拿到当前 session 文件。
- [ ] session reader / cache 行为稳定。

---

### P0-3：统一 `sessionId` / `realSessionId` / `tempKey` 身份体系

#### 当前问题

当前 `startRpcSession()` 入口按传入 `sessionId` 查 registry：

```ts
const existing = registry.get(sessionId);
```

但创建成功后按真实 id 注册：

```ts
getRegistry().set(realSessionId, wrapper);
```

subagent worker 又会生成临时 key：

```ts
const tempKey = existingSessionId ?? `__collab__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

可能出现第一次用 tempKey 创建真实 session，第二次仍用 tempKey 查询失败，导致重复创建。

#### TODO

- [ ] 明确定义身份模型：

| 名称 | 含义 |
|---|---|
| `requestedSessionKey` | 调用方传入的 key，可为临时 key |
| `realSessionId` | `SessionManager.getSessionId()` 返回的真实 id |
| `sessionFile` | jsonl 文件路径 |
| `parentSessionId` | 父会话 id |
| `workerSessionId` | 子 Agent 真实会话 id |

- [ ] 给 registry 增加 alias 支持。
- [ ] 短期可采用双写方案：

```ts
registry.set(requestedSessionKey, wrapper);
registry.set(realSessionId, wrapper);
```

- [ ] destroy 时同时删除 alias 和 real id。
- [ ] start lock 也要考虑 alias，避免并发重复创建。
- [ ] subagent worker 注册时全部使用真实 `realSessionId`。
- [ ] `resolveSessionPath()` / `cacheSessionPath()` 统一以 `realSessionId` 为主。

#### 验收标准

- [ ] 同一个 tempKey 重复进入不会重复创建 session。
- [ ] sidebar 不出现重复 worker session。
- [ ] continue worker 能稳定找到历史 worker sessionFile。
- [ ] EventStore、SessionReader、SubagentRegistry id 一致。

---

## 3. P1 TODO

### P1-1：明确 subagent 默认激活策略

#### 当前问题

`subagentTool` 被注册进 `customTools`，但 `availableToolNames` 没有包含 `SUBAGENT_TOOL_NAME`。

当前 `lib/rpc-manager.ts`：

```ts
const availableToolNames = [
  ...allCodingToolNames,
  ...(codeSearchTool ? ["code_search"] : []),
  ...codeGraphTools.map(t => t.name),
  ...(mcpRuntime?.toolNames ?? []),
];
```

#### TODO

二选一。

##### 方案 A：默认启用 subagent

- [ ] `availableToolNames` 加入：

```ts
...(subagentTool ? [SUBAGENT_TOOL_NAME] : [])
```

- [ ] 默认 system prompt 的工具列表显示 subagent。
- [ ] UI 默认展示为可用工具。

##### 方案 B：默认注册但不启用 subagent

- [ ] 保持当前工具不默认激活。
- [ ] UI 明确显示 subagent 是开关工具。
- [ ] system prompt 不暗示 subagent 默认可用。
- [ ] 文档明确需通过 `set_subagent_enabled` 激活。

#### 建议

短期建议选择方案 B。原因是 subagent 当前仍存在并发放大风险，应先完成 P1-3 / P1-4 的资源限制，再考虑默认启用。

#### 验收标准

- [ ] `get_tools` 返回状态和 UI 一致。
- [ ] LLM 看到的工具列表与 active tools 一致。
- [ ] 不出现“已注册但 prompt 看不到”的隐性状态。

---

### P1-2：修复 `ToolExecutor` 源序执行问题

#### 当前问题

当前 `lib/engine/tool-executor.ts` 执行策略是：

1. 先执行所有 sequential 工具。
2. 再执行所有 parallel 工具。

这会改变 LLM 发出的 toolCall 副作用顺序。例如 LLM 发出：

```txt
read A
edit A
```

当前可能变成：

```txt
edit A
read A
```

#### TODO

- [ ] 改为按源序切 segment 执行：

```txt
parallel segment 并发
sequential tool 单独执行
parallel segment 并发
sequential tool 单独执行
```

- [ ] 示例行为：

```txt
read A
grep B
edit C
read D
write E
```

应执行为：

```txt
[read A, grep B] 并发
edit C 串行
read D 并发
write E 串行
```

- [ ] 保持返回结果仍按原始 toolCall 顺序。
- [ ] 更新文件头注释，删除 sequential-first 的旧描述。
- [ ] 增加单测：`read → edit` 不应变成 `edit → read`。
- [ ] 增加单测：`read → edit → read` 应分段执行。
- [ ] 增加单测：outputs 返回顺序保持源序。

#### 验收标准

- [ ] 工具副作用顺序与 LLM 源序一致。
- [ ] parallel 工具仍可在连续 segment 内并发。
- [ ] 结果回填顺序不变。

---

### P1-3：限制 subagent 并发放大

#### 当前问题

当前：

- `subagent` tool 是 `executionMode: "parallel"`
- 一个主 Agent turn 可并发多个 subagent toolCall
- 每个 subagent run 内部又可能 `Promise.all(workers)` 并发 worker

放大结构：

```txt
1 个主 Agent turn
  → N 个 subagent toolCall 并发
    → 每个 subagent run 里 M 个 worker 并发
      → 每个 worker 一个 AgentSession
        → 每个 AgentSession 多轮 LLM 调用
```

#### TODO

- [ ] 增加主 turn 级限制：单个主 turn 最多允许 1 个或 2 个 subagent toolCall。
- [ ] 超过主 turn 限制时返回工具错误，不创建 run。
- [ ] 增加单 run worker 限制，例如 `MAX_WORKERS_PER_RUN = 3` 或 `5`。
- [ ] 增加全局 worker 并发限制，例如 `GLOBAL_SUBAGENT_WORKER_LIMIT = 4`。
- [ ] 增加单项目 worker 并发限制，例如 `PROJECT_SUBAGENT_WORKER_LIMIT = 3`。
- [ ] 超限时不创建 session。
- [ ] 超限时不创建 worktree。
- [ ] 超限错误中返回：当前运行数、最大允许数、建议用户拆分任务或稍后重试。
- [ ] 增加日志或指标：active run 数、active worker 数、rejected worker 数、timeout / abort 数。

#### 验收标准

- [ ] 同一轮多个 subagent toolCall 不会无限 fan-out。
- [ ] worker 创建数受控。
- [ ] 超限时没有半创建的 session / worktree 泄漏。

---

### P1-4：限制用户传入的 `params.workers`

#### 当前问题

`llm-planner.ts` 内部有数量限制，但用户显式传入 `params.workers` 时，`subagent-tool.ts` 只过滤空值，不限制数量。

#### TODO

- [ ] 在 `lib/parallel-agent/subagent-tool.ts` 增加硬限制：

```ts
const MAX_WORKERS_PER_RUN = 5;
```

或更保守：

```ts
const MAX_WORKERS_BY_MODE = {
  ask: 3,
  review: 3,
  parallel: 3,
  code: 3,
};
```

- [ ] 超限时直接返回工具错误，不静默截断。
- [ ] 错误文案说明最大允许值。
- [ ] 同步 `llm-planner.ts` 的限制，避免 planner 和工具层限制不一致。

#### 验收标准

- [ ] 传入大量 workers 不会创建大量 session。
- [ ] 错误可被主 Agent 看见。
- [ ] planner 和手动 workers 行为一致。

---

### P1-5：显式化 subagent worker 生命周期与 continue 能力

#### 当前问题

`executeCollaborationRun()` 终态后会销毁 worker sessions，但 `continueCollaborationWorker()` 后续又依赖：

- `worker.sessionId`
- `resolveSessionPath(worker.sessionId)`
- jsonl 文件仍存在
- worktree 仍存在
- run state 仍存在
- subagent registry 记录一致

当前分析模式 run 终态后会立即 remove，isolated coding 模式保留 worktree 2 小时，但 continue 能力和清理策略仍未显式统一。

#### TODO

- [ ] 给 worker 增加生命周期字段：

```ts
workerSessionState:
  | "running"
  | "complete_memory_destroyed"
  | "reopenable_from_jsonl"
  | "expired"
  | "deleted"
```

- [ ] 给 run / worker 增加：

```ts
canContinue: boolean;
continueUnavailableReason?: string;
continueExpiresAt?: string;
```

- [ ] `scheduleRunReclaim()` 更新 worker 状态，而不是只删除 Map。
- [ ] `continueCollaborationWorker()` 开始前检查：
  - [ ] run 是否存在
  - [ ] worker session file 是否存在
  - [ ] worktree 是否存在
  - [ ] 是否过期
  - [ ] worker 是否已 applied / deleted
- [ ] API 返回明确不可继续原因。
- [ ] 对 analysis 模式明确选择：
  - [ ] 如果要支持 continue，就不能终态立即 `removeCollaborationRun`。
  - [ ] 如果不支持 continue，就 API 明确返回不可继续。

#### 验收标准

- [ ] 用户点击 continue 时，要么成功 reopen，要么收到明确原因。
- [ ] 不依赖 jsonl / worktree 恰好没被清理的隐式状态。
- [ ] 清理策略和 continue 语义一致。

---

### P1-6：文件变更事件优先消费 `changedFiles[]`

#### 当前问题

`ToolExecutor` 已经在 `tool_execution_end` 发出：

```ts
changedFiles: output.changedFiles
```

但 `rpc-manager.ts` 仍通过多个旧字段猜单个路径：

```ts
filePath
path
file_path
args.file_path
args.path
input.file_path
input.path
result.filePath
result.path
result.file_path
```

#### TODO

- [ ] 在 `AgentSessionWrapper.start()` 中处理 `tool_execution_end` 时，优先读取 `event.changedFiles`。
- [ ] 对 `changedFiles` 中每个文件发一个 `agent_file_changed`。
- [ ] 旧字段猜测逻辑保留为 fallback。
- [ ] 同一个 `tool_execution_end` 内重复路径去重。
- [ ] 相对路径基于当前 cwd resolve。
- [ ] 绝对路径 normalize。

#### 验收标准

- [ ] `edit` / `write` / `bash` 返回多个 changedFiles 时，前端收到多个 `agent_file_changed`。
- [ ] 旧工具没提供 `changedFiles` 时仍可 fallback。
- [ ] 不漏报多文件修改。

---

### P1-7：收口 `modelRegistry` 空代理

#### 当前问题

当前 `DeerLoopEngine.modelRegistry`：

```ts
return {
  find: () => undefined,
};
```

`AgentSessionWrapper` 设置模型时只能 fallback 创建新的 `ModelRegistry`。

#### TODO

二选一。

##### 方案 A：Engine 注入真实 modelRegistry

- [ ] `DeerLoopOptions` 增加 `modelRegistry`。
- [ ] `startDeerLoopSession()` 把真实 `modelRegistry` 注入 engine。
- [ ] `DeerLoopEngine.modelRegistry` 返回真实 registry。

##### 方案 B：移除 Engine 的 modelRegistry 职责

- [ ] 从 `AgentEnginePort` 删除 `modelRegistry`。
- [ ] `AgentSessionWrapper` 通过独立 `ModelService` 切换模型。
- [ ] `DeerLoopEngine` 只暴露 `setModel(model)` 和 `model`。

#### 建议

短期先做方案 A，改动小；长期结合 P0-1 做方案 B。

#### 验收标准

- [ ] `set_model` 不再依赖空代理 + fallback。
- [ ] model 查找逻辑只有一个明确入口。
- [ ] custom model 新增后行为稳定。

---

## 4. P2 TODO

### P2-1：`ToolResultMessage` 回填 `details`

#### 当前问题

当前 `buildToolResultMessages()` 只回填：

- `role`
- `toolCallId`
- `toolName`
- `content`
- `isError`
- `timestamp`

没有回填工具结果里的 `details`。

#### TODO

- [ ] 修改 `lib/engine/deer-loop.ts`：

```ts
details: output?.result?.details,
```

- [ ] 保持 `undefined` 时不影响序列化。
- [ ] 增加测试：工具返回 details。
- [ ] 增加测试：下一轮 LLM context 里能看到 details。

#### 验收标准

- [ ] `ToolResultMessage` 保留结构化 `details`。
- [ ] subagent progress / codegraph / MCP 工具的结构化结果不丢失。

---

### P2-2：更新 `DeerLoopEngine` 文件头注释

#### 当前问题

`lib/engine/deer-loop.ts` 文件头仍写：

```txt
M1 不做：工具调用循环、工具注册、重试、steering/followUp 队列、session 持久化、压缩。
```

但当前代码已经实现这些能力。

#### TODO

- [ ] 更新文件头注释。
- [ ] 明确当前已实现：
  - [ ] prompt 流式
  - [ ] 工具调用循环
  - [ ] 工具注册
  - [ ] 工具执行模式
  - [ ] 自动重试
  - [ ] steering / followUp
  - [ ] session 持久化
  - [ ] compact
- [ ] 明确仍待完善：
  - [ ] port 边界收口
  - [ ] session identity
  - [ ] changedFiles 事件契约
  - [ ] subagent 并发限制
  - [ ] modelRegistry 边界

#### 验收标准

- [ ] 注释与实际能力一致。
- [ ] 后续维护者不会被 M1 旧描述误导。

---

## 5. 推荐执行顺序

### 第一批：低风险、立刻修

- [ ] P0-2 修复 `sessionFile`
- [ ] P2-1 回填 `ToolResultMessage.details`
- [ ] P2-2 更新文件头注释
- [ ] P1-6 `changedFiles[]` 事件收口

原因：改动小、收益高、风险低。

### 第二批：行为正确性

- [ ] P1-2 修复 `ToolExecutor` 源序分段执行
- [ ] P1-4 限制 `params.workers` 数量
- [ ] P1-3 subagent 并发限制

原因：直接影响文件修改安全、成本和稳定性。

### 第三批：身份和生命周期

- [ ] P0-3 session identity / alias 统一
- [ ] P1-5 worker 生命周期显式化

原因：涉及 registry、session-reader、subagent registry，改动面较大，需要谨慎验证。

### 第四批：架构收口

- [ ] P1-7 modelRegistry 收口
- [ ] P1-1 subagent 默认激活策略确认并落地
- [ ] P0-1 AgentEnginePort 拆分

原因：涉及架构边界，最好在行为问题修完后再做，避免同时改太多导致回归难定位。

---

## 6. 建议任务包 / PR 拆分

### PR 1：基础契约修复

- [ ] `sessionFile`
- [ ] `ToolResultMessage.details`
- [ ] 文件头注释
- [ ] `changedFiles[]`

### PR 2：工具执行安全

- [ ] `ToolExecutor` 源序分段执行
- [ ] 单测覆盖 `read/edit/write` 顺序

### PR 3：subagent 资源治理

- [ ] workers 数量上限
- [ ] subagent toolCall 上限
- [ ] 全局 / 项目 worker 并发限制
- [ ] 超限错误返回

### PR 4：session / port 架构收口

- [ ] session alias
- [ ] worker 生命周期
- [ ] modelRegistry 边界
- [ ] 最后拆 `AgentEnginePort`
