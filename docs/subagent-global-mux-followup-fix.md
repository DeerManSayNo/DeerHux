# 子 Agent 全局 SSE Mux 收尾修复开发文档

## 1. 任务目标

修复 DeerHux 子 Agent 实时状态接入全局 SSE Mux 后剩余的两个问题：

1. 全局 Mux 推送一个前端尚未加载的全新 Run 时，`ChatWindow` 会忽略它，导致新子 Agent 卡片可能不出现。
2. `SubagentRunCard` 已经可以从全局 Mux 获得实时状态，但仍然为每个 Run 创建独立 SSE，造成重复连接和重复状态更新。

修复后必须满足：

- 主 Chat 和子 Agent 实时状态继续共用单条全局 `/api/agent/events` SSE。
- 新创建的子 Agent Run 能立即出现在所属 Chat 中。
- 每个未知 Run 最多触发一次并发详情请求。
- `SubagentRunCard` 不再创建 `/api/agent-runs/[runId]/events` EventSource。
- 不恢复周期轮询。
- 不修改主 Chat 的流式 Mux、Markdown 或 32ms/64ms 渲染逻辑。

---

## 2. 当前架构

当前浏览器主实时通道：

```text
多个 Agent Session / Collaboration Run
        |
        v
hostEventBus + Agent EventStore
        |
        v
GET /api/agent/events
单条全局 SSE
        |
        v
lib/agent-event-client.ts
AgentEventClient 单例
        |
        +-- subscribeAgentEvents(sessionId)
        +-- subscribeHostEvents()
        +-- subscribeSessionTransient(sessionId)
        +-- subscribeSubagentRuns(parentSessionId)
```

`ChatWindow` 已经使用：

```ts
subscribeSubagentRuns(sessionId, listener)
```

获取：

- `subagent_runs_snapshot`
- `subagent_run_update`

因此子 Agent 卡片不需要再创建独立 SSE。

---

## 3. 当前问题

### 3.1 未知 Run 被直接忽略

文件：

`components/ChatWindow.tsx`

当前 `applyCollaborationMuxRuns()` 中存在类似逻辑：

```ts
const previous = byId.get(snapshot.runId);
if (!previous || previous.updatedAt > snapshot.updatedAt) continue;
```

当全局 Mux 推送刚创建的新 Run 时，本地 `liveCollaborationRuns` 还没有该 Run：

```text
previous = undefined
```

随后代码直接 `continue`，新 Run 不会加入状态。

`CollaborationMuxSnapshot` 是安全白名单快照，只包含：

```text
runId
status
title
workflow
workers 轻量状态
updatedAt
```

它不包含完整 `CollaborationRunSnapshot` 所需的：

```text
createdAt
mode
parentEntryId
worker task
其他详情
```

因此不能用假的默认字段直接拼出完整 Run。正确方式是：

> 收到未知 `runId` 时，通过详情 API 水合一次，再由后续 Mux 快照持续更新。

### 3.2 SubagentRunCard 仍创建独立 SSE

文件：

`components/SubagentRunCard.tsx`

当前存在：

```ts
new EventSource(`/api/agent-runs/${run.runId}/events`)
```

这导致：

```text
1 条全局 /api/agent/events SSE
+ N 条 /api/agent-runs/[runId]/events SSE
```

同一个 Run 同时被两条实时链路更新：

```text
全局 Mux -> ChatWindow -> Props
Run SSE   -> SubagentRunCard 本地状态
```

会造成：

- 重复连接；
- 重复 React 更新；
- 两条链路的事件顺序竞争；
- 全局 Mux 重构收益下降。

---

## 4. 修改范围

必须修改：

```text
components/ChatWindow.tsx
components/SubagentRunCard.tsx
scripts/test-perf-mux-ui-contracts.ts
```

可选修改：

```text
app/api/agent-runs/[runId]/events/route.ts
```

本任务默认不删除该兼容 API 路由。只要客户端不再使用它即可。确认没有其他消费者后，未来可单独删除。

不要修改：

```text
app/api/agent/events/route.ts
lib/agent-event-client.ts
lib/agent-runtime/event-coalescer.ts
hooks/useAgentSession.ts
components/MessageView.tsx
```

