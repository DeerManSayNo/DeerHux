# SSE 可观测性补齐开发文档

> 面向后续 AI 编码代理。目标是在不改变 SSE 业务语义、不引入外部监控依赖的前提下，让断线、回放、快照恢复、缓存溢出、慢消费者和 Journal 淘汰都可解释、可测试。

## 1. 先读这些文件

| 文件 | 作用 |
|---|---|
| `app/api/agent/events/route.ts` | 全局 SSE 服务端入口；连接、回放、基线、心跳、背压 |
| `lib/agent-runtime/transport-diagnostics.ts` | 现有 SSE 进程内指标，仅有连接数和慢消费者数 |
| `lib/agent-runtime/event-store.ts` | 进程内有界事件 Journal；epoch、globalSeq、淘汰和回放 |
| `lib/agent-runtime/event-coalescer.ts` | SSE 边界的 `message_update` 合并 |
| `lib/agent-runtime/sse-backpressure.ts` | 1 MB high-water mark、8 MB 慢消费者上限 |
| `lib/agent-event-client.ts` | 浏览器单连接 Mux、cursor、重连和恢复状态机 |
| `lib/agent-runtime/session-event-buffer.ts` | 无监听 Session 的浏览器端有界缓存 |
| `lib/agent-runtime/recovery-buffer.ts` | Snapshot 恢复期间的事件筛选 |
| `app/api/runtime/diagnostics/route.ts` | 已有服务端诊断 JSON 入口 |
| `scripts/runtime-soak-monitor.mjs` | 已有长时间采样脚本 |
| `scripts/test-event-store.ts` | EventStore 行为测试 |
| `scripts/test-stream-event-performance.ts` | Journal 和 coalescer 性能测试 |
| `scripts/test-perf-mux-ui-contracts.ts` | Mux 客户端静态契约测试 |

## 2. 当前数据边界

必须保持以下三层分离：

```text
Session JSONL          长期会话事实，可跨进程重启
EventStore             进程内短期 Journal，可按 epoch/globalSeq 回放
SSE + sessionStorage   网络传输 + 当前浏览器标签页消费游标
```

可观测性只记录元数据，不得记录消息正文、thinking、工具参数/结果、API Key、cwd 或 Session JSONL 内容。

## 3. 实施原则

1. 扩展现有 `globalThis` 进程内 diagnostics，不新增依赖。
2. Counter 只增不减；Gauge 表示当前状态；Max 表示进程生命周期峰值。
3. 指标维度只能使用固定枚举。禁止永久维护按 `sessionId`、`runId`、`turnId` 或任意事件类型增长的 Map。
4. 服务端指标与浏览器端指标分开。`app/api/runtime/diagnostics` 无法直接读取用户浏览器内存。
5. 先补服务端和测试，再补客户端诊断；不要顺便重写恢复状态机。
6. 保持现有 API 字段兼容，已有字段只增不删、不改名。
7. diagnostics 的读取必须便宜，不遍历事件正文或执行文件 I/O。
8. 开发期间禁止运行 `next build`。

---

## 4. 第一阶段：服务端最小闭环，P0

### 4.1 扩展 Transport Diagnostics

修改 `lib/agent-runtime/transport-diagnostics.ts`。保留现有字段，并补齐以下结构。字段名可按现有风格微调，但语义不可缺失。

```ts
interface TransportDiagnostics {
  // 已有兼容字段
  activeSseConnections: number;
  openedSseConnections: number;
  closedSseConnections: number;
  slowConsumerDrops: number;

  // 连接生命周期
  activeSseConnectionsPeak: number;
  connectionAbortsTotal: number;
  connectionWriteErrorsTotal: number;
  connectionDurationMsTotal: number;
  connectionDurationMsMax: number;

  // 建连结果
  freshConnectionsTotal: number;
  resumedConnectionsTotal: number;
  snapshotRequiredTotal: number;
  snapshotRequiredByReason: Record<SnapshotReason, number>;

  // 回放
  replayRequestsTotal: number;
  replayEventsTotal: number;
  replayBytesTotal: number;
  replayEmptyTotal: number;
  replayEventsMax: number;
  replayBytesMax: number;
  replayDurationMsTotal: number;
  replayDurationMsMax: number;
  replayLagEventsMax: number;

  // 发送
  framesSentTotal: number;
  bytesSentTotal: number;
  agentEventFramesSentTotal: number;
  controlFramesSentTotal: number;
  heartbeatFramesSentTotal: number;
  minimumDesiredSizeObserved: number | null;
  slowConsumerDropsByPhase: Record<SsePhase, number>;
}

type SnapshotReason =
  | "epoch_mismatch"
  | "invalid_cursor"
  | "cursor_ahead"
  | "cursor_evicted"
  | "unknown";

type SsePhase = "replay" | "live" | "baseline" | "heartbeat";
```

