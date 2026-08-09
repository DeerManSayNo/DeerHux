# DeerHux Agent App Server 设计

> 状态：架构设计，待分阶段实现  
> 参考：OpenAI Codex App Server 的长期 Runtime、双向 RPC、Thread/Turn/Item、即时回执、有界队列和异步通知模型。  
> 目标：解决多会话并行和 CPU 高负载下消息受理不确定、控制面请求惊群、事件断层及 UI 状态丢失。

---

## 1. 结论

DeerHux 不应继续以每个聊天窗口各自维护 POST + SSE + 多组轮询作为最终架构，也不应把所有请求机械改成 SSE。

目标架构为：

```text
React UI
  │
  │ 一条应用级双向 RPC 连接
  │ WebSocket（浏览器）/ Tauri IPC（桌面）/ stdio JSONL（测试与进程桥）
  ▼
DeerHux Agent App Server（独立进程）
  ├─ RpcBroker
  ├─ CommandAdmissionQueue
  ├─ SessionRegistry
  ├─ EventJournal
  ├─ SnapshotService
  └─ AgentSessionWrapper → DeerLoopEngine → LLM / Tools

Next.js UI Server
  ├─ 页面与静态资源
  ├─ 非实时配置 CRUD
  ├─ Session 只读查询
  └─ App Server 连接引导
```

核心原则：

1. Agent Runtime 与 Next.js 页面/API 服务分进程，CPU 密集任务不能继续共享一个 Node.js 事件循环。
2. 所有 session 复用一个应用级连接；连接不是 session 生命周期，也不是 turn 生命周期。
3. 命令受理与 Agent 执行分离：请求先返回 receipt，执行进度再通过通知推送。
4. `requestId` 关联 RPC 请求，`clientMessageId` 保证用户消息幂等，`turnId` 标识一次执行，`eventId` 用于补播。
5. 初始状态使用 Snapshot，运行过程使用 Delta；禁止高频推送完整聊天状态。
6. 所有队列有界；过载必须显式返回可重试错误，不能无限排队或静默丢弃。
7. 断线后优先补播；事件已淘汰或 Runtime 重启时明确要求重新读取 Snapshot。
8. 迁移期间保留现有 HTTP 命令和 session SSE，直到新链路达到功能等价。

---

## 2. 当前架构与问题定位

### 2.1 当前命令与事件链路

```text
ChatWindow / useAgentSession
  ├─ POST /api/agent/[id]                 命令
  ├─ GET  /api/agent/[id]/events          每窗口 SSE
  ├─ GET  /api/agent/[id]                 状态查询
  └─ GET  /api/sessions/[id]              历史与恢复快照

Next.js Route Handler
  └─ AgentSessionWrapper.send()
      └─ DeerLoopEngine
```

关键位置：

- 命令入口：`app/api/agent/[id]/route.ts:7-56`
- 状态查询：`app/api/agent/[id]/route.ts:59-91`
- Session SSE：`app/api/agent/[id]/events/route.ts:18-132`
- 命令分发：`lib/rpc-manager.ts:1209-1627`
- Runtime 事件入库：`lib/rpc-manager.ts:685-750`
- 事件存储：`lib/agent-runtime/event-store.ts:11-109`
- 前端每窗口 EventSource：`hooks/useAgentSession.ts:1092-1207`
- 运行中状态 2 秒轮询：`hooks/useAgentStatus.ts:30-84`
- 消息快照 6 秒兜底轮询：`hooks/useAgentSession.ts:2921-2983`
- 全局运行 session 2 秒轮询：`components/AppShell.tsx:267-290`
- 运行期间侧栏 10 秒刷新：`components/AppShell.tsx:292-302`

### 2.2 已有的正确基础

当前代码不需要推翻重写，以下能力可以直接演进：

