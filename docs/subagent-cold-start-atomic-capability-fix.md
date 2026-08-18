# Subagent 冷启动与首轮原子激活修复开发文档

## 0. 文档用途

本文档用于交给一个**没有任何历史对话上下文**的编程 Agent，独立完成 DeerHux 的 Subagent 工具激活修复。

开始开发前必须阅读：

- 仓库根目录 `AGENTS.md`
- 本文档

本文档描述的是待实施方案，不代表代码已经修改。

---

## 1. 任务目标

修复以下问题：

> UI 已开启 Subagent 能力时，新会话首轮或已有会话冷启动后的首轮，模型可能收不到 `subagent` 工具；会话挂载后再次查看当前系统提示词，却又能看到 `subagent`。

修复后必须满足：

1. 新会话第一轮可可靠使用 `subagent`。
2. 已有会话的运行时 Wrapper 被回收后，下一次冷启动首轮仍可可靠使用 `subagent`。
3. Node/Next.js 进程重启、热重载、浏览器刷新、SSE 尚未连接时，不影响下一轮 Subagent 能力。
4. 正确性不依赖 `connectEvents()` 中 fire-and-forget 的 `set_subagent_enabled` 请求。
5. 本轮使用的能力必须在 `TurnContextSnapshot` 冻结前确定。
6. `subagent` 的已注册工具、可用工具名和激活工具名三层状态保持一致。
7. Ask/Plan 只读模式不得通过 Subagent 绕过只读限制。
8. 不破坏 prompt 幂等、并发准入、停止、恢复、follow-up 和 steer 的现有行为。
9. 历史消息旁的系统提示词 UI 不得继续暗示它是该历史回合的真实快照。

---

## 2. 当前问题的可观察现象

复现步骤：

1. 在 UI 中开启 Subagent 开关，浏览器 localStorage 中存在：

   ```text
   deerhux.subagent-enabled=true
   ```

2. 创建一个新会话。
3. 第一条消息要求使用 Subagent。
4. 第一轮模型可能判断没有暴露 `subagent` 工具。
5. 等新会话创建完成后，点击消息旁的系统提示词，当前提示词里又能看到 `subagent`。

这两个现象不矛盾：

- 第一轮模型看到的是回合准入时冻结的工具 schema。
- UI 后来展示的是会话**当前**的可变 `systemPrompt`。
- 前端拿到真实 session id 后才补发 `set_subagent_enabled`，因此稍后的当前提示词已经发生变化。

---

## 3. 根因

### 3.1 前端保存了开关，但新会话请求没有携带

文件：`hooks/useAgentSession.ts`

当前开关来自 localStorage：

```ts
const [subagentEnabled, setSubagentEnabledState] = useState<boolean>(() => {
  if (typeof window === "undefined") return false;
  return getLocalStorageItem("deerhux.subagent-enabled") === "true";
});
const subagentEnabledRef = useRef(subagentEnabled);
```

但是 `/api/agent/new` 请求体没有携带该值。

### 3.2 新会话 API 在返回真实 session id 前已经启动第一轮

文件：`app/api/agent/new/route.ts`

当前流程：

```text
startRpcSession()
  -> 创建 Wrapper
  -> session.send(promptCommand)
  -> 首轮上下文冻结并启动模型
  -> HTTP 返回 realSessionId
```

前端只有拿到 `realSessionId` 后才能执行：

```text
connectEvents(realSessionId)
  -> fire-and-forget set_subagent_enabled
```

因此，对新会话首轮来说，这不只是偶发竞态，而是错误的固定顺序。

### 3.3 已有会话冷启动也存在竞态

文件：`app/api/agent/[id]/route.ts`

已有会话请求会先执行：

```ts
const session = await ensureRpcSession(id);
const result = await session.send(body, commandSignal);
```

如果前端只依赖 `connectEvents()` 异步同步开关，则 Wrapper 冷启动后的 prompt 与 `set_subagent_enabled` 之间没有顺序保证。

### 3.4 Subagent 已注册，但初始未激活

文件：`lib/engine/deer-loop-composition.ts`

`subagentTool` 被加入 `tools`，因此它是已注册工具；但 Agent 模式默认工具名列表不含 `subagent`，所以首轮激活名单通常不含它。

### 3.5 `availableToolNames` 漏掉 Subagent

