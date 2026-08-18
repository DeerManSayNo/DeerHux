# 多 Chat 并行流式输出修复开发文档

## 1. 任务目标

修复 DeerHux 多窗格并行运行 Agent 时，只有焦点 Chat 持续流式刷新、其他可见 Chat 看起来暂停的问题。

修复后必须满足：

- 继续使用单条全局 SSE Mux。
- 不恢复每个 Chat 一条 SSE。
- 2、3、4、5、6 个 Chat 并行时，所有可见 Chat 都持续流式刷新。
- 同一浏览器标签页始终只建立一条 `GET /api/agent/events` 连接。
- 不同 Session 的 `message_update` 不能互相覆盖。
- 最终消息、工具状态、结束状态和 SSE 重连游标保持正确。
- Assistant 流式输出期间实时渲染 Markdown，不再展示整段 Markdown 源码。
- 流式阶段使用轻量代码块，回复完成后再启用完整 Prism 语法高亮。

---

## 2. 当前问题

### 2.1 非焦点窗格被错误视为后台窗格

当前文件：

`components/ChatWorkspace.tsx`

当前逻辑将未聚焦的可见窗格传为后台：

```tsx
<ChatWindow
  isBackground={!isFocused}
/>
```

`hooks/useAgentSession.ts` 收到后台窗格的 `message_update` 后只保存最新快照，不触发 React 渲染：

```ts
pendingMessageUpdateRef.current = { event, sessionId: sid };
if (isBackgroundRef.current || messageUpdateFrameRef.current !== null) return;
```

结果是：

- Agent 后台继续运行。
- SSE 事件可能仍在到达。
- 焦点窗格持续刷新。
- 非焦点但可见的窗格只缓存最新消息。
- 重新聚焦或收到 `message_end` 后才一次性追平。

### 2.2 SSE Mux 合并器会跨 Session 覆盖事件

当前文件：

`lib/agent-runtime/event-coalescer.ts`

当前合并器只有一个全局槽位：

```ts
private pending: T | null = null;
```

所有 Session 共用该槽位。两个 Session 在同一合并周期内交错产生 `message_update` 时，后到事件会覆盖先到事件。

示例：

```text
A1 -> pending=A1
B1 -> pending=B1，覆盖 A1
A2 -> pending=A2，覆盖 B1
B2 -> pending=B2，覆盖 A2
```

最终只发送 B2，Session A 在该周期内没有流式快照。

### 2.3 流式阶段故意绕过 Markdown 渲染

当前文件：

`components/MessageView.tsx`

当前 `TextBlock` 在 `isStreaming=true` 时直接使用 `<pre>`：

```tsx
if (isStreaming) {
  return (
    <pre className="markdown-body">
      {block.text}
    </pre>
  );
}
```

只有 `isStreaming=false` 后才使用：

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]}>
  {block.text}
</ReactMarkdown>
```

因此流式阶段会原样显示标题符号、列表符号、反引号、代码围栏等 Markdown 源码，收到 `message_end` 后才突然切换为 Markdown 预览。这不是 SSE 或消息格式问题，而是当前组件明确写死的性能降级分支。

---

## 3. 目标架构

保持一条 SSE：

```text
多个 Agent Session
        |
        v
全局 EventStore
        |
        v
按 session/run/turn 分桶的 MessageUpdateCoalescer
        |
        v
GET /api/agent/events
单条 SSE
        |
        v
AgentEventClient 单例
        |
        +-- Session A Listener
        +-- Session B Listener
        +-- Session C Listener
        +-- Session D Listener
        |
        v
各 Chat 独立渲染调度
        |
        v
流式 ReactMarkdown（轻量代码块）
        |
        v