实现要求：

- 提供小粒度记录函数，不允许路由直接修改共享对象。
- `getTransportDiagnostics()` 返回副本，包括嵌套对象副本。
- 关闭连接的函数保持幂等。
- 发送字节按实际 `TextEncoder.encode()` 后的 `Uint8Array.byteLength` 记录。
- `minimumDesiredSizeObserved` 仅作近似背压诊断，不命名为精确队列字节。
- diagnostics 同时返回 `SSE_HIGH_WATER_MARK_BYTES` 和 `SSE_MAX_QUEUED_BYTES` 配置值，便于解释阈值。

### 4.2 在 SSE 路由埋点

修改 `app/api/agent/events/route.ts`：

| 位置 | 必须记录 |
|---|---|
| `GET()` 开始 | 生成 `connectionId`；连接打开、开始时间、活跃峰值 |
| `cleanup()` | 连接时长；关闭原因只能记录一次 |
| `req.signal abort` | `connectionAbortsTotal` |
| `controller.enqueue` 失败 | `connectionWriteErrorsTotal` |
| `send()` | 帧数、编码后字节数、阶段、最小 `desiredSize` |
| 无 cursor 分支 | `freshConnectionsTotal` |
| cursor 可恢复 | `resumedConnectionsTotal`、replay 数量/字节/耗时/lag |
| replay 为空 | `replayEmptyTotal` |
| `snapshotRequired` | 总数及 reason |
| 慢消费者关闭 | 总数及当前 phase |
| 心跳成功 | `heartbeatFramesSentTotal` |
| 控制面基线 | 以 `baseline` phase 统计帧和字节 |

建议让 `send()` 接受明确的 phase/type 参数，不通过 payload 猜测：

```ts
send(value, { eventId, phase: "replay", kind: "agent_event" });
```

`connectionId` 应放进 `connected` 和 `snapshot_required` 控制帧，方便客户端关联；若修改共享类型，同时更新 `lib/agent-event-client.ts` 类型定义。不得把 connectionId 当作可恢复游标。

### 4.3 扩展 EventStore Diagnostics

修改 `lib/agent-runtime/event-store.ts` 的 `diagnostics()`：

```ts
{
  // 保留现有字段
  globalEvents,
  globalRetainedBytes,
  sessionBuckets,
  sessionEvents,
  sessionRetainedBytes,
  runBuckets,
  runEvents,
  runRetainedBytes,
  listeners,

  // 新增状态与容量
  epoch,
  earliestGlobalSeq,
  latestGlobalSeq,
  oldestGlobalEventAgeMs,
  newestGlobalEventAgeMs,
  limits: {
    maxGlobalEvents,
    maxGlobalBytes,
    maxEventsPerSession,
    maxSessionBytes,
    maxEventsPerRun,
    maxRunBytes,
    globalTtlMs,
    sessionTtlMs,
    runTtlMs
  },
  utilization: {
    globalEvents: number,
    globalBytes: number
  },
  evictions: {
    global: EvictionCounters,
    session: EvictionCounters,
    run: EvictionCounters
  }
}

type EvictionCounters = {
  total: number;
  ttl: number;
  eventLimit: number;
  byteLimit: number;
  clear: number;
};
```

淘汰埋点要求：