1. `AgentSessionWrapper.send("prompt")` 已把受理和执行分开：持久化用户消息、生成 `turnId` 后，通过 `trackTurn()` 在后台执行，见 `lib/rpc-manager.ts:1134-1186`、`lib/rpc-manager.ts:1215-1263`。
2. `clientMessageId` 已提供用户消息幂等检查，见 `lib/rpc-manager.ts:1216-1225`。
3. Runtime 事件已统一写入 `EventStore`，见 `lib/rpc-manager.ts:712-717`。
4. `EventStore` 已对连续累计型 `message_update` 做覆盖合并，避免内存平方增长，见 `lib/agent-runtime/event-store.ts:38-55`。
5. 现有 SSE 已支持 `after` / `Last-Event-ID` 补播，并修复了 replay 与 subscribe 间的竞态，见 `app/api/agent/[id]/events/route.ts:95-104`。
6. 前端已经有乐观消息、投递状态、安全重试和 last-known-good 控制面缓存，可直接接到新 receipt 语义。

### 2.3 必须消除的问题

#### A. 进程和事件循环耦合

Tauri 生产环境当前直接启动 Next standalone：

- `src-tauri/resources/deerhux-server.js:28-34`

Agent Runtime、Route Handler、SSE 和部分同步文件操作均处于同一 Node.js 进程。CPU 饱和时，页面 API 和命令受理会一起延迟。

#### B. 连接和轮询按窗口放大

每个打开的 ChatWindow 都有独立 EventSource、状态轮询与消息快照恢复。多窗口并行时请求数按窗口数线性放大，并在同一时间点形成惊群。

#### C. EventStore 生命周期错误

`AgentSessionWrapper.destroy()` 当前调用：

```ts
getAgentEventStore().clearRun(this.inner.sessionId);
```

位置：`lib/rpc-manager.ts:1670-1672`。

这会把 Runtime wrapper 生命周期错误地绑定到事件补播生命周期。新架构中 wrapper 回收只释放运行资源，Event Journal 必须独立按容量和 TTL 淘汰。

#### D. 控制命令没有统一 RPC 语义

现有 `sendAgentCommand()` 只是 HTTP POST 包装，见 `lib/agent-client.ts:21-49`。不同命令没有统一的：

- request correlation
- deadline
- overload error
- cancellation
- duplicate receipt
- connection-level admission

#### E. 全量快照推送风险

`app/api/agent-runs/[runId]/events/route.ts:8-13` 当前每次事件推送完整协作快照。该模式不能推广到主聊天通道，否则长会话会重复传输大对象并增加序列化与渲染成本。

---

## 3. 目标组件

### 3.1 Agent App Server

新增独立长期运行进程，建议目录：

```text
lib/agent-app-server/
  protocol.ts              RPC 类型与版本
  broker.ts                请求路由、连接和订阅管理
  command-queue.ts         有界准入队列与优先级
  event-journal.ts         应用级 eventId、补播和 TTL
  event-adapter.ts         现有 AgentEvent → 协议通知
  snapshot-service.ts      Thread/控制面快照
  session-service.ts       Runtime session 装载与生命周期
  transports/
    transport.ts           统一 Transport 接口
    websocket.ts           浏览器/Tauri WebView
    stdio.ts               JSONL 进程桥和测试
    in-process.ts          单元测试与过渡期

scripts/
  deerhux-agent-server.mjs  独立进程入口
```

职责边界：

- App Server 持有 AgentSessionWrapper registry。
- Next.js 不再创建或持有 AgentSessionWrapper。
- App Server 是运行状态的唯一事实来源。
- `.jsonl` session 文件仍是聊天历史的持久事实来源。
- UI 本地 outbox 是未确认命令的事实来源。
- Event Journal 是短期实时恢复来源，不替代 `.jsonl`。

### 3.2 RpcBroker

Broker 负责：

1. 连接初始化与协议版本协商。
2. RPC request/response correlation。
3. 方法注册和参数验证。
4. session 订阅集合。
5. receipt 缓存。
6. 控制命令优先通道。
7. outgoing queue 背压。
8. 连接关闭清理，但不终止正在运行的 turn。

连接断开不能自动 abort Agent；turn 生命周期独立于 UI 生命周期。

### 3.3 Event Journal

现有 `EventStore` 演进为应用级 Journal：

```ts
interface JournalEvent<T = unknown> {
  eventId: string;        // `${epoch}:${globalSeq}`
  epoch: string;          // App Server 启动实例 id
  globalSeq: number;      // 当前 epoch 内全局递增
  sessionSeq: number;     // 当前 session 内递增
  sessionId?: string;
  turnId?: string;
  topic: EventTopic;
  createdAt: number;
  payload: T;
}
```