除非类型检查明确要求极小的类型适配。

---

## 5. ChatWindow 未知 Run 水合方案

### 5.1 增加正在水合的 Run 集合

文件：

`components/ChatWindow.tsx`

在组件中增加：

```ts
const hydratingRunIdsRef = useRef<Set<string>>(new Set());
```

用途：

- 同一个未知 Run 可能连续收到多个 Mux 更新；
- 在详情请求返回前，只允许一个请求在飞；
- 防止每帧都请求 `/api/agent-runs/[runId]`。

### 5.2 增加详情水合函数

实现一个稳定的 `useCallback`：

```ts
const hydrateCollaborationRun = useCallback(async (runId: string) => {
  if (hydratingRunIdsRef.current.has(runId)) return;
  hydratingRunIdsRef.current.add(runId);

  try {
    const response = await fetch(
      `/api/agent-runs/${encodeURIComponent(runId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;

    const run = await response.json() as CollaborationRunSnapshot;

    // Session 已切换时不得把旧 Session 的 Run 写入新 Chat。
    // 具体实现见后文 Session 世代保护。
    mergeLiveCollaborationRuns([run]);
  } catch {
    // 瞬时失败保持静默；下一次 Mux 更新允许再次触发水合。
  } finally {
    hydratingRunIdsRef.current.delete(runId);
  }
}, [mergeLiveCollaborationRuns]);
```

不要使用 `setInterval`，不要循环重试。

请求失败后，从 Set 删除；如果后续仍收到该 Run 的 Mux 更新，可以再次尝试。

### 5.3 增加 Session 世代保护

仅检查 `session?.id` 的闭包值不够稳妥，因为异步请求返回时用户可能已经切换 Chat。

增加 Ref：

```ts
const collaborationSessionIdRef = useRef<string | null>(session?.id ?? null);
```

同步当前 Session：

```ts
useEffect(() => {
  collaborationSessionIdRef.current = session?.id ?? null;
  hydratingRunIdsRef.current.clear();
}, [session?.id]);
```

水合开始前捕获：

```ts
const expectedSessionId = collaborationSessionIdRef.current;
```

应用详情前检查：

```ts
if (!expectedSessionId) return;
if (collaborationSessionIdRef.current !== expectedSessionId) return;
```

同时验证详情确实属于当前父 Session。若 `CollaborationRunSnapshot` 有 `parentSessionId`：

```ts
if (run.parentSessionId !== expectedSessionId) return;
```

如果类型允许 `parentSessionId` 缺失，则至少在存在时校验：

```ts
if (run.parentSessionId && run.parentSessionId !== expectedSessionId) return;
```

这样可避免：

```text
Session A 发起 Run 详情请求
用户切换到 Session B
A 的请求返回
A 的 Run 被写入 B 的 ChatWindow
```

### 5.4 未知 Run 到达时触发水合

调整 `applyCollaborationMuxRuns()`。

当前未知 Run 不能再静默忽略。目标逻辑：

```ts
const previous = byId.get(snapshot.runId);

if (!previous) {
  void hydrateCollaborationRun(snapshot.runId);
  continue;
}

