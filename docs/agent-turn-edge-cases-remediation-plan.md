# Agent 回合边界问题修复方案

## 0. 文档用途

本文档用于交给一个**没有历史对话上下文**的编程 Agent，修复 DeerHux 当前回合调度、MCP 热重载、队列合并和 Abort 超时边界问题。

开始开发前必须阅读：

- 仓库根目录 `AGENTS.md`
- `docs/subagent-cold-start-atomic-capability-fix.md`
- 本文档

开发期间禁止运行 `next build`。

---

## 1. 范围与结论

本轮共复核五项：

| 编号 | 问题 | 当前结论 | 本轮处理 |
|---|---|---|---|
| A | Steer 异步准备期间根回合结束 | 真问题 | 修复 |
| B | MCP Reload 与回合准入竞争 | 真问题 | 修复 |
| C | 队列 `all` 模式退化为逐条处理 | 真问题 | 修复 |
| D | Abort 所谓 8 秒上限实际可达约 30～38 秒 | 真问题 | 修复 |
| E | Recover 缺少幂等 | 当前主路径低概率边界 | **不改代码，仅记录未来设计** |

### 1.1 本轮不得破坏的现有能力

- Engine 内部网络/流式错误自动重试。
- 模型供应商本地排队和优先级调度。
- 代理短时中断后的重试与退避。
- 原路重试耗尽后由前端触发 Recover 和备用模型切换。
- Subagent 新会话首轮与冷启动 capability 快照。
- Prompt `clientMessageId` 幂等。
- Recover 的 `freshTurnAdmissionController` 新回合准入锁。
- 队列项各自独立的系统提示词、工具 schema 和执行模式。

---

## 2. 当前架构摘要

```text
UI
 ├─ prompt
 ├─ steer（运行中插嘴）
 ├─ follow_up（排队继续）
 └─ recover（停止旧回合并启动新回合）
       |
       v
AgentSessionWrapper.send()
 ├─ captureTurnAdmission()
 ├─ prepareTurnContext()
 ├─ prepareImageFallback()
 ├─ buildFrozenTurnContext()
 └─ DeerLoopEngine
       ├─ prompt loop
       ├─ steeringQueue
       ├─ followUpQueue
       ├─ ToolRegistry
       └─ abort / waitForIdle
```

关键文件：

- `hooks/useAgentSession.ts`
- `components/ChatWindow.tsx`
- `lib/rpc-manager.ts`
- `lib/engine/deer-loop.ts`
- `lib/engine/port.ts`
- `lib/engine/turn-context.ts`
- `lib/engine/tool-registry.ts`
- `app/api/mcp-config/route.ts`

---

# 3. 问题 A：Steer 异步准备竞态

## 3.1 现象

UI 只在 `isRunning` 时发送 Steer，但后端处理 Steer 会等待：

- Skill 解析；
- 文件/引用准备；
- 图片 fallback；
- MCP 图片识别。

等待期间根回合可能结束。准备完成后，当前代码仍无条件执行：

```ts
await this.inner.steer(...)
```

Engine 的 `steer()` 只入队，不检查当前是否还有 Prompt 在运行。若根回合已经结束，`steeringQueue` 无人消费，消息可能长期滞留，并在下一次 Prompt 中被错误消费。

当前位置：

- `lib/rpc-manager.ts` 的 `case "steer"`
- `lib/engine/deer-loop.ts` 的 `steer()` 和 `steeringQueue` drain

## 3.2 目标语义

Steer 是“给当前运行回合插嘴”。本轮建议采用明确语义：

1. Steer 请求进入时必须确认存在运行回合。
2. 异步准备期间占用自己的控制器，允许 Abort/Destroy 取消。
3. 准备完成后再次确认根回合仍在运行。
4. 若根回合已结束，**不要入 steeringQueue**。
5. 将准备好的 Steer 提升为 fresh Prompt，保证用户消息不会丢失。
6. 提升路径必须与 Prompt/Recover/空闲 Follow-up 共享新回合准入互斥。

选择提升为 Prompt，而不是返回错误，原因是 UI 已经展示用户消息；静默丢弃或仅报错体验较差。

## 3.3 推荐实现

### 3.3.1 抽取统一 fresh-turn reservation

文件：`lib/rpc-manager.ts`