同一文件中，当前 `availableToolNames` 包含标准工具、CodeGraph、MCP，却没有包含已创建的 `subagentTool`。

后果：显式传入 `toolNames: ["subagent"]` 时，`computeActiveToolNames()` 也可能把它过滤掉。

### 3.6 工具集合在回合开始前被冻结

文件：`lib/rpc-manager.ts`

`buildFrozenTurnContext()` 会保存：

```ts
activeToolNames: Object.freeze([...this.inner.getActiveToolNames()])
```

文件：`lib/engine/deer-loop.ts`

模型请求只收到该回合冻结后的 active tools。因此，在冻结后再调用 `set_subagent_enabled` 对当前回合无效，这是正确的隔离设计，不应改成运行中动态污染当前回合。

---

## 4. 修复设计

### 4.1 核心原则

每个会启动新模型回合的客户端命令都必须携带能力快照：

```ts
capabilities: {
  subagent: boolean;
}
```

后端必须在同一个 `AgentSessionWrapper.send()` 准入流程中完成：

```text
幂等检查
  -> busy/stop 检查
  -> 应用本轮 capabilities
  -> 准备输入
  -> 冻结 effectiveSystemPrompt 和 activeToolNames
  -> 启动模型
```

禁止使用两个独立请求保证正确性：

```ts
// 禁止作为正确性方案
await session.send({ type: "set_subagent_enabled", enabled: true });
await session.send({ type: "prompt", message });
```

必须使用一个原子命令：

```ts
await session.send({
  type: "prompt",
  message,
  capabilities: { subagent: true },
});
```

### 4.2 为什么使用 `capabilities` 而不是裸字段

推荐协议：

```ts
capabilities?: {
  subagent?: boolean;
};
```

原因：

- 表意为本轮能力快照，而不是普通 UI 状态。
- 后续可以扩展 browser、network、MCP 等能力。
- 避免 command 顶层继续堆积布尔字段。

如果实现者为了最小改动选择 `subagentEnabled`，必须仍然满足全部时序和测试要求；但优先采用 `capabilities.subagent`。

### 4.3 状态来源与优先级

- UI 发起的新回合：以请求中的 `capabilities.subagent` 为本轮权威值。
- 请求未携带该字段：保持当前 Wrapper 状态，兼容 Scheduler、机器人、旧客户端。
- `set_subagent_enabled`：继续用于 UI 预热和显式切换会话状态，但不再承担 prompt 正确性。
- 子 Agent Worker：`allowSubagentTool: false`，不得递归暴露 Subagent。

不要把 localStorage 状态持久化到 session JSONL；它是客户端偏好，必须通过每轮命令传递。外部客户端若需要 Subagent，也必须显式传 capability 或现有工具配置。

---

## 5. 逐文件修改要求

## 5.1 `hooks/useAgentSession.ts`

### 5.1.1 新增统一能力快照构造

避免每个调用点手写不同结构。可在 hook 内增加：

```ts
const getTurnCapabilities = useCallback(() => ({
  subagent: subagentEnabledRef.current,
}), []);
```

也可以直接构造对象，但所有入口必须一致。

### 5.1.2 修改所有新会话 prompt 请求

当前文件至少存在两个 `/api/agent/new` 的 prompt 请求路径：

- 普通新会话首轮发送
- 重发/恢复输入时在尚无 session id 的新会话发送

每个请求体加入：

```ts
capabilities: {
  subagent: subagentEnabledRef.current,
},
```

### 5.1.3 修改已有会话普通 prompt

所有：

```ts
sendAgentCommand(sid, {
  type: "prompt",
  ...
})
```

必须携带同一能力快照。

必须覆盖：

- 普通发送
- resend/重新发送
- 新会话创建失败重试后转入已有 session 的路径

不要只修 `/api/agent/new`，否则已有会话 Wrapper 冷启动仍可能失败。

### 5.1.4 修改 `recover`

`recover` 会在旧回合 settle 后启动一个全新的 prompt 回合，因此必须携带：

```ts
capabilities: {
  subagent: subagentEnabledRef.current,
},
```

### 5.1.5 修改 `follow_up`

`follow_up` 可能：

- 在当前回合运行中排队，携带自己的不可变 context；
- 在当前回合已停止时直接启动新 prompt。