设计要求：

- `epoch` 每次 App Server 启动变化。
- `globalSeq` 用于单连接严格排序和全局 cursor。
- `sessionSeq` 用于定位单 session 缺口和调试。
- Journal 与 wrapper 生命周期分离。
- 建议初始限制：最多 20,000 个应用级事件、每 session 最多 2,000 个事件、TTL 30 分钟。
- 累计型文本 delta 保留最新快照或时间片合并；生命周期与工具边界事件不得丢失。
- cursor 不存在、epoch 不匹配或已淘汰时返回 `snapshotRequired`，不能假装补播成功。

### 3.4 前端 AppConnection Store

新增：

```text
components/providers/AgentConnectionProvider.tsx
lib/agent-rpc/client.ts
lib/agent-rpc/store.ts
hooks/useAgentChannel.ts
hooks/useAgentCommand.ts
```

全应用只创建一个 Client 实例：

```text
AgentConnectionProvider
  ├─ 一个 WebSocket
  ├─ 一个 reconnect 状态机
  ├─ 一个全局 cursor
  ├─ sessionId → listeners
  ├─ sessionId → runtime snapshot
  └─ requestId → pending promise
```

ChatWindow 只按 sessionId 订阅 Store，不直接创建 EventSource。

---

## 4. 协议

### 4.1 Envelope

协议采用 Codex 风格双向 RPC，语义兼容 JSON-RPC 2.0，但 DeerHux 保留显式版本字段。外部 transport 使用 JSON；进程内 transport 使用同构 TypeScript 对象。

#### Request

```json
{
  "v": 1,
  "id": "req_01J...",
  "method": "turn/start",
  "params": {}
}
```

#### Response

```json
{
  "v": 1,
  "id": "req_01J...",
  "result": {}
}
```

#### Error Response

```json
{
  "v": 1,
  "id": "req_01J...",
  "error": {
    "code": "SERVER_OVERLOADED",
    "message": "Agent command queue is full",
    "retryable": true,
    "retryAfterMs": 800
  }
}
```

#### Notification

```json
{
  "v": 1,
  "method": "event",
  "params": {
    "eventId": "epoch_abc:1042",
    "globalSeq": 1042,
    "sessionSeq": 87,
    "sessionId": "session_123",
    "turnId": "session_123:t4",
    "topic": "agent/event",
    "createdAt": 1780000000000,
    "payload": {}
  }
}
```

### 4.2 初始化握手

客户端连接后第一条请求必须是 `initialize`：

```json
{
  "v": 1,
  "id": "req_init",
  "method": "initialize",
  "params": {
    "client": {
      "name": "deerhux-web",
      "version": "0.6.x",
      "instanceId": "ui_01J..."
    },
    "protocolVersions": [1],
    "resume": {
      "epoch": "epoch_abc",
      "afterGlobalSeq": 1038
    }
  }
}
```

响应：

```json
{
  "v": 1,
  "id": "req_init",
  "result": {
    "protocolVersion": 1,
    "server": {
      "instanceId": "epoch_abc",
      "version": "0.6.x"
    },
    "resume": {
      "accepted": true,
      "replayedThrough": 1042
    },
    "limits": {
      "maxQueuedCommands": 128,
      "maxSessionCommands": 8
    }
  }
}
```

握手完成前的其他请求统一拒绝为 `NOT_INITIALIZED`。

### 4.3 核心实体

沿用 Codex 的清晰分层，但映射 DeerHux 现有语义：

| 实体 | DeerHux 含义 | 持久化 |
|---|---|---|
| Connection | 一个 UI 实例到 App Server 的连接 | 否 |
| Thread | 一个 DeerHux session | `.jsonl` |
| Turn | 一次 prompt/recover/follow-up 启动的执行 | turnId + session entries |
| Item | user/assistant/tool/compaction/file-change 等条目 | 视类型写 `.jsonl` |
| Request | 一个 RPC 调用 | receipt cache，短期 |
| Event | 一条实时状态变化 | Event Journal，短期 |

