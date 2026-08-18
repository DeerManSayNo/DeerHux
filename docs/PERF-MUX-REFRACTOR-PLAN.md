# DeerHux 性能与事件流改造计划

> 本文档面向无项目上下文的执行者（AI 或工程师）。请通读「背景」与「现状盘点」后再动手。
> 每个任务标注了涉及文件的精确路径与行号（行号基于撰写时代码，若有偏移请以代码搜索为准）。

---

## 0. 背景问题

用户反馈：**多个 chat 窗口并发时电脑发热严重**。

排查结论（已完成，执行者无需重复排查）：

1. **发热主因是渲染层，不是网络层**。流式输出时每个 token chunk 触发一次 React setState → 消息列表重渲染；消息用 ReactMarkdown 渲染，每次重渲染都重新解析全文 AST。多窗口并发时渲染风暴线性叠加。
2. **后台窗口不降频**。多窗口布局中切走的 ChatWindow 仍保持挂载（`display:none` 不阻止 React 渲染与 effects），光标闪烁、计时器、流式 chunk 处理全速运行。
3. **轮询群持续耗电**。全局 2s 轮询 running 状态、每窗口 500ms 计时 tick、530ms 光标闪烁、subagent 运行时 1.2s 轮询。
4. 连接层**基本健康**：项目已有一条全局多路复用 SSE（见下节），连接配额问题已解决。

## 1. 现状盘点（重要：先读这节再动手）

### 已存在的全局 mux SSE（不要重复建设！）

- 服务端：`app/api/agent/events/route.ts`（133 行）— 全局事件流 `GET /api/agent/events`，支持 `?cursor=` 续传，返回 `snapshot_required` 控制事件
- 客户端：`lib/agent-event-client.ts`（417 行）— `AgentEventClient` 单例，**一个浏览器标签页一条 EventSource 复用所有 session**。已实现：
  - epoch + globalSeq 游标持久化（sessionStorage `deerhux.agent-events.cursor.v1`）
  - 指数退避重连（上限 15s）
  - 恢复缓冲（上限 1000 事件）与 listener 失败恢复
  - `prepare()` 游标屏障（新建 session 前建立）
- 事件信封格式（`MultiplexAgentEvent`）：
  ```ts
  { type: "agent_event", epoch, globalSeq, sessionSeq, sessionId, runId, turnId?, createdAt, event: { type: string, ... } }
  ```
- ChatWindow 不直接建 EventSource；通过 `hooks/useAgentSession.ts` 的 `subscribeAgentEvents()`（L13, L1202）订阅

### 关键文件与热点位置

| 文件 | 位置 | 问题 |
|---|---|---|
| `components/ChatWindow.tsx`（1756 行） | `handleAgentEvent` 经 ref 调用（~L755） | chunk 到达即 setState，无帧批处理 |
| `components/ChatWindow.tsx` | L388 | 光标闪烁 `setInterval 530ms`，后台不暂停 |
| `components/ChatWindow.tsx` | L1064 | 计时器 `setInterval 500ms`，后台不暂停 |
| `components/ChatWindow.tsx` | L526 | subagent 运行时 `setInterval(fetchRuns, 1200)` 轮询 |
| `components/AppShell.tsx` | L285 | **全局** `setInterval(loadRunningSessions, 2000)` 无条件轮询 |
| `components/MessageView.tsx`（1481 行） | L1130-1174 ReactMarkdown | 流式中的消息每 chunk 全文重解析；组件已 `memo`（L146） |
| `components/AppShell.tsx` | L77 `MAX_CHAT_WINDOWS = 6` | 多窗口槽位，切走仍挂载 |
| `app/api/agent/running/route.ts` | — | 2s 轮询的数据源 |
| `app/api/agent/[id]/events/route.ts`（162 行） | — | 旧 per-session SSE，疑似兼容残留（任务 15 确认） |

### 服务端事件源