因此必须携带能力快照，后端应在构造该 follow-up 的 `frozenContext` 前应用。

### 5.1.6 修改 `steer`

`steer` 不得改变已冻结并正在执行的当前模型请求，但它会构造自己的 `TurnContextSnapshot`。为保证它携带的后续上下文与 UI 能力一致，也应传入 capability。

后端应用 capability 后，只允许影响 steer 自己的 context 和未来回合；不得改变当前正在执行回合已经冻结的工具 Map。

### 5.1.7 保留 `connectEvents()` 同步

保留：

```ts
void sendAgentCommand(sid, {
  type: "set_subagent_enabled",
  enabled: subagentEnabledRef.current,
}).catch(() => {});
```

它现在只是：

- 会话挂载后的预热；
- 用户尚未发送消息时，让当前系统提示词和工具面板尽快同步。

即使该请求失败、延迟或 SSE 未连接，下一次 prompt 也必须因自身携带 capability 而正确。

### 5.1.8 注意 Hook 闭包

部分 callbacks 当前依赖数组为 `[]`。使用 `subagentEnabledRef.current` 不要求把 state 加入依赖，也不会捕获旧值。不要改成直接读取可能陈旧的 `subagentEnabled` state，除非正确更新依赖数组。

---

## 5.2 `app/api/agent/new/route.ts`

### 5.2.1 不要拆成单独的设置命令

API route 应保留 `capabilities` 在 `promptCommand` 中，并让：

```ts
session.send(promptCommand, commandSignal)
```

原子处理。

不要在 route 中实现：

```ts
await session.send({ type: "set_subagent_enabled", ... });
await session.send(promptCommand);
```

两个 send 之间存在未来并发、重试和维护风险，也破坏能力与 prompt 的单命令语义。

### 5.2.2 检查解构逻辑

当前 route 会从 command 中解构 provider、modelId、toolNames、thinkingLevel、roleId、agentMode，然后把其余字段放入 `promptCommand`。

确保 `capabilities` 没有被意外丢弃，最终原样进入 `session.send(promptCommand)`。

建议增加请求类型，而不是继续完全依赖宽泛的：

```ts
{ [key: string]: unknown }
```

类型至少应表达：

```ts
type TurnCapabilities = {
  subagent?: boolean;
};
```

---

## 5.3 `app/api/agent/[id]/route.ts`

通常不需要业务逻辑修改，因为它已经把 body 原样传给：

```ts
session.send(body, commandSignal)
```

但必须确认：

- `capabilities` 不被校验层删除；
- 冷启动的 `ensureRpcSession(id)` 完成后，同一个 body 仍传给新 Wrapper；
- 不新增 route 层的独立 `set_subagent_enabled` 请求。

如项目存在共享 command 类型，应在此处使用该类型。

---

## 5.4 `lib/rpc-manager.ts`

这是核心修改点。

### 5.4.1 增加能力类型与安全解析

建议定义：

```ts
interface TurnCapabilities {
  subagent?: boolean;
}
```

复用现有 `isRecord()`，安全读取：

```ts
private readTurnCapabilities(command: Record<string, unknown>): TurnCapabilities {
  const value = command.capabilities;
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.subagent === "boolean"
      ? { subagent: value.subagent }
      : {}),
  };
}
```

非法类型必须忽略或返回 400；不得使用 `Boolean(value)`，否则字符串 `"false"` 会被错误视为 true。

### 5.4.2 抽取唯一的 Subagent 状态应用方法

将当前 `set_subagent_enabled` 中的逻辑抽成单一方法，例如：

```ts
private setSubagentEnabled(enabled: boolean): void {
  this._subagentEnabled = enabled;
  this.applySubagentToActiveTools();
  this.baseSystemPrompt = stripModePrompt(
    stripTurnContextBlock(this.inner.systemPrompt),
  );
  this.applyRolePrompt();
}
```

要求：

- `set_subagent_enabled` 命令调用它；
- 回合 capability 应用也调用它；
- 不复制 active tools 和 prompt 重建逻辑。

可做等值短路，但短路前要确保 active tool 实际状态与 `_subagentEnabled` 没有漂移。最安全的是仍调用 `applySubagentToActiveTools()`，然后只在工具集合确有变化时重建 prompt；若不做优化，正确性优先。

