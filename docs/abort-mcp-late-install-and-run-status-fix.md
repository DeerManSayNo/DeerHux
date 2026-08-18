# Abort 后 MCP 晚到安装与 Run 取消状态修复方案

## 0. 文档用途

本文档用于交给一个**没有历史对话上下文**的编程 Agent，修复 DeerHux 当前剩余的两个 Abort 边界问题：

1. Steer/Follow-up 被 Abort 或 Wrapper 被 Destroy 后，晚到的 MCP Runtime acquire 仍可能安装工具、修改 Prompt 或泄漏 Lease。
2. 用户 Abort 的运行回合最终可能被 RunStore 记录为 `succeeded`，而不是 `cancelled`。

开始开发前必须阅读：

- 仓库根目录 `AGENTS.md`
- `docs/subagent-cold-start-atomic-capability-fix.md`
- `docs/agent-turn-edge-cases-remediation-plan.md`
- 本文档

开发期间禁止运行 `next build`。

---

## 1. 修复目标

完成后必须满足：

### MCP 晚到任务

- Steer/Follow-up/Prompt 准入被 Abort 后，Wrapper 能立即结束等待并释放准入 reservation。
- 底层不支持真正取消的 MCP acquire 即使晚到，也不得安装 Runtime、修改 Tool Registry、修改 active tools 或 System Prompt。
- Wrapper 已 Destroy 时，任何晚到 MCP Lease 必须立即释放。
- 晚到任务不得覆盖新 Prompt 已经建立的工具环境。
- 所有失败、Abort 和 Destroy 路径不得泄漏 MCP Lease 或子进程引用。

### Run 取消状态

- 用户 Abort 的回合最终 Run 状态必须是 `cancelled`。
- 普通成功回合仍为 `succeeded`。
- 模型/工具错误仍为 `failed`。
- 自动重试中的临时 `agent_end{willRetry:true}` 不得提前终结 Run。
- Recover 中止旧回合后，旧 Run 为 `cancelled`，新 Recover Run 独立记录。
- 不使用错误字符串作为唯一取消信号，优先使用结构化字段。

---

## 2. 不得破坏的现有功能

本次修改不得影响：

- Engine `consumeStreamWithRetry()` 的网络波动和流中断自动重试。
- RetryPolicy 的退避、Retry-After 和 TTFT 策略。
- LLM Gateway 的供应商排队与并发限制。
- 前端 Watchdog 和备用模型 Recover。
- Recover 当前“不增加幂等”的决定。
- Subagent 新会话首轮和冷启动 capability 快照。
- Steer 根回合结束后的 promotion。
- Follow-up 队列自己的工具 schema 和 Prompt 快照。
- MCP 配置保存后的双重 idle guard 和安装回滚。
- 普通用户 Abort 的低延迟控制面响应。

---

# 3. 问题 A：Abort 后晚到 MCP Runtime 仍可能安装

## 3.1 当前行为

`lib/rpc-manager.ts` 已有 `raceWithAbort()`：

```ts
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>
```

Steer/Follow-up 使用它包裹：

```ts
await raceWithAbort(this.prepareTurnContext(...), signal);
await raceWithAbort(this.prepareImageFallback(...), signal);
```

这能让 Wrapper 在 Abort 时立即拒绝并释放 `freshTurnAdmissionController`，但不会停止底层 Promise。

`prepareImageFallback()` 可能调用：

```ts
await this.ensureMcpRuntimeLoaded(false)
```

`ensureMcpRuntimeLoaded()` 当前在 acquire 返回后直接：

```ts
this.installMcpRuntime(lease.runtime, activateMcp);
this.mcpRuntimeLease = lease;
```

因此存在：

```text
Steer/Follow-up 准入
  -> 开始 acquireMcpRuntime
  -> 用户 Abort
  -> raceWithAbort 立即退出并释放 reservation
  -> 新 Prompt 开始
  -> 旧 acquire 晚到
  -> 安装 MCP，修改 Registry/Prompt/Lease
```

Destroy 场景还可能造成新 Lease 无人释放。

---

## 3.2 设计原则

### 3.2.1 区分“取消等待”和“取消副作用”

`raceWithAbort()` 只负责取消外层等待。

任何会产生状态副作用的异步操作都必须在提交副作用前再次验证：

- Signal 未 Abort；
- Wrapper 仍 `_alive`；
- 当前异步任务仍属于合法的准入代次；
- 若要求 idle，则仍满足 idle 条件。

### 3.2.2 Acquire 与 Commit 分离