禁止把 `connectionId`、`sessionId`、`turnId` 或 `clientMessageId` 混用。

### 4.4 第一阶段方法

#### 连接与订阅

| 方法 | 用途 |
|---|---|
| `initialize` | 握手、版本协商、恢复 cursor |
| `events/subscribe` | 订阅 session 集合或应用级 topic |
| `events/unsubscribe` | 取消部分订阅 |
| `events/ack` | 可选，报告客户端已消费 cursor |
| `ping` | 主动健康检查 |

#### Thread

| 方法 | 现有能力映射 |
|---|---|
| `thread/start` | 创建新 session，不隐式发送 prompt |
| `thread/resume` | `ensureRpcSession(sessionId)` |
| `thread/read` | Runtime snapshot + session revision |
| `thread/list` | session 列表快照 |
| `thread/fork` | 现有 `fork` |
| `thread/navigate` | 现有 `navigate_tree` |
| `thread/archive` | 后续扩展 |

`thread/start` 与 `turn/start` 分离。新会话首条消息仍可由客户端连续调用，或增加一个带幂等 `creationRequestId` 的批处理方法，但服务端内部必须保持两个明确阶段。

#### Turn

| 方法 | 现有命令映射 |
|---|---|
| `turn/start` | `prompt` |
| `turn/interrupt` | `abort` |
| `turn/recover` | `recover` |
| `turn/steer` | `steer` |
| `turn/followUp` | `follow_up` |
| `turn/compact` | `compact` |
| `turn/compactionInterrupt` | `abort_compaction` |

#### Thread 配置

| 方法 | 现有命令映射 |
|---|---|
| `thread/model/set` | `set_model` |
| `thread/thinking/set` | `set_thinking_level` |
| `thread/role/set` | `set_role` |
| `thread/mode/set` | `set_mode` |
| `thread/tools/set` | `set_tools` |
| `thread/subagent/setEnabled` | `set_subagent_enabled` |
| `thread/autoCompaction/set` | `set_auto_compaction` |
| `thread/autoRecovery/set` | `set_auto_recovery_mode` |

### 4.5 `turn/start` 受理语义

请求：

```json
{
  "v": 1,
  "id": "req_turn_1",
  "method": "turn/start",
  "params": {
    "threadId": "session_123",
    "clientMessageId": "msg_01J...",
    "input": {
      "text": "修复这个问题",
      "images": [],
      "references": [],
      "skillName": null
    },
    "roleId": "architect"
  }
}
```

成功响应必须在用户消息完成持久化、turnId 确立并进入运行跟踪后返回：

```json
{
  "v": 1,
  "id": "req_turn_1",
  "result": {
    "accepted": true,
    "duplicate": false,
    "threadId": "session_123",
    "turnId": "session_123:t4",
    "clientMessageId": "msg_01J...",
    "acceptedAt": 1780000000000
  }
}
```

相同 `clientMessageId` 重试：

```json
{
  "accepted": true,
  "duplicate": true,
  "threadId": "session_123",
  "turnId": "session_123:t4",
  "clientMessageId": "msg_01J..."
}
```

这与现有 `lib/rpc-manager.ts:1219-1225` 保持一致。

受理成功不代表 Turn 完成。客户端必须通过通知等待终态，不能依赖请求连接一直保持。

### 4.6 通知 Topic

迁移期先保留现有 `AgentEvent`，避免一次性重写 `handleAgentEvent`：

| Topic | Payload | 说明 |
|---|---|---|
| `agent/event` | 现有 `AgentEvent` | 第一阶段兼容流 |
| `thread/stateChanged` | Runtime 状态 delta | model、role、mode、running 等 |
| `thread/created` | Session 元数据 | 侧栏增量更新 |
| `thread/updated` | Session revision + delta | modified/messageCount/name |
| `thread/deleted` | sessionId | 侧栏删除 |
| `catalog/modelsChanged` | revision | 客户端后台重取或使用附带快照 |
| `catalog/rolesChanged` | cwd + revision | 同上 |
| `command/receipt` | request/clientMessage receipt | 可选的跨连接确认 |
| `server/overloaded` | queue metrics | UI 提示和退避 |
| `server/shuttingDown` | deadline | 优雅重连 |
| `snapshot/required` | scope + reason | cursor 无法补播 |