### 5.4.3 增加回合能力应用方法

例如：

```ts
private applyTurnCapabilities(command: Record<string, unknown>): void {
  const capabilities = this.readTurnCapabilities(command);
  if (typeof capabilities.subagent === "boolean") {
    this.setSubagentEnabled(capabilities.subagent);
  }
}
```

请求未提供字段时必须保持当前状态，不能默认关闭，避免破坏旧客户端与服务端入口。

### 5.4.4 prompt 的原子顺序

在 `case "prompt"` 中必须遵循：

1. 先做 `clientMessageId` 幂等检查。
2. 如果已经接受过或存在 pending admission，直接返回 duplicate，不得让重试请求修改已经接受回合的 capability。
3. 再做 busy/stop 检查。
4. 准入成功后、创建/冻结回合上下文前调用 `applyTurnCapabilities(command)`。
5. 再进入 `commitAndTrackPromptTurn()`。

建议位置：busy guard 通过后、设置 `_turnActive` 前后均可，但必须在 `commitAndTrackPromptTurn()` 之前，并处于该 prompt 的同一同步准入路径。

推荐伪代码：

```ts
case "prompt": {
  const clientMessageId = ...;

  // 1. 幂等重复直接返回，不修改已接受回合
  if (clientMessageId) {
    const duplicate = ...;
    if (duplicate) return duplicate;
  }

  // 2. 防并发
  if (this.isTurnBusy() || this._stopRequested) {
    throw new Error("AGENT_BUSY: ...");
  }

  // 3. 本轮能力与准入原子应用
  this.applyTurnCapabilities(command);

  // 4. 后续 prepare -> buildFrozenTurnContext -> engine.prompt
  ...
}
```

不要在 API route、异步 `prepareTurnContext()` 完成后或 `buildFrozenTurnContext()` 之后才应用。

### 5.4.5 recover

`recover` 在：

```ts
await this.abortAndSettleCurrentTurn();
```

之后启动新回合。

应在旧回合已经 settle、且新回合调用 `commitAndTrackPromptTurn()` 之前应用：

```ts
this.applyTurnCapabilities(command);
```

这样不会中途修改正在停止的旧回合语义，又保证新回合冻结正确。

### 5.4.6 follow_up

在 `prepareTurnContext()` 和 `buildFrozenTurnContext()` 之前应用 capability。

注意：如果当前回合正在运行，`follow_up` 会排队。当前运行回合已经持有冻结工具 Map，因此修改 registry 不得回写当前回合；排队 follow-up 使用自己的 frozen context。

### 5.4.7 steer

在构造 steer 自己的 `TurnContextSnapshot` 之前应用 capability。不得尝试替换当前运行回合已经冻结的工具 Map。

### 5.4.8 Ask/Plan 权限封口

修改 `applySubagentToActiveTools()`：

```ts
const shouldEnable =
  this._subagentEnabled && !isReadOnlyAgentMode(this.agentMode);
```

仅当 `shouldEnable` 为 true 时把 `subagent` 加入 active tools，否则移除。

理由：Subagent worker 可能使用写工具。Ask/Plan 模式若仍暴露 Subagent，会形成权限绕过。

模式切换时已有 `applySubagentToActiveTools()` 调用，必须验证：

- Agent + 开关开：激活 Subagent；
- Ask/Plan + 开关开：不激活；
- 从 Ask/Plan 切回 Agent：恢复激活；
- 开关关：所有模式都不激活。

### 5.4.9 `get_state` 增加可观测状态

建议在 `get_state` 返回中增加：

```ts
capabilities: {
  subagent: this._subagentEnabled,
},
activeToolNames: this.inner.getActiveToolNames(),
```

用途：

- UI 与诊断能区分用户偏好和实际 active tools；
- 冷启动测试可直接断言；
- Ask/Plan 下可以看到偏好为 true、实际工具未激活，这是预期状态。

不要把 `_subagentEnabled` 本身等同于实际激活状态；实际状态还受 AgentMode 和工具是否注册影响。

---

## 5.5 `lib/engine/deer-loop-composition.ts`

### 5.5.1 补齐导入

改为导入工具名：

```ts
import {
  createSubagentTool,
  SUBAGENT_TOOL_NAME,
} from "../parallel-agent/subagent-tool";
```