MCP Runtime 获取流程应拆成：

```text
Acquire Lease
  -> 验证任务仍有效
  -> Commit 安装
  -> 保存 Lease
```

验证失败时只释放 Lease，绝不能安装。

### 3.2.3 晚到任务不得修改未来回合

Abort 后即使底层 acquire 无法取消，晚到结果也只能被丢弃和释放，不能成为 Session 当前 Runtime。

---

## 3.3 推荐实现

## 3.3.1 为 `ensureMcpRuntimeLoaded()` 增加选项

文件：`lib/rpc-manager.ts`

建议定义：

```ts
interface EnsureMcpRuntimeOptions {
  activateMcp?: boolean;
  signal?: AbortSignal;
  /** 可选：要求 commit 时 Wrapper 仍满足额外条件。 */
  canCommit?: () => boolean;
}
```

修改签名：

```ts
private async ensureMcpRuntimeLoaded(
  options: EnsureMcpRuntimeOptions = {},
): Promise<McpRuntime | null>
```

如果为了减小改动，也可保留旧布尔参数并增加第二个参数：

```ts
private async ensureMcpRuntimeLoaded(
  activateMcp = false,
  signal?: AbortSignal,
  canCommit?: () => boolean,
): Promise<McpRuntime | null>
```

优先使用 options 对象，避免布尔参数继续扩张。

---

## 3.3.2 增加统一有效性检查

```ts
private canCommitAsyncRuntime(
  signal?: AbortSignal,
  extraCheck?: () => boolean,
): boolean {
  return this._alive
    && !signal?.aborted
    && (extraCheck?.() ?? true);
}
```

需要时抛出 Abort：

```ts
private throwIfAsyncRuntimeInvalid(signal?: AbortSignal): void {
  if (!this._alive) {
    throw new DOMException("Session destroyed", "AbortError");
  }
  signal?.throwIfAborted();
}
```

---

## 3.3.3 Acquire 后、安装前强制检查

推荐伪代码：

```ts
private async ensureMcpRuntimeLoaded(
  options: EnsureMcpRuntimeOptions = {},
): Promise<McpRuntime | null> {
  const { activateMcp = false, signal, canCommit } = options;

  this.throwIfAsyncRuntimeInvalid(signal);

  if (this.mcpRuntime) {
    if (activateMcp) {
      this.throwIfAsyncRuntimeInvalid(signal);
      if (canCommit && !canCommit()) {
        throw new DOMException("MCP commit no longer allowed", "AbortError");
      }
      this.installMcpRuntime(this.mcpRuntime, true);
    }
    return this.mcpRuntime;
  }

  const lease = await acquireMcpRuntime(this.session.cwd);

  if (!this.canCommitAsyncRuntime(signal, canCommit)) {
    lease.release();
    signal?.throwIfAborted();
    throw new DOMException("MCP result arrived after session invalidation", "AbortError");
  }

  try {
    this.installMcpRuntime(lease.runtime, activateMcp);

    // install 之后赋值前再做一次防御检查。正常 JS 同步段不会被抢占，
    // 但保留检查便于未来 install 变 async 时不引入回归。
    if (!this.canCommitAsyncRuntime(signal, canCommit)) {
      // 需要回滚 install，再释放 Lease；不得只释放新 Runtime。
      this.rollbackMcpRuntimeInstallation(...);
      lease.release();
      signal?.throwIfAborted();
      throw new DOMException("MCP commit invalidated", "AbortError");
    }

    this.mcpRuntimeLease = lease;
    return lease.runtime;
  } catch (error) {
    lease.release();
    throw error;
  }
}
```

注意：同一个 Lease 只能释放一次。实现时应使用布尔标记或 ownership 转移，避免双重 release。

---

## 3.3.4 把 Signal 传入 `prepareImageFallback()`

修改：

```ts
private async prepareImageFallback(
  message: string,
  images?: RuntimeImage[],
  displayMessage = message,
  signal?: AbortSignal,
): Promise<...>
```

关键阶段检查：

```ts
signal?.throwIfAborted();
```

至少放在：

1. 文件图片读取前后；
2. MCP acquire 前；
3. MCP acquire 返回后；
4. `describeImages()` 前后；
5. 返回结果前。

调用：

```ts
const prepared = await raceWithAbort(
  this.prepareImageFallback(
    turnContext.message,
    images,
    turnContext.displayMessage,
    controller.signal,
  ),
  controller.signal,
);
```