- `lib/rpc-manager.ts`（2018 行）— `AgentSessionWrapper`（globalThis.__deerhuxSessions 注册表，L1694）；`start()` 内 `inner.subscribe()`（L615-621）是所有 agent 事件的源头；事件最终进入 event-store 供 mux 流读取
- Agent 事件类型：`agent_start` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_end` / `agent_end` / `agent_stale_warning` / 压缩事件 `compaction_start|end`（兼容旧 `auto_compaction_start|end`）/ `auto_retry_start`

### 工程纪律（必须遵守）

- **禁止运行 `next build`**（会污染 .next/ 导致 dev 失败）。类型检查用 `node_modules/.bin/tsc --noEmit`，lint 用 `npm run lint`
- 开发服务器：`npm run dev`（端口 30141）
- 保持最小改动；不顺手重构无关代码

---

## 2. 第一批：发热止血（渲染层，独立可发布）

> 目标：多窗口并发流式时 CPU 显著下降。预计 1-2 天。批次内任务可并行。

### 任务 1：流式 chunk rAF 批处理

**文件**：`components/ChatWindow.tsx`
**做什么**：message_update 类事件到达时不再立即 dispatch/setState，而是推入 pending buffer；用 `requestAnimationFrame` 合并同帧内所有 chunk 为一次 reducer dispatch（取每个流中消息的最新内容，丢弃中间版本）。
**边界**：`message_end` / `agent_end` 等终态事件必须立即 flush buffer 后再处理，不能丢。组件卸载时 flush。
**验收**：流式输出时 Performance 面板中每秒 React commit 次数 ≤ 60（而非 = chunk 到达次数）；消息内容无丢失、无乱序。

### 任务 2：后台窗口暂停渲染

**文件**：`components/ChatWindow.tsx` + `components/ChatWorkspace.tsx`
**做什么**：ChatWorkspace 已知道每个槽位是否聚焦（`isFocused`，见 L286 附近传参）。为 ChatWindow 增加 `isBackground` prop（非聚焦且多窗口布局时为 true）：后台时 chunk 事件只进 buffer 不 dispatch，状态机切换回前台时一次性 flush；后台时 `streamState` 相关 reducer 不触发。
**注意**：状态（buffer）不能丢——切回前台必须呈现完整最新状态；agent_end 等终态在后台也要入 buffer（不丢），只是不渲染。
**验收**：3 窗口并发流式时，2 个后台窗口的 React commit 频率 ≈ 0；切回前台内容完整。

### 任务 3：后台窗口停定时器

**文件**：`components/ChatWindow.tsx`
**做什么**：
- L388 光标闪烁：`isBackground` 时 `setInterval` 不启动（或 clear），回前台重启
- L1064 计时 tick：同上；回前台时先用 `Date.now() - startedAt` 立即校正一次再继续
- L526 subagent 轮询：后台时不启动
**验收**：后台窗口无周期性 timer 回调（Performance 录制验证）。

### 任务 4：流式中的消息降级渲染

**文件**：`components/MessageView.tsx`
**做什么**：正在流式的消息（消息 id === 当前 streamingMessage id 时）渲染降级路径——纯文本 `<pre>` 或轻量 markdown（至少跳过代码高亮等重部件）；`message_end` 后恢复完整 ReactMarkdown 渲染。
**验收**：长代码块流式输出时，每次 chunk 的 style recalc 时间显著下降；流结束后最终渲染与之前完全一致。

### 任务 5：计时器数字隔离

**文件**：`components/ChatWindow.tsx`
**做什么**：L1064 的 `setActiveTurnElapsedSeconds` 每 500ms 触发的 setState 会重渲染整个 ChatWindow。把计时数字抽成独立小组件（接收 startedAt，自己管理 interval 和显示），ChatWindow 不再持有该 state。
**验收**：计时运行时 ChatWindow 本体不重渲染（仅计时组件更新）。

---

## 3. 第二批：轮询清除 + mux 流扩展

> 目标：消灭周期性网络轮询，全部改为事件驱动。复用现有 mux SSE，**不要新建连接层**。预计 3-5 天，依赖任务顺序 6→7→8→9。

### 任务 6：mux 服务端新增 host 级运行状态帧

**文件**：`app/api/agent/events/route.ts` + `lib/rpc-manager.ts`（或其 event-store 相关模块）
**做什么**：
- 扩展 mux 流信封，新增控制帧类型（不破坏现有 `agent_event` 信封）：
  ```ts
  | { type: "host_running_snapshot"; sessions: { sessionId: string; running: boolean; updatedAt: number }[] }
  ```
- 服务端：连接建立时发送一次全量 running 快照；此后任一 session 的 running 状态翻转时向所有连接广播
- running 状态源：`globalThis.__deerhuxSessions` 中各 wrapper 的运行状态（参考 `app/api/agent/running/route.ts` 现有实现的数据来源）
**验收**：curl 连接 `/api/agent/events`，启动/结束一个 agent turn，能观察到 host_running_snapshot 帧到达。

### 任务 7：客户端消费 host 帧

**文件**：`lib/agent-event-client.ts` + `components/AppShell.tsx`
**做什么**：
- `AgentEventClient` 增加 host 级订阅接口（`subscribeHost(listener)`），收到 host_running_snapshot 分发给订阅者
- AppShell 用它替换 L285 的 `setInterval(loadRunningSessions, 2000)`；连接断开重连期间可保留一次兜底拉取
- 删除或改造轮询代码（保留 running API 路由本身作为回退）
**验收**：Network 面板中不再有 2s 周期的 `/api/agent/running` 请求；session 启动/结束时侧边栏状态点实时更新（≤1s）。

### 任务 8：subagent 轮询改事件驱动

**文件**：`components/ChatWindow.tsx`（L514-526）+ 服务端相应位置
**做什么**：subagent 运行状态（当前来自 `/api/agent-runs?parentSessionId=` 1.2s 轮询）改为从 mux 流推送——服务端在 subagent run 状态变化时发帧（可复用任务 6 的 host 帧机制或扩展 agent_event）；客户端订阅替换轮询。保留一次初始 fetch 拉历史。
**验收**：subagent 运行期间无周期性 `/api/agent-runs` 请求；SubagentRunCard 状态更新正常。

### 任务 9：全局 running 联动清理

**文件**：`components/AppShell.tsx`（L298 附近的 10s 刷新）
**做什么**：任务 7 完成后，评估 L298 的 `setInterval(10000)` 刷新 session 列表逻辑——running 状态翻转已事件化后，这个 10s 轮询是否还有必要（可能为 modified timestamp 更新而设）。若必要，改为仅在 host 帧触发 running 翻转时附带刷新；若不必要，删除。
**验收**：多窗口并发时 Network 面板周期性请求为零（或仅剩明确论证过的）。

### 任务 10（清理）：旧 per-session SSE 确认下线

**文件**：`app/api/agent/[id]/events/route.ts`
**做什么**：全局搜索确认无任何前端代码引用 `agent/[id]/events` 路径（当前 ChatWindow 走 mux）。若确认无引用：删除该 route 或标记 deprecated；若有引用（如旧 isStreaming 重连路径），先迁移到 mux 再删。
**验收**：grep 无残留引用；删除后多窗口流式正常。

---

## 4. 第三批：瞬态状态快照帧（状态分叉修复）

> 目标：isStreaming / isCompacting / thinkingLevel 等瞬态状态改由服务端快照帧驱动，消灭「GET 拉取 + SSE 事件」双通道状态分叉。预计 2-3 天，依赖第二批完成。

### 背景：现有状态分叉问题

ChatWindow 挂载时 `GET /api/agent/[id]` 拉取 `isStreaming` / `isCompacting` / `thinkingLevel`（见 `hooks/useAgentSession.ts` L2085 附近 stillRunning 判断），之后靠 SSE 事件维护。两条通道对同一状态的事实可能不一致（页面刷新、断线、压缩事件新旧版本兼容等场景）。

### 任务 11：定义并推送瞬态快照帧

**文件**：服务端 mux 相关 + `lib/agent-event-client.ts`
**做什么**：
- 新帧类型：
  ```ts
  | { type: "session_transient_snapshot"; sessionId: string; isStreaming: boolean; isCompacting: boolean; thinkingLevel?: string; updatedAt: number }
  ```
- 服务端在以下时机推送对应 session 的快照：mux 连接建立（所有活跃 session 各一帧，作基线）、每次状态翻转（agent_start/end、compaction_start/end）
- 客户端：收到快照直接 set（last-wins，无需合并逻辑）
**验收**：刷新页面后 isCompacting 状态无需 GET 即从 mux 基线恢复；压缩开始/结束 UI 实时翻转。

### 任务 12：挂载重连逻辑迁移

**文件**：`hooks/useAgentSession.ts`
**做什么**：现有「挂载时 GET 判断 isStreaming=true 则等待/重连事件流」逻辑（L2085 附近），改为：订阅 mux 后等待 session_transient_snapshot 基线帧即可获得运行状态；GET 拉取保留用于完整历史（消息列表），不再承担瞬态状态职责。
**验收**：流式中刷新页面，恢复后流式续上且 isStreaming 正确；GET /api/agent/[id] 响应中的瞬态字段不再被前端依赖。

### 任务 13：基线重置防幻影

**文件**：`lib/agent-event-client.ts`
**做什么**：mux 重连成功（新 epoch 或 snapshot_required 后完成快照恢复）时，清空所有本地瞬态状态镜像（isCompacting 等），等待新基线帧重建——防止服务端重启后旧状态残留成幻影。参考 dsh 的 session/subscribed 再基线语义。
**验收**：重启 dev server 后前端无残留的 isCompacting=true 卡死状态。

---

## 5. 执行顺序与验证

```
第一批（1-2 天）：任务 1-5，可并行，一次 PR
第二批（3-5 天）：任务 6→7→8→9→10，主线串行
第三批（2-3 天）：任务 11→12→13
```

**每个任务完成后的统一验证**：
1. `node_modules/.bin/tsc --noEmit` 通过
2. `npm run lint` 通过
3. `npm run dev` 手动验证：新建 session 发消息流式输出正常、多窗口并发正常、fork/分支导航正常、压缩按钮正常
4. 涉及渲染性能的任务（1/2/3/4/5）：Chrome DevTools Performance 录制对比改造前后

**回归红线**（任何任务不得破坏）：
- 消息内容不丢不乱序（含分支 navigate_tree、fork 后新 session）
- toolCall/toolResult 展示正常（注意 `lib/normalize.ts` 的字段转换链路）
- 空闲 10 分钟 wrapper 淘汰与 agent_stale_warning 正常
- Tauri 桌面端行为与浏览器一致（改动不得依赖浏览器独有 API，除 EventSource/rAF 本身已在使用）

## 6. 设计参考（可选阅读）

本计划的 mux 帧语义（基线快照、last-wins、再基线重置）参考自 DeepSeek Harness（github.com/deepseek-ai/deepseek-harness）的四象限 RPC + mux 流设计，关键参考文件（若本地存在 `/Users/deerman/Documents/LuYuAllProject/TempProject/deepseek-harness`）：
- `packages/host/apiproxy/src/api-proxy.ts` L414 FrameQueue 多消费者广播
- `packages/client/runtime/src/client/sessions/manager.ts` L700-830 subscribed 再基线
- `.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md` 连接配额动机