- 在 `prune()`、`trimGlobal()`、`trimBucket()`、`clearAll()` 的实际删除点记录。
- 同一次删除只计一个主原因；当条数和字节同时超限时，按触发删除前的判断顺序归类并保持测试稳定。
- `message_update` 合并替换不是淘汰，不增加 eviction。
- `earliestGlobalSeq` 使用当前可恢复边界语义，不把合并覆盖区间误判为淘汰。
- `oldestGlobalEventAgeMs` 无事件时返回 `0`。
- utilization 范围限制为 `0..1`。

### 4.4 扩展诊断 API

修改 `app/api/runtime/diagnostics/route.ts`：

- 保持现有顶层字段。
- `transport` 输出扩展后的 transport diagnostics。
- `journal` 输出扩展后的 EventStore diagnostics。
- 不增加文件 I/O，不返回事件 payload。
- 响应继续 `force-dynamic`、Node.js runtime。

### 4.5 第一阶段测试

新增或扩展脚本测试：

1. `scripts/test-event-store.ts`
   - TTL、条数、字节、clear 的淘汰计数。
   - 合并不增加淘汰计数。
   - earliest/latest、age、limits、utilization 正确。
2. 新增 `scripts/test-transport-diagnostics.ts`
   - 打开/关闭幂等、峰值、时长、reason、phase、replay 聚合和深拷贝。
3. 扩展 `scripts/test-perf-mux-ui-contracts.ts`
   - SSE 路由仍先订阅后回放。
   - replay、snapshot、slow consumer 和 heartbeat 埋点存在。
4. 扩展 `scripts/runtime-soak-monitor.mjs`
   - 输出 replay、snapshot required、eviction、slow drop 的起止差值。
   - 兼容字段缺失，避免监控旧进程时报错。

第一阶段验收：仅访问 `/api/runtime/diagnostics` 即可判断连接是否频繁重建、回放是否有效、为什么降级快照、Journal 为何淘汰、是否存在慢消费者。

---

## 5. 第二阶段：浏览器恢复可观测性，P1

### 5.1 新增客户端只读诊断快照

在 `lib/agent-event-client.ts` 内维护固定大小的客户端指标，并导出只读函数：

```ts
export function getAgentEventClientDiagnostics(): AgentEventClientDiagnostics;
```

最小结构：

```ts
interface AgentEventClientDiagnostics {
  connectionState:
    | "idle"
    | "connecting"
    | "connected"
    | "recovering_snapshot"
    | "recovering_listener"
    | "reconnecting";
  connectionId: string | null;
  reconnectAttempt: number;
  reconnectsTotal: number;
  connectionErrorsTotal: number;
  reconnectDelayMsLast: number;
  reconnectDelayMsMax: number;

  cursor: { epoch: string; globalSeq: number } | null;
  barrierReady: boolean;
  duplicateEventsDroppedTotal: number;
  epochMismatchEventsDroppedTotal: number;
  cursorCommitsTotal: number;

  snapshotRecoveryStartedTotal: number;
  snapshotRecoverySucceededTotal: number;
  snapshotRecoveryFailedTotal: number;
  snapshotRecoveryDurationMsTotal: number;
  snapshotRecoveryDurationMsMax: number;
  snapshotRecoveryByReason: Record<ClientRecoveryReason, number>;

  listenerDispatchErrorsTotal: number;
  listenerRecoverySucceededTotal: number;
  listenerRecoveryFailedTotal: number;
  listenerRecoveryRetriesTotal: number;

  recoveryBufferSize: number;
  recoveryBufferPeak: number;
  recoveryBufferOverflowsTotal: number;
  backgroundBuffer: SessionBufferDiagnostics;

  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastMessageAt: number | null;
  lastAgentEventAt: number | null;
  deliveryLatencyMsLast: number;
  deliveryLatencyMsMax: number;
}

type ClientRecoveryReason =
  | SnapshotReason
  | "background_buffer_overflow"
  | "listener_failed"
  | "unknown";
```

埋点位置：