`raceWithAbort()` 可以保留，负责即刻退出；`prepareImageFallback()` 内的 Signal 检查负责阻止晚到副作用。

---

## 3.3.5 `describeImages()` 的取消

如果 `McpRuntime.describeImages()` 支持 Signal，应扩展签名并向底层传递：

```ts
await mcpRuntime.describeImages(images, message, signal)
```

如果暂不支持：

```ts
const rawDescriptions = await raceWithAbort(
  mcpRuntime.describeImages(images, message),
  signal,
);
```

即使底层调用继续运行，也不得再产生 Registry/Lease 副作用；晚到结果只会被丢弃。

长期建议让 MCP client 层支持真正的请求取消和超时。

---

## 3.3.6 Destroy 防线

`destroy()` 已设置：

```ts
this._alive = false;
this.freshTurnAdmissionController?.abort(...);
```

`ensureMcpRuntimeLoaded()` 必须在 acquire 返回后检查 `_alive`。

测试必须证明：

```text
开始 acquire
→ destroy Wrapper
→ acquire 返回 Lease
→ Lease 被释放
→ Registry 未修改
→ this.mcpRuntimeLease 保持 null
```

---

## 3.3.7 MCP Reload 继续使用双重 idle guard

`reloadMcpRuntime()` 已有 acquire 前后：

```ts
canReloadMcpNow()
```

必须保留。

不要用本次 Signal 修复替换双重 idle guard；二者防护不同：

- Signal/_alive：防 Abort、Destroy 和晚到任务；
- idle guard：防新 Prompt 在 acquire 期间启动。

---

## 3.4 测试方案

扩展 `scripts/test-wrapper-turn-admission.ts`，或新增：

```text
scripts/test-mcp-late-install.ts
```

必须覆盖：

### A1. Abort 后晚到 acquire

1. Steer 带图片进入 `prepareImageFallback()`。
2. `acquireMcpRuntime()` 被 gate 暂停。
3. 发送 Abort。
4. Steer 立即拒绝并释放 reservation。
5. 启动新 Prompt。
6. 释放 MCP gate。
7. 断言：
   - 新 Lease 被 release；
   - `installMcpRuntime()` 未调用；
   - Registry/active tools/System Prompt 未变化；
   - 新 Prompt 环境未被污染。

### A2. Destroy 后晚到 acquire

1. 开始 acquire。
2. `wrapper.destroy()`。
3. acquire 返回。
4. 断言 Lease 被释放一次，Registry 未变化，没有子进程引用泄漏。

### A3. DescribeImages 晚到

1. Runtime 已存在。
2. `describeImages()` 被 gate 暂停。
3. Abort Steer。
4. 外层立即退出。
5. 晚到识别结果不得写入用户消息、不得启动 promotion。

### A4. 正常路径

未 Abort 时：

- MCP Runtime 正常安装；
- Lease 保存；
- 图片描述正常进入 Prompt；
- 现有双重 idle guard 不受影响。

### A5. Lease ownership

覆盖：

- acquire 后校验失败释放一次；
- install 抛错释放一次；
- 成功后 Wrapper 持有 Lease，不提前释放；
- Destroy 后释放一次。

---

## 3.5 验收标准

- [ ] Abort 后晚到 MCP acquire 不安装任何工具。
- [ ] Destroy 后晚到 Lease 立即释放。
- [ ] 晚到任务不修改 Registry、active tools 或 Prompt。
- [ ] Steer/Follow-up 外层仍可快速取消并释放 reservation。
- [ ] Lease 每条路径只释放一次。
- [ ] 新 Prompt 不受旧准备任务污染。
- [ ] 正常 MCP 图片 fallback 行为不变。

---

# 4. 问题 B：Abort Run 被记录为 succeeded

## 4.1 当前行为

DeerLoop Abort 时内部设置：

```ts
agentError = "aborted";
```

但最终 `agent_end` 构造会排除 `aborted`：

```ts
const endError =
  agentError && agentError !== "aborted"
    ? agentError
    : undefined;
```

最终事件可能只有：

```ts
{
  type: "agent_end",
  willRetry: false,
}
```

Wrapper 当前通过 `event.error` 判断：

```ts
status: error === "aborted"
  ? "cancelled"
  : error
    ? "failed"
    : "succeeded"
```

因此用户取消的 Run 可能被标记为成功。

---

## 4.2 设计原则

### 4.2.1 使用结构化终止原因

不要依赖：

```ts
error: "aborted"
```

推荐给 `agent_end` 增加：