第二阶段再把 `agent/event` 标准化为：

```text
turn/started
item/started
item/delta
item/completed
turn/completed
```

迁移时不得同时让旧事件和标准化事件重复修改同一份 UI 状态。

---

## 5. 状态机

### 5.1 Connection 状态机

```text
idle
  → connecting
  → initializing
  → ready
  → reconnecting ─────────┐
  → resyncing             │
  → ready ◀───────────────┘
  → closed
```

规则：

- `ready` 前不直接丢弃命令，命令进入客户端 outbox。
- 重连退避：500ms、1s、2s、4s、8s，加入 20% jitter，上限 15s。
- 页面恢复可见时触发一次立即重连，但不能让所有组件各自重连。
- Runtime epoch 变化时进入 `resyncing`，读取正在打开和正在运行 session 的 Snapshot。

### 5.2 Command 状态机

```text
queued_local
  → sending
  → accepted
  → running
  → completed

sending
  → unknown       响应丢失
  → queued_local  查询未受理后安全重试
  → failed        明确不可重试错误
```

`unknown` 状态必须使用 `clientMessageId` 查询/重试，禁止生成新 ID。

### 5.3 Turn 状态机

```text
accepted
  → starting
  → running_model
  ↔ running_tools
  ↔ retry_wait
  ↔ compacting
  → completed
  → failed
  → interrupted
```

Server 必须保证每个 accepted turn 最终产生一个终态；Runtime 异常退出时由 supervisor 合成 `failed` 或要求 Snapshot 恢复。

---

## 6. 背压与资源限制

### 6.1 命令队列

建议初始限制：

```text
全局普通命令队列：128
单 session 普通命令队列：8
控制命令队列：32
单 session 同时运行 turn：1
全局同时运行主 Agent：按现有 LLM permit 限制
```

队列分两条 lane：

1. **control lane**：`turn/interrupt`、shutdown、ping，优先处理。
2. **normal lane**：turn/start、配置变更、读取请求。

过载返回：

```ts
{
  code: "SERVER_OVERLOADED",
  retryable: true,
  retryAfterMs: number,
  details: { queueDepth, capacity, scope }
}
```

不能返回模糊 500，也不能无界等待。

### 6.2 出站事件队列

每条连接使用有界 outgoing queue。事件分级：

| 级别 | 事件 | 策略 |
|---|---|---|
| Critical | receipt、turn 终态、tool 边界、错误、snapshotRequired | 不丢；无法入队则断开慢客户端并要求重同步 |
| Coalescible | `message_update`、context usage、状态计数 | 按 session/turn/topic 覆盖旧值 |
| Ephemeral | heartbeat、重复进度 | 可丢 |

`MessageUpdateCoalescer` 当前位于 `lib/agent-runtime/event-coalescer.ts:1-45`，可迁移到 Broker 传输边界继续使用。

### 6.3 慢客户端

慢客户端不能反向阻塞 Agent 主循环。

处理顺序：

1. 合并可覆盖事件。
2. 丢弃 ephemeral 事件。
3. 若 critical 事件仍无法入队，发送或记录 `snapshotRequired` 后关闭连接。
4. 客户端重连读取 Snapshot。

---

## 7. Snapshot 与重放

### 7.1 Thread Snapshot

```ts
interface ThreadSnapshot {
  threadId: string;
  revision: string;
  sessionFileRevision: { mtimeMs: number; size: number };
  messages: SessionMessage[];
  entryIds: string[];
  runtime: {
    loaded: boolean;
    isRunning: boolean;
    isStreaming: boolean;
    isCompacting: boolean;
    stopRequested: boolean;
    model?: { provider: string; id: string };
    roleId?: string | null;
    agentMode: AgentMode;
    thinkingLevel: string;
    contextUsage: unknown;
    activeTurnId?: string;
  };
  cursor: {
    epoch: string;
    globalSeq: number;
    sessionSeq: number;
  };
}
```

读取 Snapshot 时，服务端应先捕获 cursor/revision，再读取状态，最后检查是否发生变化；如果发生变化，重试一次或返回明确 revision，让客户端继续消费该 cursor 之后的事件。