| `lib/agent-event-client.ts` 逻辑 | 记录内容 |
|---|---|
| `ensureConnected()` | connecting、打开次数 |
| `onopen` / `connected` | connected、connectionId、时间、重连归零 |
| `onmessage` | lastMessageAt；Agent event 计算 `Date.now() - createdAt` |
| `snapshot_required` | reason 和 snapshot recovery 开始 |
| recovery buffer 满 | overflow |
| `deliver()` 两个早退 | duplicate 或 epoch mismatch drop |
| `dispatchToListeners()` 失败 | listener error |
| `recoverFromSnapshot()` | 开始、成功、失败、耗时、buffer peak |
| `recoverBackgroundOverflow()` | background overflow 和恢复结果 |
| `recoverListenerFailure()` | retry、成功、失败 |
| `commitCursor()` | commit 数量 |
| `handleDisconnect()` | disconnected 时间、错误次数 |
| `scheduleReconnect()` | 次数、attempt、delay |

约束：

- 不改变 cursor 提交时机。
- 不改变 recovery Promise gate。
- diagnostics 代码不得抛错或触发恢复。
- 延迟使用客户端 `Date.now()`，只作近似值；不作为严格网络时延。
- 事件类型如需分组，只允许固定白名单加 `other`。

### 5.2 给 SessionEventBuffer 增加 diagnostics

修改 `lib/agent-runtime/session-event-buffer.ts`，新增只读方法：

```ts
diagnostics(): SessionBufferDiagnostics;

type SessionBufferDiagnostics = {
  size: number;
  maximum: number;
  sessionCount: number;
  largestSessionSize: number;
  peakSize: number;
  pushedTotal: number;
  drainedTotal: number;
  overflowsTotal: number;
};
```

不得返回 Session ID 或事件内容。`push()` 失败只计一次 overflow，`clear()` 和 `drain()` 分开计数。

### 5.3 客户端指标展示方式

第一版不新增自动上传 API。原因：DeerHux 当前是本地单用户应用，客户端诊断可直接供开发者面板读取，避免上报协议、频率限制和隐私复杂度。

若后续确需跨设备汇总，再新增批量上报，不得逐事件 POST：

```text
POST /api/runtime/client-diagnostics
30～60 秒聚合上报；严重错误可立即上报；页面隐藏时可 sendBeacon。
```

### 5.4 第二阶段测试

优先把纯计数逻辑抽成无 DOM 的小类/函数后测试，不为测试引入完整浏览器框架。覆盖：

1. 正常连接、断线和指数退避。
2. 重复事件与旧 epoch 事件计数。
3. snapshot 成功、失败、重试和恢复期间 buffer overflow。
4. listener 失败后的恢复成功与失败。
5. background buffer push、drain、clear、overflow。
6. diagnostics 返回副本，外部修改不污染内部状态。

第二阶段验收：浏览器端可回答当前连接状态、cursor 位置、重连次数、快照恢复成功率、listener 是否失败、两个 1000 条缓存是否接近或超过上限。

---

## 6. 第三阶段：合并、基线与诊断时间线，P2

### 6.1 Coalescer 指标

修改 `lib/agent-runtime/event-coalescer.ts`，可通过可选 diagnostics recorder 注入，避免绑定全局状态：

```ts
messageUpdatesReceivedTotal
messageUpdatesEmittedTotal
messageUpdatesCoalescedTotal
flushesTotal
timerFlushesTotal
barrierFlushesTotal
pendingStreams
pendingStreamsPeak
flushBatchSizeMax
```

保持默认构造兼容。核心指标：

```text
coalescingRatio = 1 - emitted / received
```

### 6.2 控制面基线指标

在 `app/api/agent/events/route.ts` 记录：

```ts
baselineBuildDurationMsTotal
baselineBuildDurationMsMax
baselineFramesSentTotal
baselineBytesSentTotal
baselineSessionsLast
baselineTransientSnapshotsLast
baselineSubagentParentsLast
baselineSubagentRunsLast
```

可选增强：同一批控制面基线携带相同 `baselineId` 和 `baselineAt`。若实现，客户端只用于关联，不把 baselineId 当顺序游标。

### 6.3 最近异常环形缓冲区

新增 `lib/agent-runtime/diagnostic-events.ts`，仅记录最近 200 条低频诊断事件：

```ts
type DiagnosticEventName =
  | "slow_consumer_dropped"
  | "enqueue_failed"
  | "snapshot_required"
  | "replay_completed"
  | "journal_eviction";
```