```ts
stopReason?: "stop" | "aborted" | "error";
```

或者更通用：

```ts
outcome?: "succeeded" | "cancelled" | "failed";
```

优先采用 `stopReason`，与 AssistantMessage/现有 Engine 语义接近，改动更小。

### 4.2.2 `error` 与取消分离

- 用户取消不是模型错误；
- 可以不展示红色错误；
- 但持久化 Run 必须是 `cancelled`。

---

## 4.3 推荐实现

## 4.3.1 扩展运行时事件类型

检查并修改：

- `lib/engine/loop-event.ts`
- `lib/agent-runtime/types.ts`
- 如有共享前端事件类型，也同步更新

为最终 `agent_end` 增加：

```ts
stopReason?: "stop" | "aborted" | "error";
```

保持可选，兼容旧事件与历史记录。

---

## 4.3.2 DeerLoop 发出明确取消原因

文件：`lib/engine/deer-loop.ts`

最终构造：

```ts
const agentEndEvent: LoopEvent = {
  type: "agent_end",
  willRetry: false,
  stopReason:
    agentError === "aborted"
      ? "aborted"
      : agentError
        ? "error"
        : "stop",
};
```

对于自动重试临时终态：

```ts
agent_end { willRetry: true }
```

可保留现有行为；如果携带 `stopReason: "error"`，Wrapper 仍必须因为 `willRetry === true` 而不终结 Run。

### 特殊情况

- `abort()` 在无运行回合时不应生成新的 cancelled Run。
- 工具执行期间 Abort 也必须最终 `stopReason: "aborted"`。
- 压缩 Abort 使用独立 compaction Run，不应误套主 Prompt Run 逻辑。

---

## 4.3.3 Wrapper 按结构化字段收敛 Run

文件：`lib/rpc-manager.ts`

推荐：

```ts
if (event.type === "agent_end" && event.willRetry !== true) {
  const error = typeof event.error === "string"
    ? event.error
    : undefined;
  const stopReason = typeof event.stopReason === "string"
    ? event.stopReason
    : undefined;
  const cancelled =
    stopReason === "aborted" || error === "aborted";

  this.transitionCurrentRun({
    status: cancelled
      ? "cancelled"
      : error
        ? "failed"
        : "succeeded",
    lastEventType: event.type,
    ...(error && !cancelled ? { error } : {}),
  });
}
```

保留 `error === "aborted"` 兼容旧 Engine/事件。

### 状态优先级

```text
willRetry === true       → 不终结 Run
stopReason === aborted   → cancelled
error 存在               → failed
否则                     → succeeded
```

---

## 4.3.4 前端行为

检查 `hooks/useAgentSession.ts` 的 `agent_end` 处理。

要求：

- `stopReason: "aborted"` 不显示模型错误；
- 停止按钮流程正常收敛；
- `agentRunning` 归零；
- 不触发错误自动恢复；
- 用户主动 Stop 不触发 `retry_exhausted` Recover；
- 手动 Recover 的旧 Run cancelled，新 Run 正常启动。

如果前端当前不读取该字段，不一定需要 UI 改动；但类型必须允许字段透传。

---

## 4.3.5 RunStore 与历史恢复

确认：

- `cancelled` 属于 terminal status；
- `isTerminalAgentRunStatus()` 包含 cancelled；
- 页面刷新后 `lastRun` 能显示取消事实；
- reconcile 不会把 cancelled 改成 interrupted。

如已有这些能力，只增加测试，不要重复实现。

---

## 4.4 测试方案

建议新增或扩展：

- `scripts/test-run-store.ts`
- `scripts/test-tool-abort.ts`
- `scripts/test-wrapper-turn-admission.ts`

并确保 `scripts/test-tool-abort.ts` 加入 `npm run test:core`。

### B1. 普通流 Abort

1. 启动 Prompt。
2. 模型流保持 pending。
3. 调用 Abort。
4. 断言最终：

```ts
agent_end.stopReason === "aborted"
Run.status === "cancelled"
```

### B2. 工具执行期间 Abort

1. 模型产生工具调用。
2. 工具保持 pending。
3. Abort。
4. 断言 Run 为 cancelled，不是 succeeded/failed。

### B3. 成功回合

正常完成：

```ts
stopReason === "stop"
Run.status === "succeeded"
```

### B4. 错误回合

不可恢复模型错误：

```ts
stopReason === "error"
Run.status === "failed"
```

### B5. 自动重试

临时：

```ts
agent_end { willRetry: true }
```

不得终结 Run。