### 7.2 恢复算法

```text
连接中断
  → 使用 epoch + afterGlobalSeq initialize
  → Journal 可覆盖缺口
      → replay
      → ready
  → epoch 不同或 cursor 已淘汰
      → snapshotRequired
      → 拉取打开中的 session Snapshot
      → 拉取 running sessions Snapshot
      → 更新 cursor
      → ready
```

### 7.3 Snapshot 不应高频全量推送

主聊天只在以下情况读取完整 Snapshot：

- 初次打开 session。
- epoch 改变。
- cursor 淘汰。
- 检测到 sessionSeq 缺口。
- 用户手动刷新。
- 极低频最终一致性校验。

正常运行只消费 Delta。

---

## 8. 进程与 Transport

### 8.1 为什么不直接修改 Next standalone 的 Upgrade

当前生产入口只是：

```js
require(path.join(standaloneDir, "server.js"));
```

见 `src-tauri/resources/deerhux-server.js:33-34`。

Next 16 standalone 没有向项目 Route Handler 暴露稳定、跨开发与生产一致的 WebSocket Upgrade 注册点。直接 monkey patch standalone server 会造成：

- dev 与 production 行为不同；
- Next 升级脆弱；
- HMR 重复注册；
- 仍未解决 Agent 与 Next 共享进程的问题。

因此 WebSocket listener 属于独立 Agent App Server，不属于 Next Route Handler。

### 8.2 Transport 接口

```ts
interface RpcTransportConnection {
  readonly id: string;
  send(message: ServerEnvelope): Promise<void>;
  onMessage(listener: (message: ClientEnvelope) => void): () => void;
  onClose(listener: (reason?: unknown) => void): () => void;
  close(code?: number, reason?: string): void;
}
```

Broker 不依赖 WebSocket API。

### 8.3 浏览器 WebSocket

建议：

- 只监听 `127.0.0.1`。
- 端口由 supervisor 分配，避免固定端口冲突。
- Next 提供轻量 bootstrap endpoint，返回 URL、短期 token 和 protocolVersion。
- 校验 `Origin`。
- token 只在本机、短 TTL、进程重启后失效。
- 单条消息和图片 payload 设置上限；大图片后续改为文件引用或 upload handle。

### 8.4 Tauri

最终桌面推荐：

```text
React WebView
  ↔ Tauri invoke/event
  ↔ Rust supervisor/bridge
  ↔ Agent App Server stdio 或 Unix Socket
```

但第一阶段可让 Tauri WebView 与浏览器共用 localhost WebSocket，以降低迁移成本。协议层不能依赖具体 transport，后续切换 Tauri IPC 时不改业务 Hook。

### 8.5 进程 Supervisor

职责：

- 启动 Next UI server。
- 启动 Agent App Server。
- 注入 Agent endpoint/token。
- 监控崩溃并带退避重启。
- 退出时优雅 shutdown。
- 防止 dev/HMR 重复 daemon。

生产可由 `src-tauri/src/lib.rs` 管理两个子进程。开发期使用独立 Node supervisor 脚本统一启动，不让 Next instrumentation 承担 daemon 生命周期。

---

## 9. 控制面更新

应用级连接除 Agent 输出外，还应承载轻量失效通知：

```text
thread/created
thread/updated
thread/deleted
catalog/modelsChanged
catalog/rolesChanged
wechat/stateChanged
scheduler/stateChanged
```

通知只携带 revision 或小 delta。大列表由客户端使用 stale-while-revalidate 获取，并保留现有 `lib/client-resilience.ts` 缓存作为冷启动和断线兜底。

这样可逐步移除：

- `components/AppShell.tsx:285` 的 2 秒 running sessions 轮询。
- `components/AppShell.tsx:298` 的 10 秒侧栏刷新。
- `hooks/useAgentStatus.ts:72` 的 2 秒单 session 状态轮询。
- `hooks/useAgentSession.ts:2977` 的 6 秒消息快照轮询。

微信、Scheduler、文件 watch 和协作 Agent 的连接可后续接入，不阻塞第一阶段主链路。

---

## 10. 迁移计划