### 5.5.2 补齐 `availableToolNames`

加入：

```ts
...(subagentTool ? [SUBAGENT_TOOL_NAME] : []),
```

目标结构：

```ts
const availableToolNames = [
  ...STANDARD_CODING_TOOL_NAMES,
  ...(codeSearchTool ? ["code_search"] : []),
  ...codeGraphTools.map((tool) => tool.name),
  ...(subagentTool ? [SUBAGENT_TOOL_NAME] : []),
  ...(mcpRuntime?.toolNames ?? []),
];
```

### 5.5.3 不要默认激活 Subagent

补入 `availableToolNames` 只表示它可以被选择，不表示默认启用。

不要把 `subagent` 直接加入：

- `AGENT_TOOL_NAMES`
- `PRESET_DEFAULT`
- `PRESET_FULL`

是否激活仍由独立 Subagent capability 控制。

### 5.5.4 Worker 防递归

文件：`lib/parallel-agent/subagent-runner.ts` 当前创建 worker 时使用：

```ts
{ allowSubagentTool: false, ... }
```

必须保留。测试需要验证 worker 的所有工具和 active tools 都不含 `subagent`。

---

## 5.6 `components/MessageView.tsx`

当前同一个会话级 `systemPrompt` 被传给历史用户消息，容易被误解为该历史回合的真实 prompt。

本任务先做低风险文案修复：

- 按钮/标题从 `系统提示词` 改为 `当前系统提示词`；
- 弹窗增加说明：

  ```text
  这是会话当前配置，不一定等于该历史回合发送时使用的系统提示词和工具集合。
  ```

不要在本任务中把完整 system prompt 写入每条 JSONL。历史快照持久化涉及体积、去重、隐私和迁移，应另立任务。

---

## 5.7 类型定义

优先在共享位置定义并复用：

```ts
export interface TurnCapabilities {
  subagent?: boolean;
}
```

如果当前 command 没有统一类型，可先在 `lib/rpc-manager.ts` 和前端附近使用局部类型，但不能使用不受约束的类型断言掩盖错误。

能力对象需要满足：

- 可选，兼容旧客户端；
- 字段也是可选；
- 只接受真正的 boolean；
- 后续可扩展。

---

## 6. 冷启动保证说明

完成上述修改后，已有会话冷启动流程应为：

```text
浏览器保存 subagent=true
  -> 用户发送 prompt，command 自带 capabilities.subagent=true
  -> POST /api/agent/[id]
  -> ensureRpcSession(id) 冷创建 Wrapper
  -> composeDeerLoopEngine() 注册 subagent
  -> session.send(command)
  -> 幂等与 busy 检查
  -> applyTurnCapabilities(command)
  -> active tools 加入 subagent
  -> 重建当前 system prompt
  -> buildFrozenTurnContext()
  -> DeerLoopEngine 收到含 subagent 的 frozen tool map
  -> LLM tools schema 含 subagent
```

该流程不依赖：

- SSE 是否连接；
- `connectEvents()` 是否完成；
- Wrapper 是否曾经存在；
- Node 进程是否重启；
- 当前 system prompt UI 是否已刷新。

保证边界：

| 场景 | 预期 |
|---|---|
| 新会话第一轮 | 可用 |
| 已有会话 Wrapper 空闲回收后首轮 | 可用 |
| Node/Next.js 重启后首轮 | 可用 |
| 浏览器刷新后首轮 | 可用 |
| SSE 未连接 | 可用 |
| `connectEvents()` 同步失败 | 可用 |
| Agent 模式且开关关闭 | 不可用 |
| Ask/Plan 模式且偏好开启 | 不可用，防权限绕过 |
| Subagent worker 内 | 不可用，防递归 |
| Scheduler/外部 API 未传 capability | 保持旧行为，不承诺自动开启 |
| Scheduler/外部 API 显式传 capability | 按 capability 生效 |

---

## 7. 并发和幂等约束

### 7.1 同一 session 并发 prompt

现有 Wrapper 用 busy guard 和 Engine mutex 拒绝并发 prompt。能力应用必须在 busy guard 通过后进行，否则一个被拒绝的请求不应改变另一个正在运行回合之后的会话能力。

错误顺序：

```ts
this.applyTurnCapabilities(command);
if (this.isTurnBusy()) throw ...;
```