完成后 ReactMarkdown + Prism 完整高亮
```

连接数量必须保持：

```text
EventSource x 1
```

每个 Chat 调用 `subscribeAgentEvents(sessionId, listener)` 只是注册内存 Listener，不得创建新的 EventSource。

---

## 4. 修改文件

必须修改：

```text
lib/agent-runtime/event-coalescer.ts
app/api/agent/events/route.ts
components/ChatWorkspace.tsx
components/ChatWindow.tsx
hooks/useAgentSession.ts
components/MessageView.tsx
scripts/test-stream-event-performance.ts
```

不要修改为会话级 SSE，也不要新增 `/api/agent/[id]/events` 连接。

---

## 5. 服务端实现

### 5.1 合并器按流分桶

修改：

`lib/agent-runtime/event-coalescer.ts`

将单个 `pending` 改为 Map：

```ts
private readonly pendingByStream = new Map<string, T>();
```

合并器输入类型至少包含：

```ts
type CoalescableEvent = {
  sessionId: string;
  runId: string;
  turnId?: string;
  globalSeq: number;
  event: {
    type: string;
  };
};
```

流键由以下字段组成：

```text
sessionId
runId
turnId
```

推荐实现：

```ts
function streamKey(value: CoalescableEvent): string {
  return JSON.stringify([
    value.sessionId,
    value.runId,
    value.turnId ?? null,
  ]);
}
```

### 5.2 `message_update` 只覆盖同一条流

```ts
push(value: T): void {
  if (value.event.type === "message_update") {
    this.pendingByStream.set(streamKey(value), value);
    this.scheduleFlush();
    return;
  }

  this.flush();
  this.emit(value);
}
```

同一条流只保留最新累计快照，不同 Session 必须同时保留。

### 5.3 只使用一个定时器

合并器继续只使用一个定时器，默认周期保持 32ms：

```ts
private timer: ReturnType<typeof setTimeout> | undefined;
```

不能为每个 Session 创建独立 SSE，也不需要为每个 Session 创建独立定时器。

### 5.4 Flush 按全局序列排序

```ts
flush(): void {
  if (this.timer) {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  const pending = [...this.pendingByStream.values()]
    .sort((a, b) => a.globalSeq - b.globalSeq);

  this.pendingByStream.clear();

  for (const event of pending) {
    this.emit(event);
  }
}
```

必须按 `globalSeq` 递增发送，因为浏览器客户端使用全局游标去重和恢复。

### 5.5 非流式事件是顺序屏障

以下事件以及其他所有非 `message_update` 事件到达时，必须先 Flush：

- `message_start`
- `message_end`
- `agent_start`
- `agent_end`
- `tool_execution_start`
- `tool_execution_end`
- `compaction_start`
- `compaction_end`

统一逻辑：

```ts
this.flush();
this.emit(value);
```

保证最终正文先于 `message_end`，工具前的正文先于工具事件。

### 5.6 Cancel 清理全部状态

```ts
cancel(): void {
  if (this.timer) clearTimeout(this.timer);
  this.timer = undefined;
  this.pendingByStream.clear();
}
```

SSE 断开后不得继续发送延迟事件。

### 5.7 全局 SSE 路由保持单连接设计

文件：

`app/api/agent/events/route.ts`

继续保持：

```ts
const coalescer = new MessageUpdateCoalescer(sendStored);
unsubscribe = store.subscribeAll((event) => coalescer.push(event));
```

只需适配新合并器类型，不得按 Session 创建多个 Coalescer 或多个 SSE Response。

---

## 6. 前端实现

### 6.1 区分焦点、可见和隐藏

新增类型：

```ts
export type StreamRenderPriority = "focused" | "visible" | "hidden";
```

含义：

| 优先级 | 场景 | 正文更新 |
|---|---|---:|
| `focused` | 当前操作窗格 | 每 32ms 最多一次 |
| `visible` | 多窗格中可见但未聚焦 | 每 64ms 最多一次 |
| `hidden` | 真正不可见但组件仍挂载 | 不渲染，只缓存最新快照 |

当前 `ChatWorkspace` 中实际显示的所有窗格都属于 `focused` 或 `visible`，不能因为未聚焦就标记为 `hidden`。

### 6.2 修改 ChatWorkspace

文件：

`components/ChatWorkspace.tsx`

将：

```tsx
isBackground={!isFocused}
```

替换为：

```tsx
isFocused={isFocused}
streamRenderPriority={isFocused ? "focused" : "visible"}
```

五个 Chat 可以使用六窗格布局并留一个空位。底层实现不得写死 Session 数量。

### 6.3 修改 ChatWindow Props

文件：

`components/ChatWindow.tsx`

Props 增加：

```ts
isFocused?: boolean;
streamRenderPriority?: StreamRenderPriority;
```

默认值建议：

```ts
isFocused = true
streamRenderPriority = "focused"
```

调用 `useAgentSession` 时传入：

```ts
useAgentSession({
  ...,
  streamRenderPriority,
});
```

`isFocused` 只用于辅助动画和高频统计，不能用于停止正文流式更新。

### 6.4 修改 useAgentSession 调度

文件：

`hooks/useAgentSession.ts`

Options 将 `isBackground` 替换或逐步迁移为：

```ts
streamRenderPriority?: StreamRenderPriority;
```

定义刷新间隔：

```ts
const STREAM_RENDER_DELAY = {
  focused: 32,
  visible: 64,
  hidden: null,
} as const;
```

保留：

```ts
pendingMessageUpdateRef
```

它只属于当前 Hook 对应的单个 Session，不需要改成 Map。

将 RAF 引用改为通用定时器：

```ts
const messageUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

调度逻辑：

```ts
const enqueueMessageUpdate = useCallback((event: AgentEvent, sid: string) => {
  pendingMessageUpdateRef.current = { event, sessionId: sid };

  const delay = STREAM_RENDER_DELAY[streamRenderPriorityRef.current];
  if (delay === null || messageUpdateTimerRef.current !== null) return;

  messageUpdateTimerRef.current = setTimeout(() => {
    messageUpdateTimerRef.current = null;
    flushPendingMessageUpdate(sid);
  }, delay);
}, [flushPendingMessageUpdate]);
```

同一周期内的新快照只覆盖 Ref，不重复创建定时器。

### 6.5 优先级变化时立即追平

当优先级发生以下变化时：

```text
visible -> focused
hidden -> visible
hidden -> focused
```

立即执行：

```ts
flushPendingMessageUpdate(sessionIdRef.current ?? undefined);
```

`focused -> visible` 不需要立即 Flush，只调整后续频率。

### 6.6 终态前强制 Flush

继续保持：

```ts
if (event.type === "message_update") {
  enqueueMessageUpdate(event, sid);
} else {
  flushPendingMessageUpdate(sid);
  handleAgentEventRef.current?.(event);
}
```

无论优先级是什么，非 `message_update` 事件都必须先提交最后累计正文。

### 6.7 清理定时器

Session 切换、组件卸载、发送失败或订阅释放时必须：

```ts
clearTimeout(messageUpdateTimerRef.current);
messageUpdateTimerRef.current = null;
pendingMessageUpdateRef.current = null;
```

不得遗留旧 Session 的延迟更新。

---

## 7. 流式 Markdown 渲染

### 7.1 删除流式源码展示分支

文件：

`components/MessageView.tsx`

当前 `TextBlock` 在流式阶段返回 `<pre>{block.text}</pre>`。删除这套流式源码展示分支，流式和完成状态都必须经过 `ReactMarkdown`。

不要简单地在流式阶段启用当前完整代码高亮逻辑，因为累计消息每次更新都会重新运行 Prism，高并发时成本较高。

### 7.2 统一使用 ReactMarkdown

`TextBlock` 应统一渲染：

```tsx
function TextBlock({ block, isStreaming }: {
  block: TextContent;
  isStreaming?: boolean;
}) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={/* 根据 isStreaming 选择代码块实现 */}
      >
        {block.text}
      </ReactMarkdown>
    </div>
  );
}
```

流式阶段必须实时支持：

- 标题
- 段落
- 加粗和斜体
- 引用
- 有序和无序列表
- 链接
- GFM 表格
- 行内代码
- 代码围栏

Markdown 在流式期间可能暂时不完整，例如未闭合的加粗标记或代码围栏。直接让 `react-markdown` 解析当前累计文本，不要实现自定义 Markdown 补全器。

### 7.3 流式代码块使用轻量渲染

流式阶段的块级代码不能调用 `SyntaxHighlighter`。使用普通 `<pre><code>`：

```tsx
code({ className, children, ...props }) {
  const lang = className?.replace("language-", "") ?? "";
  const raw = String(children);
  const isBlock = className?.includes("language-") || raw.includes("\n");

  if (isBlock && isStreaming) {
    return (
      <pre className="streaming-code-block">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  }

  if (isBlock) {
    return (
      <CodeBlock
        code={raw.replace(/\n$/, "")}
        lang={lang}
      />
    );
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}
```

实际实现需要保留现有行内代码样式。流式 `<pre><code>` 也要使用项目现有 CSS 变量，并至少具备：

```text
横向滚动
pre-wrap 或适当的代码换行策略
等宽字体
背景色
边框
圆角
合理内边距
```

### 7.4 完成后启用完整语法高亮

当 `message_end` 到达、`isStreaming=false` 后，块级代码继续使用现有：

```tsx
<CodeBlock />
```

并由内部：

```tsx
<SyntaxHighlighter />
```

执行 Prism 语法高亮。

最终行为：

| 状态 | Markdown | 块级代码 |
|---|---|---|
| 流式输出 | `ReactMarkdown + remarkGfm` 实时渲染 | 轻量 `<pre><code>`，不运行 Prism |
| 回复完成 | `ReactMarkdown + remarkGfm` 完整渲染 | `CodeBlock + SyntaxHighlighter` 完整高亮 |

### 7.5 避免重复创建 Markdown 配置

可以将 Markdown `components` 配置抽成小函数或稳定对象，但不要引入新的 Markdown 依赖或复杂缓存层。

可接受形式：

```ts
const markdownComponents = createMarkdownComponents(isStreaming);
```

或在 `TextBlock` 内保留简单配置。优先保持改动小且清晰。

### 7.6 与多窗格刷新频率配合

Markdown 解析频率由前文的消息提交策略限制：

```text
focused：每 32ms 最多重新解析一次
visible：每 64ms 最多重新解析一次
hidden：不解析，只缓存最新累计快照
```

不得绕过该调度直接按每个上游 Token 更新 ReactMarkdown。

---

## 8. 辅助动画策略

正文和辅助动画必须分开处理。

文件：

`components/MessageView.tsx`

文件：

`components/ChatWindow.tsx`

以下内容可以只在焦点窗口更新：

- TPS 计算
- 思考耗时动态刷新
- Typewriter
- 光标闪烁
- Watchdog 展示计时
- 当前窗口统计

使用：

```ts
if (!isFocused) return;
```

或：

```tsx
<Typewriter paused={!isFocused} />
```

但 `message_update` 正文不能因为 `!isFocused` 而停止渲染。

---

## 9. 自动滚动

第一版不增加新的滚动调度器。

当前自动滚动依赖 `streamState.streamingMessage`，正文限频后会自然得到：

```text
focused：最多约 31 次/秒
visible：最多约 15 次/秒
```

继续保留：

- 每个 Chat 独立滚动容器。
- 用户向上滚动后停止自动滚动。
- 用户恢复自动滚动后滚到底部。

如果人工测试发现四窗格滚动仍造成明显压力，再单独将非焦点窗口滚动限制为每 100ms 一次。本任务第一版不做该优化。

---

## 10. 不允许的实现

不得执行以下改动：

- 不得恢复每个 Chat 一条 SSE。
- 不得为每个 Session 创建 EventSource。
- 不得新增 WebSocket。
- 不得删除全局游标和 SSE 重连恢复机制。
- 不得把 `subscribeAgentEvents()` 改成网络订阅。
- 不得按 3、4、5、6 写死 Session 槽位。
- 不得让非焦点但可见的 Chat 停止正文更新。
- 不得在流式阶段继续使用整段 `<pre>{block.text}</pre>` 展示 Markdown 源码。
- 不得在流式阶段对累计代码块反复运行 Prism `SyntaxHighlighter`。
- 不得引入自定义 Markdown 补全器或新的 Markdown 依赖。
- 不得运行 `next build`。

---

## 11. 测试要求

修改：

`scripts/test-stream-event-performance.ts`

### 11.1 同一流合并

输入：

```text
A1 seq=1
A2 seq=2
A3 seq=3
```

预期：

```text
只发送 A3
```

### 11.2 双 Session 交错

输入：

```text
A1 seq=1
B1 seq=2
A2 seq=3
B2 seq=4
```

预期：

```text
A2 seq=3
B2 seq=4
```

必须同时保留两个 Session。

### 11.3 四 Session 交错

输入至少包含：

```text
A1 B1 C1 D1
A2 C2 B2 D2
D3 A3 C3 B3
```

断言：

- A、B、C、D 各发送自己的最新快照。
- 不同 Session 不互相覆盖。
- 发出事件的 `globalSeq` 严格递增。

### 11.4 五 Session

增加 A、B、C、D、E 五条流的交错测试，证明实现不依赖布局数量。

### 11.5 顺序屏障

输入：

```text
A update seq=1
B update seq=2
A message_end seq=3
```

预期顺序：

```text
A update
B update
A message_end
```

### 11.6 Cancel

多个 Session 已有 pending 后调用 `cancel()`，等待超过合并周期，断言没有事件发出。

---

## 12. 验证命令

禁止运行 `next build`。

先执行聚焦测试：

```bash
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-stream-event-performance.ts
```

再执行 EventStore 测试：

```bash
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-event-store.ts
```

执行类型检查：

```bash
node_modules/.bin/tsc --noEmit
```

执行代码检查：

```bash
npm run lint
```

---

## 13. 人工验收

启动开发服务：

```bash
npm run dev
```

### 13.1 SSE 数量

浏览器 Network 中只能存在一条：

```text
GET /api/agent/events
```

不得为每个 Chat 出现独立 SSE。

### 13.2 双窗格

同时让两个 Chat 输出长文本：

- 两个窗口都持续增长。
- 不点击非焦点窗口，它也不能长时间停止刷新。
- 切换焦点只改变刷新细腻程度，不能转移暂停状态。

### 13.3 三窗格

三个 Chat 同时运行：

- 三个窗口持续流式刷新。
- 一个焦点窗口约 32ms 提交。
- 两个非焦点可见窗口约 64ms 提交。

### 13.4 四窗格

四个 Chat 同时运行：

- 四个窗口持续流式刷新。
- 不串 Session 内容。
- 任一窗口进入 Tool 时状态及时变化。
- 任一窗口结束时最终内容完整。

### 13.5 五窗格

使用六窗格布局，放入五个 Chat 并留一个空位：

- 五个 Chat 都持续流式刷新。
- 空槽位不创建 Session Listener。
- 仍然只有一条全局 SSE。

### 13.6 六窗格

六个 Chat 同时运行：

- 六个窗口都能看到持续更新。
- 非焦点窗口可以较低频率更新，但不能一直静止到结束。

### 13.7 流式 Markdown

使用包含以下内容的长回复进行测试：

```text
标题
加粗
列表
引用
链接
GFM 表格
行内代码
带语言标记的代码围栏
```

必须确认：

- 回复仍在生成时，标题、列表、加粗、表格等已经按 Markdown 预览显示。
- 流式阶段不再整段展示 Markdown 源码。
- 流式代码块使用轻量样式，不运行 Prism 完整语法高亮。
- 回复结束后代码块切换为现有完整语法高亮。
- 从流式状态切换到完成状态时不重复消息、不丢内容。
- 不完整 Markdown 到达时页面不报错，后续累计快照能够自然收敛。
- 四至六个 Chat 并行时，实时 Markdown 不导致明显卡死或窗口停止更新。

### 13.8 一致性

必须确认：

- `message_end` 不先于最后正文显示。
- `agent_end` 后不残留正在生成状态。
- 焦点切换不重复消息。
- 不同 Chat 不串消息。
- SSE 重连后能够通过全局游标恢复。
- 最终 UI 内容与 JSONL 会话内容一致。

---

## 14. 完成标准

只有同时满足以下条件才算完成：

1. 单条全局 SSE Mux 保留。
2. `MessageUpdateCoalescer` 按 `sessionId + runId + turnId` 隔离。
3. Flush 后事件按 `globalSeq` 递增。
4. 所有可见 Chat 持续流式渲染。
5. 焦点窗口 32ms、可见非焦点窗口 64ms、隐藏窗口只缓存。
6. Assistant 流式正文通过 `ReactMarkdown + remarkGfm` 实时渲染。
7. 流式代码块使用轻量 `<pre><code>`，完成后使用现有 Prism 完整高亮。
8. 辅助动画仍可只在焦点窗口运行。
9. 双 Session、四 Session、五 Session、顺序屏障和 Cancel 测试通过。
10. TypeScript 类型检查通过。
11. ESLint 通过。
12. 人工测试确认一个浏览器标签页只有一条 `/api/agent/events` SSE。
13. 人工测试确认流式阶段不再整段显示 Markdown 源码。