### Phase 0：协议与测试骨架

新增：

- `lib/agent-app-server/protocol.ts`
- `lib/agent-app-server/broker.ts`
- `lib/agent-app-server/transports/in-process.ts`
- 协议、幂等、过载、补播单元测试

要求：

- 不改现有 UI 行为。
- Broker 先调用当前 `ensureRpcSession()` / `AgentSessionWrapper.send()`。
- 固定 protocol v1 和 error code。

### Phase 1：应用级 Journal 与兼容事件

改造：

- `EventStore` 增加全局 seq、epoch、subscribeAll 和 cursor range。
- wrapper destroy 不再立即删除 Journal。
- `agent/event` 保持现有 payload。
- 增加 Snapshot required 语义。

要求：

- 原 session SSE 继续可用。
- 新旧消费者读取同一个 Journal。

### Phase 2：单一应用级下行连接

先落一个迁移 Transport：

```text
POST 命令 + 应用级 SSE
```

它不是最终方案，只用于先完成：

- 一个 AppConnectionProvider。
- 一个应用级事件连接。
- 多 session multiplex。
- 移除每窗口 EventSource。
- 降频/移除 2 秒和 6 秒轮询。

这样能先解决请求惊群，同时不阻塞 daemon 和 WebSocket。

### Phase 3：双向 WebSocket RPC

- 独立 Agent App Server listener。
- `sendAgentCommand()` 改由 RpcClient 实现，HTTP 作为 fallback。
- outbox 在断线期间保留命令。
- prompt 使用 `clientMessageId` 确认和安全重试。
- control lane 保证 interrupt 低延迟。

### Phase 4：Agent Runtime 进程隔离

- registry、Event Journal、DeerLoopEngine 迁入 daemon。
- Next Route Handler 改成兼容代理或返回迁移提示。
- Tauri supervisor 管理 Next + daemon。
- Agent CPU 压力不再阻塞页面 API。

### Phase 5：标准化 Turn/Item 事件

- `agent/event` 逐步映射为 `turn/*` 和 `item/*`。
- 拆分 `hooks/useAgentSession.ts`：
  - session snapshot
  - turn reducer
  - delivery/outbox
  - recovery
  - controls
- 移除旧 SSE 和兼容 HTTP 命令链路。

### Phase 6：其他实时通道收口

依次接入：

- running session 和侧栏 revision
- 模型与角色 revision
- collaboration run delta
- WeChat 状态
- Scheduler 状态
- 文件 watch topic

禁止一次性把所有模块塞进主协议后再上线。

---

## 11. 错误码

第一版至少定义：

| Code | retryable | 含义 |
|---|---:|---|
| `NOT_INITIALIZED` | false | 未完成握手 |
| `UNSUPPORTED_PROTOCOL` | false | 无共同协议版本 |
| `INVALID_REQUEST` | false | envelope 或参数错误 |
| `METHOD_NOT_FOUND` | false | 未注册方法 |
| `SESSION_NOT_FOUND` | false | session 不存在 |
| `TURN_BUSY` | true | 单 session 已有互斥回合 |
| `SERVER_OVERLOADED` | true | 有界队列已满 |
| `DEADLINE_EXCEEDED` | 视方法 | 服务端 deadline 到期 |
| `REQUEST_CANCELLED` | 视方法 | 请求取消，不等于 turn 自动取消 |
| `MODEL_NOT_FOUND` | false | 模型配置不存在 |
| `CURSOR_EXPIRED` | false | 必须 Snapshot |
| `EPOCH_MISMATCH` | false | Runtime 已重启，必须 Snapshot |
| `INTERNAL_ERROR` | false | 未分类服务端错误 |

错误 response 只能结束 RPC request；Turn 是否结束由 Turn 终态通知决定。

---

## 12. 可观测性

App Server 至少提供：

```text
agent_server_connections
agent_server_reconnects
rpc_requests_total{method,outcome}
rpc_request_duration_ms{method}
command_queue_depth{lane}
command_queue_rejected_total{scope}
outgoing_queue_depth{connection}
events_appended_total{topic}
events_coalesced_total{topic}
events_replayed_total
snapshot_required_total{reason}
active_sessions
active_turns
runtime_event_loop_lag_ms
```