if (previous.updatedAt > snapshot.updatedAt) continue;
```

但要注意 React State updater 必须保持纯净：

```ts
setLiveCollaborationRuns((current) => {
  // 不建议在这里直接 fetch
});
```

不要在 State updater 内发起网络副作用。推荐在进入 updater 前先找出未知 Run，或者先维护一个最新 Run ID Ref。

### 5.5 推荐实现：维护实时 Run Map Ref

为了在 Mux Listener 中同步判断未知 Run，增加：

```ts
const liveCollaborationRunsRef = useRef<Map<string, CollaborationRunSnapshot>>(new Map());
```

每次更新 State 时同步 Ref。可以抽一个统一提交函数：

```ts
const commitLiveCollaborationRuns = useCallback((
  updater: (current: Map<string, CollaborationRunSnapshot>) => Map<string, CollaborationRunSnapshot>,
) => {
  const next = updater(new Map(liveCollaborationRunsRef.current));
  liveCollaborationRunsRef.current = next;
  setLiveCollaborationRuns(
    [...next.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
  );
}, []);
```

不过这会扩大重构范围。允许使用更小的方案：

```ts
const knownRunIdsRef = useRef<Set<string>>(new Set());
```

在所有写入 `liveCollaborationRuns` 的入口同步维护它。

推荐最小实现：

```ts
const knownRunIdsRef = useRef<Set<string>>(new Set());
```

初始详情集合加载后：

```ts
knownRunIdsRef.current = new Set(runs.map((run) => run.runId));
setLiveCollaborationRuns(runs);
```

详情水合成功后：

```ts
knownRunIdsRef.current.add(run.runId);
mergeLiveCollaborationRuns([run]);
```

删除墓碑到达后：

```ts
knownRunIdsRef.current.delete(snapshot.runId);
```

Session 切换后：

```ts
knownRunIdsRef.current.clear();
hydratingRunIdsRef.current.clear();
```

Mux 更新前：

```ts
const unknownRunIds = incoming
  .filter((snapshot) => snapshot.status !== "removed")
  .filter((snapshot) => !knownRunIdsRef.current.has(snapshot.runId))
  .map((snapshot) => snapshot.runId);

for (const runId of unknownRunIds) {
  void hydrateCollaborationRun(runId);
}
```

然后 `applyCollaborationMuxRuns()` 只负责更新已经水合的 Run。

### 5.6 保存水合期间收到的最新 Mux 快照

这是必须处理的竞态：

```text
Mux 快照 S1 到达，发现未知 Run，开始详情请求
Mux 快照 S2 到达，Run 仍未知
详情 API 返回的数据可能比 S2 更旧
```

如果只应用详情，UI 可能短暂或永久回退到旧状态，直到下一条 Mux 更新。

增加：

```ts
const pendingRunMuxSnapshotsRef = useRef<Map<string, CollaborationMuxSnapshot>>(new Map());
```

未知 Run 的每次 Mux 快照都保存最新值：

```ts
const previousPending = pendingRunMuxSnapshotsRef.current.get(snapshot.runId);
if (!previousPending || previousPending.updatedAt <= snapshot.updatedAt) {
  pendingRunMuxSnapshotsRef.current.set(snapshot.runId, snapshot);
}
```

详情水合成功后：

1. 先加入完整详情；
2. 读取该 Run 最新 pending Mux；
3. 将 pending Mux 合并到完整详情；
4. 删除 pending；
5. 更新 State。

需要复用一个纯函数合并快照，避免两处逻辑不一致：

```ts
function mergeCollaborationMuxSnapshot(
  previous: CollaborationRunSnapshot,
  snapshot: CollaborationMuxSnapshot,
): CollaborationRunSnapshot {
  if (previous.updatedAt > snapshot.updatedAt) return previous;

  const details = new Map(
    previous.workers.map((worker) => [worker.workerId ?? worker.name, worker]),
  );

  return {
    ...previous,
    title: snapshot.title ?? previous.title,
    status: snapshot.status === "removed" ? "aborted" : snapshot.status,
    workflow: snapshot.workflow,
    updatedAt: snapshot.updatedAt,
    workers: snapshot.workers.map((worker) => ({
      ...details.get(worker.workerId ?? worker.name),
      ...worker,
      task: details.get(worker.workerId ?? worker.name)?.task ?? "",
    })),
  };
}
```

对于 `removed`：

- 不应水合；
- 从已知集合、pending Map 和 State 中删除；
- 不保留幽灵卡片。

### 5.7 Authoritative 集合快照处理

`subagent_runs_snapshot` 是当前父 Session 的权威集合。

处理权威快照时：

- 权威快照中缺失的 Run 应从实时集合删除；
- 对快照中未知的 Run 逐个水合；
- 删除不再存在 Run 的 pending 快照和水合标记；
- 已知 Run 正常应用 Mux 增量。

不要因为权威快照只含轻量字段就用它完全替换完整 `CollaborationRunSnapshot`。

推荐行为：

```text
权威快照决定哪些 runId 存在
详情 API 提供完整 Run 骨架
Mux 快照更新实时白名单字段
```

### 5.8 初始列表请求与 Mux 的竞态

当前会同时进行：

```text
GET /api/agent-runs?parentSessionId=...
subscribeSubagentRuns(...)
```

必须避免初始 GET 的旧结果覆盖已经由 Mux/水合加入的新 Run。

不要简单执行：

```ts
setLiveCollaborationRuns(runs);
```

应按 `runId + updatedAt` 合并初始结果：

```ts
mergeLiveCollaborationRuns(runs);
```

只有明确收到 `subagent_runs_snapshot` 权威基线时，才按权威 runId 集合删除缺失项。

初始 HTTP 列表可以作为详情集合，但它返回时不能删除在请求期间新出现的 Run。

---

## 6. SubagentRunCard 去除独立 SSE

### 6.1 删除 EventSource Effect

文件：

`components/SubagentRunCard.tsx`

删除整个创建独立 SSE 的 Effect，包括：

```ts
new EventSource(`/api/agent-runs/${run.runId}/events`)
```

以及对应：

```text
es.onmessage
es.onerror
es.close
closedRef
cancelled
```

### 6.2 卡片变为 Props 驱动

`SubagentRunCard` 应只根据父组件传入的 `run` 渲染。

如果保留本地 `latest` 状态，应仅用于平滑合并 Props：

```ts
useEffect(() => {
  setLatest((previous) => {
    if (run.updatedAt < previous.updatedAt) return previous;
    return run;
  });
}, [run]);
```

更推荐直接使用：

```ts
const latest = run;
```

因为实时合并和版本判断已经由 `ChatWindow` 统一负责。避免父级和卡片各维护一套状态真相。

如果卡片存在纯 UI 本地状态，例如：

- 展开/折叠；
- 横向滚动位置；
- Hover；

这些可以保留。

### 6.3 是否保留一次详情 fetch

默认建议：不在 `SubagentRunCard` 内请求详情。

完整详情统一由 `ChatWindow` 水合，这样：

- 每个 Run 只有一个详情请求入口；
- 更容易去重；
- 卡片保持纯展示；
- 历史卡片和活跃卡片行为一致。

若现有卡片依赖某些仅详情 API 存在的字段，应确保 `ChatWindow` 水合后再把完整 `CollaborationRunSnapshot` 传入卡片。

---

## 7. 兼容 API 路由

文件：

`app/api/agent-runs/[runId]/events/route.ts`

本任务默认保留该路由，不主动删除，原因：

- 可能有外部或旧客户端使用；
- 删除属于 API 兼容性变更；
- 当前目标只需保证 DeerHux 主客户端不再连接它。

可以添加废弃注释：

```ts
/** @deprecated DeerHux UI uses the tab-global /api/agent/events mux. */
```

但不是必须。

---

## 8. 不允许的实现

不得执行：

- 不得为每个 Run 继续创建 EventSource。
- 不得恢复 `setInterval(fetchRuns, 1200)` 或其他周期轮询。
- 不得为未知 Run 构造包含假 `createdAt`、假 `mode` 的伪完整对象。
- 不得在 React State updater 内直接发起 fetch。
- 不得让同一未知 Run 并发发起多个详情请求。
- 不得让 Session A 的延迟请求结果写入 Session B。
- 不得用旧详情覆盖更新的 Mux 快照。
- 不得删除全局 `/api/agent/events` Mux。
- 不得改回 `/api/agent/[id]/events` 会话级 SSE。
- 不得修改主 Chat 的 32ms/64ms 流式渲染策略。
- 不得修改流式 Markdown 实现。
- 开发期间不得运行 `next build`。

---

## 9. 自动测试

修改：

`scripts/test-perf-mux-ui-contracts.ts`

### 9.1 禁止 Run 独立 SSE

增加：

```ts
const subagentCard = source("components/SubagentRunCard.tsx");

assert.doesNotMatch(
  subagentCard,
  /new EventSource\(`\/api\/agent-runs\/\$\{run\.runId\}\/events`\)/,
);
```

也可以使用更宽泛断言：

```ts
assert.doesNotMatch(subagentCard, /new EventSource/);
```

### 9.2 必须存在未知 Run 水合

源码契约至少断言：

```ts
assert.match(chatWindow, /hydratingRunIdsRef/);
assert.match(chatWindow, /pendingRunMuxSnapshotsRef/);
assert.match(chatWindow, /\/api\/agent-runs\/\$\{encodeURIComponent\(runId\)\}/);
assert.match(chatWindow, /subscribeSubagentRuns/);
```

### 9.3 禁止周期轮询

继续保留：

```ts
assert.doesNotMatch(chatWindow, /setInterval\(fetchRuns/);
```

并增加对卡片的检查：

```ts
assert.doesNotMatch(subagentCard, /setInterval/);
```

### 9.4 推荐增加纯函数测试

如果将 Mux 合并逻辑抽成导出纯函数，例如：

```ts
mergeCollaborationMuxSnapshot(previous, snapshot)
```

建议新增脚本：

```text
scripts/test-collaboration-mux-ui.ts
```

测试：

1. 较新 Mux 覆盖旧状态；
2. 较旧 Mux 不覆盖新状态；
3. Worker 轻量状态更新时保留详情中的 `task`；
4. 权威空 `workers` 会清空旧 Worker，而不是保留幽灵数据；
5. `removed` 会删除 Run；
6. 水合期间 S1、S2 到达，详情返回后应用 S2；
7. Session 切换后旧详情被丢弃。

如果不抽纯函数，至少完成源码契约和人工测试。

---

## 10. 验证命令

禁止运行 `next build`。

运行核心测试：

```bash
npm run test:core
```

类型检查：

```bash
node_modules/.bin/tsc --noEmit
```

代码检查：

```bash
npm run lint
```

Diff 格式检查：

```bash
git diff --check
```

---

## 11. 人工验收

启动：

```bash
npm run dev
```

### 11.1 新 Run 出现

1. 打开一个 Chat；
2. 确保当前还没有子 Agent Run；
3. 触发主 Agent 创建子 Agent；
4. 不刷新页面；
5. 新子 Agent 卡片必须自动出现。

### 11.2 连续更新

子 Agent 运行期间确认：

- Worker 状态持续更新；
- 活动工具持续更新；
- 完成后状态及时变为终态；
- 不出现重复卡片；
- 不出现卡片先完成后又回退到运行中。

### 11.3 快速创建多个 Run

快速创建 2～5 个子 Agent Run：

- 每个 Run 都出现；
- 每个 runId 最多一个详情请求同时在飞；
- 不串 Worker；
- 不丢 Run；
- 不产生重复 Run。

### 11.4 Session 切换

1. Session A 创建子 Agent，详情请求尚未完成时切换 Session B；
2. A 的请求返回后，A 的 Run 不能出现在 B；
3. 切回 A 后可通过 Mux 基线或详情重新恢复。

### 11.5 Network 检查

浏览器 Network 中：

必须只有主实时通道：

```text
GET /api/agent/events
```

允许按需出现一次性详情请求：

```text
GET /api/agent-runs/[runId]
GET /api/agent-runs?parentSessionId=...
```

不得出现由 DeerHux Chat UI 创建的：

```text
GET /api/agent-runs/[runId]/events
```

### 11.6 重连

断开并恢复 `/api/agent/events`：

- 子 Agent 集合通过权威基线恢复；
- 未知 Run 会自动水合；
- 已删除 Run 不出现幽灵卡片；
- 不创建 Run 独立 SSE 作为兜底。

---

## 12. 完成标准

同时满足以下条件才算完成：

1. 新 Run 的未知 Mux 快照会触发详情水合。
2. 同一 Run 不会并发重复水合。
3. 水合期间只保留并应用最新 Mux 快照。
4. Session 切换后旧请求结果不会污染新 Session。
5. 权威集合快照能删除缺失 Run 并水合新增 Run。
6. 初始 HTTP 列表不会覆盖请求期间新出现的 Run。
7. `SubagentRunCard` 不再创建 EventSource。
8. DeerHux Chat UI 不再请求 `/api/agent-runs/[runId]/events`。
9. 子 Agent 实时状态全部来自全局 `/api/agent/events` Mux。
10. 不存在周期 Run 轮询。
11. `npm run test:core` 通过。
12. `node_modules/.bin/tsc --noEmit` 通过。
13. `npm run lint` 无 Error。
14. `git diff --check` 通过。