每条最多包含：

```ts
{
  timestamp,
  level,
  component,
  event,
  connectionId?,
  sessionIdHash?,
  globalSeq?,
  reason?,
  durationMs?,
  eventCount?,
  byteCount?,
  error?: { name, message }
}
```

要求：

- 固定容量，覆盖最旧项。
- 只记录低频状态变化和异常，不记录每个 token/event。
- ID 对外只返回短哈希；禁止正文和路径。
- `app/api/runtime/diagnostics/route.ts` 最多返回最近 100 条。

---

## 7. 建议的诊断响应结构

保持现有字段，在其内部扩展：

```ts
{
  timestamp,
  process,
  eventLoop,
  sessions,
  journal: {
    // 当前 EventStore 字段
    epoch,
    earliestGlobalSeq,
    latestGlobalSeq,
    limits,
    utilization,
    evictions
  },
  transport: {
    // 当前 transport 字段
    connections,
    replay,
    snapshotRequired,
    sent,
    slowConsumers,
    thresholds
  },
  coalescer?,
  controlPlane?,
  sessionCache,
  mcp,
  recentDiagnosticEvents?
}
```

无需为了嵌套结构立即删除旧平铺字段；先兼容，后续单独迁移。

## 8. 健康判定建议

诊断 UI 或 soak monitor 可按以下阈值标记，不需要服务端主动报警。

### 红色

- snapshot recovery 失败数增加。
- listener recovery 失败数增加。
- `cursor_ahead` 增加。
- recovery/background buffer overflow 增加。
- Journal event 或 byte utilization 超过 95%。
- Session 仍标记 streaming，但 `lastAgentEventAt` 长期无变化。

### 黄色

- Journal utilization 超过 75%。
- 最近采样窗口出现 slow consumer drop。
- `snapshotRequired / (resumed + snapshotRequired) > 5%`。
- 客户端 reconnect attempt 大于等于 3。
- background/recovery buffer utilization 超过 75%。

核心派生指标：

```text
resumeSuccessRate = resumed / (resumed + snapshotRequired)
snapshotRecoverySuccessRate = succeeded / (succeeded + failed)
coalescingRatio = 1 - emitted / received
```

分母为 0 时返回 `null`，不要返回 `NaN`。

## 9. 明确不做

本任务不包含：

- 不把 EventStore 改成数据库或 durable Journal。
- 不迁移 SSE 到 WebSocket。
- 不引入 Prometheus、OpenTelemetry、Sentry 或日志 SDK。
- 不持久化 token/message_update。
- 不重写 `AgentEventClient` 恢复状态机。
- 不新增按 Session 无限增长的指标标签。
- 不采集消息正文和工具内容。
- 不运行 `next build`。

## 10. 推荐提交拆分

1. `feat: expand server SSE transport diagnostics`
2. `feat: expose journal capacity and eviction diagnostics`
3. `test: cover SSE diagnostics and soak metrics`
4. `feat: expose browser agent event diagnostics`
5. `feat: add coalescer and diagnostic event timeline`

每个提交应独立通过类型检查和对应脚本测试，避免一次同时修改服务端、客户端和 UI。

## 11. 完成定义

全部阶段完成后，诊断信息必须能回答：

1. 当前有多少 SSE 连接，连接是否频繁重建？
2. 最近重连是 fresh、resume 还是 snapshot fallback？
3. Snapshot fallback 的具体原因是什么？
4. 单次 replay 补了多少事件和字节，耗时多久？
5. Journal 当前容量、恢复窗口和淘汰主因是什么？
6. 是否有慢消费者，发生在 replay、live、baseline 还是 heartbeat？
7. 客户端 snapshot/listener recovery 是否成功？
8. background 和 recovery buffer 是否溢出？
9. `message_update` 合并实际减少了多少发送？
10. 故障能否通过 connectionId、时间、reason 和 globalSeq 串成一条不含用户内容的诊断链？

验证命令：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
# 运行本任务新增或修改的 scripts/test-*.ts
```

开发期间不要运行 `next build`。