正确顺序：

```ts
if (this.isTurnBusy()) throw ...;
this.applyTurnCapabilities(command);
```

### 7.2 clientMessageId 重试

同一 `clientMessageId` 的重试必须返回已接受结果，不得用重试请求中的 capability 修改原回合。

因此能力应用必须位于 duplicate 检查之后。

### 7.3 当前回合冻结不变量

一旦 `buildFrozenTurnContext()` 完成：

- `set_subagent_enabled`
- UI 切换开关
- MCP reload
- mode 切换

都只能影响后续回合，不能影响正在执行的回合。

不要修改 `DeerLoopEngine` 的冻结工具 Map 机制来规避本 Bug。

---

## 8. 测试计划

优先新增聚焦测试脚本，例如：

```text
scripts/test-subagent-capability.ts
```

并加入 `package.json` 的 `test:core`。

如果完整 Wrapper 难以实例化，应提取可测试的纯函数/小方法，并增加 composition-policy 与 Wrapper 行为测试。不得只做字符串 grep 测试。

### 8.1 Composition 注册一致性

断言主 Agent：

- `getAllTools()` 包含 `subagent`；
- `availableToolNames` 允许 `subagent`；
- 显式选择 `subagent` 不会被 `computeActiveToolNames()` 过滤。

断言 Worker：

- `allowSubagentTool: false` 时不注册 `subagent`。

### 8.2 新会话首轮开启

输入：

```ts
{
  type: "prompt",
  capabilities: { subagent: true },
}
```

断言在首次调用 LLM 前：

```ts
frozenContext.activeToolNames.includes("subagent") === true
```

并断言实际传给 LLM 的 `context.tools` 包含 `subagent`，不能只断言 system prompt 文本。

### 8.3 新会话首轮关闭

输入 `subagent: false`，断言：

- frozen active tools 不含 `subagent`；
- LLM tool schema 不含 `subagent`；
- 当前提示词工具列表不含 `subagent`。

### 8.4 已有会话冷启动

测试必须模拟：

1. 没有存活 Wrapper；
2. 从已有 JSONL 创建新 Wrapper；
3. 不调用 `set_subagent_enabled`；
4. 直接发送携带 capability 的 prompt。

断言首轮 LLM tools 包含 `subagent`。

这是本任务最关键的回归测试。

### 8.5 不依赖 connectEvents

不执行任何会话挂载预热命令，直接 prompt，断言仍正确。

### 8.6 幂等重试

1. 首次 prompt：同一 `clientMessageId`，`subagent: true`；
2. 重试：同一 `clientMessageId`，`subagent: false`；
3. 断言返回 duplicate；
4. 原回合冻结能力保持 true；
5. 重试不改变已经接受的回合。

### 8.7 Busy 请求不污染状态

1. 回合 A 正在运行，capability=true；
2. 回合 B 并发发送，capability=false；
3. B 返回 `AGENT_BUSY`；
4. A 的冻结能力不变；
5. Wrapper 不得因被拒绝的 B 意外切换为 false。

### 8.8 Recover

旧回合结束后执行：

```ts
{
  type: "recover",
  capabilities: { subagent: true },
}
```

断言新 recovery 回合包含 `subagent`。

### 8.9 Follow-up

覆盖两种路径：

- 当前回合运行中：排队 follow-up 的 frozen context 含正确 capability；
- 当前回合已停止：直接启动的新 prompt 含正确 capability。

### 8.10 Steer

断言：

- 当前已冻结回合的 active tools 不被改变；
- steer 自己携带的 context 使用请求 capability；
- 不出现运行中工具 Map 被替换的问题。

### 8.11 Ask/Plan 权限

偏好开启时：

- Agent 模式 active tools 含 `subagent`；
- Ask 模式不含；
- Plan 模式不含；
- 切回 Agent 后恢复；
- `_subagentEnabled` 偏好仍可为 true。

### 8.12 UI 文案

增加轻量测试或静态契约检查，确保历史消息入口显示 `当前系统提示词` 和免责声明。

---

## 9. 验证命令

遵循 `AGENTS.md`，开发期间禁止运行 `next build`。