不要继续分别手写 Recover、Follow-up、Steer 锁逻辑。建议抽取：

```ts
private reserveFreshTurnAdmission(message: string): AbortController {
  if (this.freshTurnAdmissionController || this.pendingPromptController) {
    throw new Error(`AGENT_BUSY: ${message}`);
  }
  const controller = new AbortController();
  this.freshTurnAdmissionController = controller;
  return controller;
}

private releaseFreshTurnAdmission(controller: AbortController): void {
  if (this.freshTurnAdmissionController === controller) {
    this.freshTurnAdmissionController = null;
  }
}
```

Prompt 原有 `pendingPromptController` 可以保留，不要求本轮彻底重构所有准入锁。

### 3.3.2 Steer 进入时检查运行状态

伪代码：

```ts
case "steer": {
  if (!this._isRunning && !this.inner.isStreaming) {
    throw new Error("AGENT_NOT_RUNNING: 当前没有可插入的运行回合");
  }
  if (this.freshTurnAdmissionController || this.pendingPromptController) {
    throw new Error("AGENT_BUSY: 当前有新回合正在准入");
  }

  const controller = this.reserveFreshTurnAdmission("Steer 正在准备");
  try {
    const admission = this.captureTurnAdmission(command);
    const turnContext = await this.prepareTurnContext(...);
    controller.signal.throwIfAborted();
    const prepared = await this.prepareImageFallback(...);
    controller.signal.throwIfAborted();
    const frozenContext = this.buildFrozenTurnContext(...);

    if (this._isRunning || this.inner.isStreaming) {
      await this.inner.steer({ ...prepared, context: frozenContext });
      return null;
    }

    // 根回合已结束：提升为 fresh prompt，不得再进入 steeringQueue。
    return this.startPreparedFreshTurn({
      message: prepared.message,
      images: toSdkImages(prepared.images),
      context: frozenContext,
      source: "steer_promoted",
    });
  } finally {
    this.releaseFreshTurnAdmission(controller);
  }
}
```

### 3.3.3 抽取启动已准备回合的方法

Follow-up 当前直接手写：

- `activeTurnId++`
- `createPromptRun()`
- `transitionCurrentRun()`
- `trackTurn(inner.prompt())`

建议抽成一个私有方法供 Follow-up 和 Steer promotion 共用，避免状态遗漏。

必须保证：

- `currentTurnKey` 正确；
- RunStore 创建正确；
- `_turnActive`/`_isRunning` 的现有事件状态不被破坏；
- Engine mutex 失败时正确收敛 Run 状态；
- 不重复写展示用户消息。

## 3.4 测试

扩展 `scripts/test-wrapper-turn-admission.ts`：

1. 启动一个被 gate 阻塞的根 Prompt。
2. 发送带慢 Skill 的 Steer。
3. Steer prepare 尚未完成时结束根 Prompt。
4. 释放 Skill gate。
5. 断言 Steer 没有留在 `steeringQueue`。
6. 断言它被提升为新 Prompt，LLM 输入包含 Steer 文本。
7. 断言它使用 Steer 自己冻结的 system prompt 和 tools。
8. Abort/Destroy 能取消准备中的 Steer。
9. 空闲直接 Steer 返回明确错误或按约定提升，不允许静默入队。

## 3.5 验收标准

- [ ] Steer 准备完成后必定重新检查运行状态。
- [ ] 根回合结束后不向无人消费的队列入队。
- [ ] 提升为 fresh Prompt 时使用 Steer 自己的冻结环境。
- [ ] Steer 与 Recover/Prompt/空闲 Follow-up 不并发启动新回合。
- [ ] Abort/Destroy 能取消准备中的 Steer。
- [ ] 新增真实异步行为测试。

---

# 4. 问题 B：MCP Reload 准入竞态

## 4.1 现象

保存 MCP 配置时：

```text
PUT /api/mcp-config
  -> writeMcpServers()
  -> reloadMcpForIdleSessions()
  -> session.send({ type: "mcp_reload" })
```

`reloadMcpRuntime()` 当前只检查：

```ts
this._isRunning || this.inner.isStreaming || this.inner.isCompacting
```

但 Prompt/Recover/Follow-up/Steer 可能处于异步准入阶段：

```ts
pendingPromptController
freshTurnAdmissionController
```