日志关联字段：

```text
serverInstanceId
connectionId
requestId
clientMessageId
sessionId
turnId
eventId
```

不能在日志中记录完整 prompt、图片 base64、API key 或完整 system prompt。

---

## 13. 安全

1. App Server 默认仅绑定 loopback。
2. WebSocket 必须校验短期 token 和 Origin。
3. 所有文件访问继续经过现有 allowed roots。
4. 消息体、图片、队列深度、连接数均设上限。
5. 不允许浏览器传入任意 session 文件路径，只接受经过验证的 sessionId。
6. daemon 的 crash log 和 RPC error 必须脱敏。
7. Tauri IPC 版本仍需验证调用来源，不能因为本地 transport 就跳过参数校验。

---

## 14. 验收标准

### 功能

- 同时打开 4 个 ChatWindow，浏览器只有 1 条 Agent 应用级连接。
- 4 个 session 并行运行，事件按 sessionId 正确分发且互不污染。
- prompt response 丢失后用相同 `clientMessageId` 重试，不重复执行。
- UI 刷新或断线后能补播；补播失效时自动 Snapshot 恢复。
- 切模型、角色、mode、tools 后 UI 不依赖轮询刷新。
- interrupt 在普通命令队列拥堵时仍可被优先处理。

### 稳定性

- Agent Runtime CPU 满载时，Next 页面与 session 列表仍能响应。
- 队列满时明确返回 `SERVER_OVERLOADED`，不存在静默吞消息。
- 慢客户端不会让 Agent Runtime 的事件循环或模型工具循环阻塞。
- wrapper 空闲回收后，最近事件仍可补播到 Journal TTL 到期。
- daemon 重启后客户端检测 epoch 改变并恢复 Snapshot。

### 性能

- 正常运行期间删除每窗口 2 秒状态轮询和 6 秒消息轮询。
- 连续 `message_update` 在传输边界合并到每 16-50ms 最多一帧。
- 不因累计完整消息在 Journal 中形成平方内存增长。
- 侧栏和 running session 使用 delta/revision，不每 2 秒拉全量列表。

### 工程

- Transport 可替换，Broker 测试不依赖真实 WebSocket。
- 不运行 `next build`；开发验证使用 TypeScript、ESLint、专项测试和 `git diff --check`。
- 迁移每个 Phase 均可独立回滚到旧 HTTP + SSE 链路。

---

## 15. 禁止项

1. 禁止把所有上行操作改成 SSE；SSE 不支持客户端上行。
2. 禁止每个 session 建一个 WebSocket；目标是应用级 multiplex。
3. 禁止在每个 token 时推送完整 session Snapshot。
4. 禁止无界命令队列和无界 outgoing queue。
5. 禁止把连接关闭等同于 abort turn。
6. 禁止 wrapper destroy 时立即清空可补播事件。
7. 禁止依赖 Next standalone 私有实现 monkey patch WebSocket Upgrade。
8. 禁止先删除现有 HTTP/SSE fallback，再验证新链路。
9. 禁止让 React 组件各自实现重连、cursor 和重试状态机。
10. 禁止为了协议整洁一次性重写 DeerLoopEngine；先以 adapter 收口边界。

---

## 16. 第一批建议实施项

按风险和收益排序：

1. 新增 protocol v1 类型、错误码和 envelope validator。
2. 新增 in-process Broker，直接适配当前 `AgentSessionWrapper.send()`。
3. 将现有 EventStore 演进为 application journal，增加 `epoch/globalSeq/subscribeAll`。
4. 修复 Event Journal 与 wrapper destroy 的生命周期耦合。
5. 新增应用级 SSE 兼容 endpoint 和 `AgentConnectionProvider`，先合并所有 session EventSource。
6. 用应用级通知替换 AppShell running session 2 秒轮询。
7. 用连接 cursor + Snapshot fallback 替换 6 秒消息恢复轮询。
8. 再落独立 WebSocket Agent App Server 与进程 supervisor。

这条顺序先消除连接和轮询惊群，再完成双向命令和进程隔离；每一步都复用当前已经验证的幂等、持久化和事件处理能力。