最终重试成功后 Run 才 succeeded；最终失败后 failed。

### B6. Recover

1. 旧回合正在运行。
2. 执行 Recover。
3. 旧 Run 最终为 cancelled。
4. 新 Recover Run 独立创建并运行。
5. 不影响备用模型切换。

### B7. 无运行回合 Abort

Abort 幂等返回，不创建假的 cancelled Run。

---

## 4.5 验收标准

- [ ] 用户 Abort 的 Run 为 cancelled。
- [ ] 成功 Run 仍为 succeeded。
- [ ] 错误 Run 仍为 failed。
- [ ] `willRetry:true` 不提前终结 Run。
- [ ] Abort 不触发错误 Recover。
- [ ] Recover 旧 Run cancelled，新 Run 独立。
- [ ] 页面刷新后取消状态保持。
- [ ] `test-tool-abort.ts` 进入 `test:core`。

---

# 5. 建议实施顺序

1. 扩展 `agent_end.stopReason` 类型。
2. 修复 DeerLoop 最终 `agent_end`。
3. 修复 Wrapper Run 状态映射。
4. 增加 Run/Abort 测试。
5. 为 MCP ensure/load/图片 fallback 增加 Signal 和 `_alive` 检查。
6. 增加晚到 acquire/Destroy/Lease ownership 测试。
7. 运行完整验证。

先修 Run 状态，因为改动较小；再修 MCP 晚到副作用。

---

# 6. 验证命令

至少执行：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:core
```

可先运行聚焦测试：

```bash
node --experimental-strip-types --disable-warning=DEP0205 --import ./scripts/register-typescript-test-loader.mjs scripts/test-wrapper-turn-admission.ts
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-tool-abort.ts
```

如果新增 `scripts/test-mcp-late-install.ts`：

```bash
node --experimental-strip-types --disable-warning=DEP0205 --import ./scripts/register-typescript-test-loader.mjs scripts/test-mcp-late-install.ts
```

禁止执行：

```bash
next build
npm run build
```

---

# 7. 总体验收清单

## MCP 晚到任务

- [ ] Abort 后 Wrapper 立即退出准入等待。
- [ ] 晚到 acquire 不安装 Runtime。
- [ ] Destroy 后晚到 Lease 被释放。
- [ ] Registry、active tools、Prompt 不被晚到任务修改。
- [ ] Lease 不双重释放、不泄漏。
- [ ] 正常 MCP 图片 fallback 不受影响。

## Run 状态

- [ ] Abort → cancelled。
- [ ] success → succeeded。
- [ ] error → failed。
- [ ] willRetry → 保持运行态。
- [ ] Recover 旧 Run cancelled，新 Run 独立。

## 回归保护

- [ ] 网络自动重试不变。
- [ ] 供应商排队不变。
- [ ] 代理短时中断恢复不变。
- [ ] Recover 幂等仍不修改。
- [ ] Subagent 冷启动不变。
- [ ] Steer promotion 不变。

## 工程验证

- [ ] TypeScript 通过。
- [ ] ESLint 无新增 error。
- [ ] Core tests 通过。
- [ ] 未运行 `next build`。

---

# 8. 禁止采用的修法

1. 只保留 `raceWithAbort()`，不在 MCP commit 前检查 Signal 和 `_alive`。
2. Abort 后直接释放一个尚未 acquire 回来的 Lease——做不到且会导致 ownership 混乱。
3. 晚到 acquire 后先安装再判断 Abort。
4. 只给 `agent_end.error = "aborted"`，继续把取消当错误展示。
5. Wrapper 只看 `_stopRequested` 判断 cancelled。该字段可能在事件前被清理，结构化事件更可靠。
6. `willRetry:true` 时把 Run 标成 failed/cancelled。
7. 为修这两个问题顺便增加 Recover 固定幂等 ID。
8. 修改 Engine 全局 RetryPolicy 或供应商队列逻辑。

---

# 9. 最终交付报告模板

```md
## 已完成

- MCP acquire/install Abort 防线：...
- Destroy 后 Lease 释放：...
- agent_end stopReason：...
- Run cancelled 状态：...

## 修改文件

- `path`: 修改说明

## 不受影响的既有能力

- 网络自动重试：...
- 供应商排队：...
- 代理短时中断：...
- Recover：...
- Subagent 冷启动：...

## 验证

- `node_modules/.bin/tsc --noEmit`: ...
- `npm run lint`: ...
- `npm run test:core`: ...

## 未解决事项

- 如无，写“无”。
```