此时 Engine 尚未 running，MCP Reload 会误判为空闲。

另外，首次检查之后还会异步 `acquireMcpRuntime()`。获取期间可能启动新回合，形成 TOCTOU 竞态。

## 4.2 目标语义

MCP 工具热替换只能发生在 Wrapper 真正空闲时：

- 没有 Prompt 准入；
- 没有 Recover/Steer/空闲 Follow-up 新回合 reservation；
- Engine 不运行；
- 不 streaming；
- 不 compacting。

检查必须执行两次：

1. 获取新 Runtime 前；
2. 获取完成、安装前。

## 4.3 推荐实现

文件：`lib/rpc-manager.ts`

### 4.3.1 增加统一判断

```ts
private canReloadMcpNow(): boolean {
  return !this.isTurnBusy()
    && !this._turnActive
    && !this._stopRequested;
}
```

注意 `isTurnBusy()` 已包含：

- `pendingPromptController`
- `freshTurnAdmissionController`
- `_isRunning`
- `inner.isStreaming`
- `inner.isCompacting`

如果 `_turnActive` 与 `isTurnBusy()` 的状态边界存在差异，保守地一并检查。

### 4.3.2 双重检查和 Lease 释放

```ts
private async reloadMcpRuntime() {
  if (!this.canReloadMcpNow()) {
    return { ok: false, skipped: true };
  }

  const nextLease = await acquireMcpRuntime(this.session.cwd);

  if (!this.canReloadMcpNow()) {
    nextLease.release();
    return { ok: false, skipped: true };
  }

  try {
    this.installMcpRuntime(nextLease.runtime, ...);
  } catch (error) {
    nextLease.release();
    throw error;
  }

  ...
}
```

必须确保所有 skipped/error 路径释放新 Lease。

### 4.3.3 不在忙时排队自动 Reload

本轮最小方案是返回 `skipped: true`，不自动排队。原因：

- 用户保存配置后 API 已返回每个 Session 的 reload 结果；
- 下次 Session 冷启动会读取新配置；
- 自动排队会引入另一个生命周期与取消问题。

如果产品要求忙碌 Session 在回合结束后自动更新，应另建任务设计单次 pending reload 标记。

## 4.4 工具定义快照说明

本轮优先通过“准入期间禁止 MCP 热替换”解决 schema 版本竞态，不要求扩展 `AgentEnginePort` 暴露完整工具定义快照。

原因：

- 当前 Port 只公开 `ToolInfo[]`，没有定义/schema 对象接口；
- 扩展 Port 会扩大架构改动；
- 双重 idle guard 已能阻止本地 MCP Reload 在 admission 与 Engine prompt 之间替换 registry。

## 4.5 测试

新增或扩展 Wrapper 测试：

1. Prompt 在慢 Skill 准入中，发送 `mcp_reload`，断言 skipped。
2. Recover 持有 `freshTurnAdmissionController`，断言 skipped。
3. 空闲 Follow-up/Steer promotion 准入中，断言 skipped。
4. MCP acquire 被 gate 暂停，期间启动 Prompt；释放 acquire 后断言不安装并释放 Lease。
5. 真正空闲时 reload 成功。
6. install 抛错时新 Lease 被释放，旧 Lease 未被错误替换。

## 4.6 验收标准

- [ ] MCP Reload 前后均检查完整 Wrapper 忙碌状态。
- [ ] 准入中返回 `skipped: true`。
- [ ] TOCTOU 窗口启动新回合时不安装 Runtime。
- [ ] 所有提前返回和异常路径正确释放 Lease。
- [ ] 不影响冷启动读取新 MCP 配置。

---

# 5. 问题 C：队列 `all` 模式退化

## 5.1 现象

当前 `all` 模式合并相邻队列项时比较对象引用：

```ts
queue[0]?.executionEnvironment === first.executionEnvironment
```

但每次 `steer()`/`followUp()` 都会创建新的 `QueueExecutionEnvironment` 对象。即使内容相同，引用也不同，因此 `all` 实际退化成逐条处理。

## 5.2 目标语义

- `one-at-a-time`：每轮只消费一条。
- `all`：连续且执行环境等价的消息可以一次注入。
- 执行环境不同的消息绝不能合并，必须分开 LLM 调用。

等价环境至少要求：