至少执行：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:core
```

如新增独立脚本，先单独执行：

```bash
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-subagent-capability.ts
```

然后执行完整 `npm run test:core`。

如果仓库当前存在与本任务无关的既有失败，必须在最终报告中区分：

- 本次修改引入的失败；
- 修改前已存在的失败。

不得运行：

```bash
next build
npm run build
```

---

## 10. 验收标准

全部满足才算完成：

- [ ] 所有 UI 新回合入口携带 `capabilities.subagent`。
- [ ] 新会话首轮不依赖 real session id 返回后的补发命令。
- [ ] 已有会话冷启动首轮不依赖 SSE 和 `connectEvents()`。
- [ ] capability 在 duplicate 和 busy 检查后、上下文冻结前应用。
- [ ] duplicate 重试不会修改已接受回合能力。
- [ ] busy 请求不会污染 Wrapper 能力。
- [ ] `recover`、`follow_up`、`steer` 的新 context 均覆盖。
- [ ] `availableToolNames` 包含注册成功的 `subagent`。
- [ ] `allowSubagentTool: false` 的 worker 不注册 Subagent。
- [ ] Ask/Plan 不暴露 Subagent。
- [ ] 当前运行回合的 frozen tool map 不会被后续开关修改。
- [ ] `get_state` 可区分 capability 偏好与实际 active tools。
- [ ] 历史消息 UI 标明展示的是当前系统提示词。
- [ ] TypeScript 类型检查通过。
- [ ] ESLint 通过，或仅有明确记录的既有问题。
- [ ] 新增聚焦测试通过。
- [ ] `npm run test:core` 通过，或仅有明确记录的既有问题。
- [ ] 未运行 `next build`。

---

## 11. 禁止采用的伪修复

以下方案都不完整，不得作为最终实现：

### 11.1 只给 `/api/agent/new` 加字段

只能修新会话，不能保证已有会话 Wrapper 冷启动。

### 11.2 只在 `connectEvents()` 中增加 `await`

新会话第一轮在 `/api/agent/new` 返回前已经启动；而且 SSE/挂载不应成为 prompt 正确性的依赖。

### 11.3 API route 先发 `set_subagent_enabled`，再发 prompt

两个独立命令不是原子准入，会增加重试和并发语义风险。

### 11.4 只补 `availableToolNames`

只能解决工具注册/选择名单不一致，不能同步 UI 开关。

### 11.5 把 `subagent` 永久加入 `AGENT_TOOL_NAMES`

会破坏用户开关语义，也可能造成 Ask/Plan 权限问题。

### 11.6 关闭回合工具冻结

冻结是防止运行中配置污染的正确设计。应修复冻结前的能力准入，而不是让运行中动态变更工具。

### 11.7 仅根据系统提示词字符串断言

模型真正可调用的工具来自 LLM 请求的 `context.tools`。提示词文本包含工具名不等于 schema 已暴露。

---

## 12. 建议实施顺序

1. 阅读 `AGENTS.md` 和相关文件。
2. 增加共享 `TurnCapabilities` 类型和安全解析。
3. 补齐 `availableToolNames`。
4. 在 Wrapper 中抽取 `setSubagentEnabled()` 和 `applyTurnCapabilities()`。
5. 修正 prompt 的 duplicate → busy → capability → freeze 顺序。
6. 覆盖 recover、follow_up、steer。
7. 前端所有新回合入口携带 capability。
8. 封住 Ask/Plan 权限绕过。
9. 增加 `get_state` 可观测字段。
10. 修改系统提示词 UI 文案。
11. 编写聚焦测试并加入 `test:core`。
12. 运行类型检查、lint 和测试。
13. 最终报告列出修改文件、冷启动保证、测试结果和未解决事项。

---

## 13. 最终交付报告模板

实施完成后，编程 Agent 应按以下结构汇报：

```md
## 已完成

- 原子 capability 协议：...
- 新会话首轮：...
- 已有会话冷启动：...
- recover/follow-up/steer：...
- Ask/Plan 权限：...
- UI 提示词标识：...

## 修改文件

- `path/to/file`: 修改说明

## 冷启动保证

说明为什么不依赖 SSE、connectEvents 和存活 Wrapper。

## 验证

- `node_modules/.bin/tsc --noEmit`: 结果
- `npm run lint`: 结果
- 聚焦测试: 结果
- `npm run test:core`: 结果

## 未解决或后续事项

- 如无，写“无”。
```