- `effectiveSystemPrompt` 相同；
- `activeToolNames` 相同且顺序一致；
- 工具定义对象版本相同；
- execution mode 相同。

## 5.3 推荐实现：环境签名 + 工具对象身份

不要只比较工具名，因为同名 MCP 工具可能已换 schema。

### 5.3.1 为环境增加稳定 key

```ts
interface QueueExecutionEnvironment {
  key: string;
  effectiveSystemPrompt: string;
  activeToolNames: readonly string[];
  tools: ReadonlyMap<string, AnyToolDefinition>;
  executionModes: ReadonlyMap<string, ToolExecutionMode>;
}
```

仅字符串 hash 不足以表达工具对象版本。推荐维护 Engine 内的工具对象身份编号：

```ts
private readonly toolIdentity = new WeakMap<object, number>();
private nextToolIdentity = 1;
```

生成 key：

```text
systemPrompt
+ activeToolNames
+ 每个工具定义对象 identity
+ 每个 execution mode
```

也可以实现 `sameQueueExecutionEnvironment(a, b)` 逐项比较，并对工具定义使用 `===`。

推荐后者，更简单且无需 hash：

```ts
private sameQueueExecutionEnvironment(a?: QueueExecutionEnvironment, b?: QueueExecutionEnvironment): boolean {
  if (!a || !b) return a === b;
  if (a.effectiveSystemPrompt !== b.effectiveSystemPrompt) return false;
  if (!sameArray(a.activeToolNames, b.activeToolNames)) return false;
  for (const name of a.activeToolNames) {
    if (a.tools.get(name) !== b.tools.get(name)) return false;
    if (a.executionModes.get(name) !== b.executionModes.get(name)) return false;
  }
  return true;
}
```

然后：

```ts
while (
  queue.length > 0 &&
  this.sameQueueExecutionEnvironment(
    queue[0]?.executionEnvironment,
    first.executionEnvironment,
  )
) {
  entries.push(queue.shift()!);
}
```

### 5.3.2 保持不同环境隔离

现有 `scripts/test-queued-turn-context.ts` 已验证不同环境不能合并，必须保留。

## 5.4 测试

扩展 `scripts/test-queued-turn-context.ts`：

1. `followUpMode: "all"` 下两条相同 Prompt、相同工具对象、相同 mode 的 Follow-up，只产生一次后续 LLM 调用，且两条 user message 都进入 context。
2. 相同工具名但不同工具定义对象，不合并。
3. 相同工具定义但 execution mode 不同，不合并。
4. Prompt 不同，不合并。
5. `one-at-a-time` 永远逐条。
6. 超过 10 条相同环境 Follow-up 在 `all` 下可一次消费，不残留。
7. Steer 同样覆盖。

## 5.5 验收标准

- [ ] `all` 能合并值和工具版本都相同的相邻消息。
- [ ] 不同系统提示词、工具定义或执行模式绝不合并。
- [ ] `one-at-a-time` 行为不变。
- [ ] 不破坏队列项自己的 capability/tool schema。
- [ ] 真实 LLM context 测试通过。

---

# 6. 问题 D：Abort 总超时不准确

## 6.1 现象

Wrapper 当前：

```ts
await this.inner.abort();
await this.waitForCurrentTurnToStop(8_000);
```

但 DeerLoopEngine `abort()` 内部会：

```ts
await this.waitForIdle();
```

其上限为 30 秒。因此所谓 8 秒超时实际在 `inner.abort()` 返回后才开始，最坏约 30～38 秒。

## 6.2 关键安全原则

Abort 超时后：

- 可以停止等待并返回错误；
- **不能假设旧回合已经停止**；
- **不能启动 Recover 新回合**；
- 底层 Abort 应继续在后台收敛；
- 不得产生未处理 Promise rejection。

## 6.3 推荐实现：单一总 Deadline

文件：`lib/rpc-manager.ts`

```ts
private async abortAndSettleCurrentTurn(timeoutMs = 8_000): Promise<void> {
  const turnPromise = this.activeTurnPromise;
  const turnId = this.activeTurnId;
  const deadline = Date.now() + timeoutMs;

  const abortPromise = this.inner.abort();
  const abortSettled = await Promise.race([
    abortPromise.then(() => true, (error) => { throw error; }),
    sleepMs(timeoutMs).then(() => false),
  ]);

  if (!abortSettled) {
    // 防止其后 reject 成为 unhandled rejection。
    void abortPromise.catch((error) => {
      console.error("Late agent abort failed", error);
    });
    throw new Error(`abort timeout: current turn did not settle within ${timeoutMs}ms`);
  }

  const remaining = Math.max(0, deadline - Date.now());
  await this.waitForCurrentTurnToStop(remaining);

  if (this._isRunning || this.inner.isStreaming || this.inner.isCompacting) {
    throw new Error(`abort timeout: current turn did not settle within ${timeoutMs}ms`);
  }

  if (turnPromise && this.activeTurnId === turnId) {
    const finalRemaining = Math.max(0, deadline - Date.now());
    await Promise.race([
      turnPromise.catch(() => {}),
      sleepMs(finalRemaining),
    ]);
  }
}
```

### 6.3.1 不要修改 Engine 的 30 秒 waitForIdle 作为唯一修复

Engine 的 30 秒可能服务于：

- 普通 UI Abort；
- 压缩清理；
- 工具进程回收。

Wrapper Recover 需要的是自己的 8 秒总 deadline。优先在 Wrapper 做 Promise race，避免改变其他调用者语义。

### 6.3.2 超时后的状态

Recover 捕获 Abort timeout 后应：

- 保持/恢复 `freshTurnAdmissionController` 的 finally 清理；
- 不调用 `captureTurnAdmission()`；
- 不切换模型；
- 不启动新 Prompt；
- 向前端返回明确错误；
- 旧 Engine 的 abort Promise 继续后台收敛。

## 6.4 测试

新增可配置小超时以避免测试等待 8 秒，例如私有方法参数或测试构造选项。

测试：

1. Mock `inner.abort()` 永不 resolve，断言在配置 deadline 附近拒绝。
2. 超时后没有启动 Recover Prompt。
3. 超时后延迟 reject 不产生 unhandled rejection。
4. Abort 快速成功时正常 Recover。
5. Abort 成功但状态仍 running，剩余 deadline 到期后拒绝。
6. Compaction 状态也被纳入最终检查。
7. 用户普通 Abort 行为不因本修复改变。

## 6.5 验收标准

- [ ] 8 秒是包含 `inner.abort()` 的总 deadline。
- [ ] 超时后绝不启动新回合。
- [ ] 晚到的 Abort Promise 被安全处理。
- [ ] 正常 Abort/Recover 路径不变。
- [ ] 测试使用短 deadline，不拖慢 `test:core`。

---

# 7. 问题 E：Recover 幂等——本轮不改

## 7.1 已确认事实

当前 Recover 使用：

```ts
sendAgentCommand(sid, { type: "recover", ... })
```

`lib/agent-client.ts` 中 `sendAgentCommand()` 只执行一次 POST，没有自动重试循环。

现有容错分层：

- Engine `consumeStreamWithRetry()`：网络波动、流断开、代理短时中断；
- RetryPolicy：退避、Retry-After、TTFT 策略；
- LLM Gateway：供应商排队与并发控制；
- 前端门闩：`autoContinueSentRef`、`autoContinueInProgressRef`、attempt 上限；
- 原路重试耗尽后才触发业务 Recover。

因此当前单客户端主路径不会自动重复发送同一个 Recover 请求。

## 7.2 本轮决定

**不增加 Recover `clientMessageId` 幂等，不修改现有自动恢复链路。**

理由：

- 当前收益低；
- 错误的 ID 生命周期可能拦截真实的下一次 fallback 恢复；
- 现有网络重试和供应商排队不依赖 Recover 幂等；
- 应与未来可靠 POST 重试一起整体设计。

## 7.3 未来触发条件

出现以下需求时再实施：

- `sendAgentCommand()` 对 POST 自动重试；
- Recover 超时后自动重发；
- 离线命令重放；
- 多客户端控制同一 Session；
- exactly-once 恢复要求。

## 7.4 未来方案约束

未来应引入：

```ts
{
  recoveryRequestId: string;
  recoveryAttempt: number;
  source: string;
  provider?: string;
  modelId?: string;
}
```

规则：

- 同一次传输重试复用 `recoveryRequestId`；
- 下一次业务恢复 attempt 使用新 ID；
- 手动恢复使用新 ID；
- 后端保存完整 Recover receipt，包括 `modelChanged` 和 `turnId`；
- duplicate 返回第一次完整结果，不能中止新回合。

本轮不要加入半套 duplicate 判断。

---

# 8. 建议实施顺序

1. 修复 MCP Reload 双重 idle guard，改动最小且风险低。
2. 修复 Abort 总 deadline，并补 timeout 测试。
3. 抽取 fresh-turn reservation/启动方法。
4. 修复 Steer promotion 与取消。
5. 修复队列环境等价比较。
6. 运行完整验证。
7. Recover 幂等保持不变，仅保留本文档记录。

---

# 9. 测试与验证

建议新增/扩展：

- `scripts/test-wrapper-turn-admission.ts`
  - Steer 根回合结束竞态
  - MCP reload admission/TOCTOU
  - Abort 总 deadline
- `scripts/test-queued-turn-context.ts`
  - all 模式相同环境合并
  - 不同工具版本不合并
- 如测试变得过大，可拆分：
  - `scripts/test-steer-admission.ts`
  - `scripts/test-mcp-reload-admission.ts`
  - `scripts/test-abort-deadline.ts`

新测试加入 `package.json` 的 `test:core`。

至少执行：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:core
```

开发期间禁止执行：

```bash
next build
npm run build
```

---

# 10. 总体验收清单

## Steer

- [ ] 异步准备期间根回合结束不会留下无人消费队列项。
- [ ] Steer 可以安全提升为 fresh Prompt，或按明确契约拒绝。
- [ ] Abort/Destroy 能取消准备中的 Steer。
- [ ] 不与 Recover/Prompt/空闲 Follow-up 并发启动新回合。

## MCP Reload

- [ ] 准入阶段被视为忙碌。
- [ ] acquire 前后双重检查。
- [ ] skipped/error 正确释放新 Lease。
- [ ] 不替换运行中或准入中的工具 Registry。

## Queue all

- [ ] 相同执行环境的相邻消息可以合并。
- [ ] 同名但不同定义版本的工具不能合并。
- [ ] 不同 Prompt/mode/execution mode 不能合并。
- [ ] `one-at-a-time` 不变。

## Abort

- [ ] 8 秒覆盖整个 Abort + settle 流程。
- [ ] 超时后不启动 Recover 新回合。
- [ ] 晚到 Promise 安全收敛。

## Recover

- [ ] 本轮没有添加 Recover 幂等逻辑。
- [ ] 现有网络重试、排队、备用模型和 Watchdog 门闩行为保持不变。

## 工程验证

- [ ] `tsc --noEmit` 通过。
- [ ] ESLint 无新增 error。
- [ ] `test:core` 通过。
- [ ] 未运行 `next build`。

---

# 11. 禁止采用的修法

1. **Steer 根回合结束后仍然入队，期待下一次 Prompt 顺便消费。** 这会污染无关回合。
2. **MCP Reload 只在 acquire 前检查一次。** 获取期间仍有 TOCTOU。
3. **Queue 环境只比较工具名。** 同名 MCP 工具 schema 可能不同。
4. **Abort timeout 后直接启动 Recover。** 旧回合可能仍运行，会产生双回合竞争。
5. **把 Engine 全局 30 秒 waitForIdle 简单改成 8 秒。** 会影响其他 Abort/清理调用者。
6. **现在给 Recover 随便加固定 ID。** 可能拦截下一次真实 fallback 恢复。
7. **为解决 MCP 竞态关闭回合工具冻结。** 正确做法是禁止准入期间热替换。

---

# 12. 最终交付报告模板

```md
## 已完成

- Steer 准入与 promotion：...
- MCP Reload 双重 idle guard：...
- Queue all 环境等价合并：...
- Abort 总 deadline：...
- Recover 幂等：按方案保持不变

## 修改文件

- `path`: 修改说明

## 行为保证

- 不影响网络自动重试：...
- 不影响供应商排队：...
- 不影响代理短时中断恢复：...
- 不影响 Subagent 冷启动：...

## 验证

- `node_modules/.bin/tsc --noEmit`: ...
- `npm run lint`: ...
- `npm run test:core`: ...

## 未解决事项

- Recover exactly-once：等待未来可靠命令重放需求
```
