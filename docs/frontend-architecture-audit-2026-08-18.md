# DeerHux 前端架构核查报告

- **审计日期**：2026-08-18
- **审计范围**：前端组件、会话状态、SSE 多路复用、跨组件通信、配置读写、多窗口工作区、独立文件预览窗口、初始客户端依赖
- **审计方式**：主审查与隔离 subagent 只读交叉取证
- **执行限制**：未修改业务代码，未执行 `next build`

## 0. 修复状态（2026-08-19 更新）

本报告全部 9 项问题已于 2026-08-19 修复并通过对抗性审查与回归验证。

**修复流程**：每项问题由独立隔离 subagent 编码修复 → 独立对抗性审查 worker 审查 → 主工作区合并 → 审查发现的新缺陷二次修复 → 全量回归。

**回归验证结果**：

- `tsc --noEmit`：通过（0 错误）
- `eslint`（全部改动文件）：0 errors（仅保留 7 条既有 warnings，均非本次引入）
- 9 个新增聚焦测试：全部通过
- 既有核心测试（`test:core` 全部 30 项，分批执行）：全部通过
- `git diff --check`：通过

**对抗性审查在合并后追加发现并修复的问题**：

| 追加编号 | 来源 | 问题 | 状态 |
|---|---|---|---|
| R-01 | 跨批次审查 | 新会话项目选择器绕过 CWD 收敛，旧项目会话残留 | 已修复 |
| R-02 | 跨批次审查 | 占位会话跨项目携带图片/文件引用/技能草稿 | 已修复 |
| R-03 | 跨批次审查 | `useTheme` HMR 后 listener store 与通道脱节 | 已修复 |
| R-04 | A-02 复审 | `writeControlPlaneJson` 无超时，写请求可无限挂起 | 已修复 |
| R-05 | A-02 复审 | `McpConfig` 首次加载失败仍可保存空配置覆盖服务端 | 已修复 |
| R-06 | A-03 复审 | 删除当前角色后，会话仍发送已删除 roleId | 已修复 |
| R-07 | A-03 复审 | 角色快捷保存未校验响应、未广播、失败丢确认项 | 已修复 |
| R-08 | A-03 复审 | 模型保存成功未派发 `models-updated`，订阅死链 | 已修复 |
| R-09 | A-03 复审 | 发送失败分支遗留 transient 订阅 | 已修复 |
| R-10 | A-03 复审 | Tauri 原生主题快速切换乱序竞态 | 已修复 |

---

## 1. 执行摘要

当前前端并不存在需要推倒重来的基础架构错误。

已有的关键设计总体正确：

- 会话 SSE 已实现浏览器标签页级的多路复用；
- 流式消息、持久化快照与乐观消息之间存在并发保护；
- 会话列表存在缓存、索引重建和退避恢复机制；
- 多窗口运行态由 `AppShell` 维持，能降低窗格重挂载造成的流式状态丢失。

但审计确认了四项具备明确代码证据与可复现用户路径的真实问题：

1. 全局 Agent 事件总线丢失会话范围，导致多窗口副作用串扰。
2. 全局记忆加载失败会被错误表现为空数据，用户保存时可覆盖全部全局记忆。
3. 切换项目目录时，仅清理当前选中会话，旧项目会话仍留在工作区。
4. 工作区从多窗口收缩到少窗口时，非首槽位未发送草稿会丢失。

此外还确认了三类需要渐进治理的架构债务，以及一项低优先级窗口主题同步问题。

---

## 2. 结论总表

| 编号 | 问题 | 结论 | 优先级 | 建议 | 修复状态 |
|---|---|---|---:|---|---|
| F-01 | `agentEventBus` 跨会话串扰 | 真实缺陷 | P0 | 立即修复 | ✅ 已修复 |
| F-02 | `MemoryConfig` 加载失败覆盖全局记忆 | 真实数据完整性缺陷 | P0 | 立即修复 | ✅ 已修复 |
| F-03 | CWD 切换后旧项目会话仍显示 | 真实状态一致性缺陷 | P1 | 优先修复 | ✅ 已修复 |
| F-04 | 多窗口缩减后草稿丢失 | 真实 UX / 本地数据丢失风险 | P1 | 优先修复 | ✅ 已修复 |
| A-01 | `useAgentSession` 职责耦合 | 部分真实，架构债务 | P2 | 渐进拆分 | ✅ 首步已拆（自动滚动） |
| A-02 | 组件内散落 API 调用 | 部分真实 | P2 | 按请求语义治理 | ✅ 边界已建（McpConfig 迁移） |
| A-03 | 通信机制并存 | 部分真实 | P2 | 仅修具体边界问题 | ✅ 应用内通知已类型化 |
| O-01 | 大型配置面板静态导入 | 真实性能优化点 | P3 | 有指标后优化 | ✅ 8 个面板已动态导入 |
| F-05 | 独立文件预览窗口主题不同步 | 真实缺陷 | P3 | 顺手修复 | ✅ 已修复 |

### 优先级定义

- **P0**：存在数据丢失风险，或在已支持的主路径中稳定产生错误副作用。
- **P1**：存在明确可达的状态错误或用户数据丢失风险，但不影响 Agent 后端执行与会话持久化。
- **P2**：当前不必然导致线上错误，但已扩大后续变更、测试或排障成本。
- **P3**：体验或性能优化项，需结合实际使用频率与性能指标排期。

---

## 3. F-01：全局 Agent 事件总线存在跨会话串扰

### 结论

**真实。** 在多个 `ChatWindow` 同时挂载时，可稳定导致修改文件提示被错误清空、完成音效重复播放。

### 证据

底层多路 SSE 已具备会话维度。

**文件：`lib/agent-event-client.ts`**

```ts
export type MultiplexAgentEvent = {
  sessionId: string;
  event: { type: string; [key: string]: unknown };
};

private readonly listeners = new Map<string, Set<SessionListener>>();
```

但向全局事件总线转发时丢失了该维度。

**文件：`hooks/useAgentSession.ts:1211-1243`**

```ts
eventSubscriptionRef.current = subscribeAgentEvents(
  sid,
  (event) => {
    agentEventBus.emit(event);
    // ...
  },
);
```

**文件：`lib/agent-event-bus.ts:8-28`**

```ts
export type AgentEvent = AgentRuntimeEventBase;
type Listener = (event: AgentEvent) => void;
```

总线消息没有 `sessionId`。

每个已挂载窗口都无条件处理总线事件。

**文件：`components/ChatWindow.tsx:946-963`**

```ts
agentEventBus.subscribe((event) => {
  if (event.type === "agent_start") {
    const id = sessionIdRef2.current;
    if (id) setChangedFilesBySession((prev) => ({ ...prev, [id]: [] }));
  }
  if (event.type === "agent_end" && soundEnabledRef.current) {
    playDoneSoundRef.current();
  }
});
```

### 触发路径

1. 打开聊天窗口 A 与 B。
2. 在 A 完成一次修改，使 A 显示修改文件提示。
3. 在 B 发送新请求。
4. B 的 `agent_start` 被广播至所有窗口。
5. A 错误清空自己的修改文件提示。
6. B 的 `agent_end` 会让所有已挂载窗口各播放一次完成音效。

六窗口布局下，一次完成事件最多触发六次音效。

### 影响

- 不影响 Agent 后端执行、会话持久化、SSE 游标与消息内容。
- 在明确支持的多窗口路径中稳定造成 UI 错误。
- 修改文件提示最多影响所有已挂载窗口。

### 最小且推荐的修复

保留总线，改为发送带会话范围的事件信封。

```ts
export type SessionAgentEvent = {
  sessionId: string;
  event: AgentRuntimeEventBase;
};
```

在 `useAgentSession` 发射：

```ts
agentEventBus.emit({ sessionId: sid, event });
```

在 `ChatWindow` 订阅：

```ts
agentEventBus.subscribe(({ sessionId, event }) => {
  if (sessionId !== sessionIdRef.current) return;
  // 处理 event
});
```

如产品要求完成音效在整个应用中只响一次，应将音效监听上移到单一应用级消费者；但这属于产品行为选择，不是修复会话串扰的必要前提。

### 不建议的方案

- 不建议删除总线并把副作用直接写回 `useAgentSession`：会进一步增加 Hook 的职责。
- 不建议仅按焦点窗格播放音效：后台会话是否播放属于产品决策，不能代替会话范围修复。
- 不建议在总线内部维护多个实例：当前缺陷只需补齐事件上下文。

### 验收与测试

- 双窗口下，B 的 `agent_start` 不得清空 A 的修改文件提示。
- 双窗口和六窗口下，单次 `agent_end` 只触发所属会话的窗口副作用一次。
- 卸载窗口后，旧订阅不再接收任何副作用事件。

---

## 4. F-02：全局记忆加载失败后可能被空数组覆盖

### 结论

**真实。** 这是数据完整性缺陷。

### 证据

**文件：`components/MemoryConfig.tsx:22-35`**

```ts
const [globalMemory, setGlobalMemory] = useState<MemoryItem[]>([]);
const [draft, setDraft] = useState<MemoryItem[]>([]);

const load = useCallback(async () => {
  setLoading(true);
  try {
    const [memoryRes, rolesRes] = await Promise.all([
      fetch("/api/memory", { cache: "no-store" }),
      fetch(rolesUrl(cwd), { cache: "no-store" }),
    ]);
    if (memoryRes.ok) {
      setGlobalMemory(((await memoryRes.json()) as { global?: MemoryItem[] }).global ?? []);
    }
  } finally {
    setLoading(false);
  }
}, [cwd]);
```

请求失败时：

- `globalMemory` 保持初始值 `[]`；
- 无 `loadError`；
- UI 仍可进入保存流程。

**文件：`components/MemoryConfig.tsx:58-72`**

```ts
const cleaned = draft.filter((m) => m.text.trim());

const res = await fetch("/api/memory", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ global: cleaned }),
});
```

### 触发路径

1. 用户已有多条全局记忆。
2. 打开记忆配置面板。
3. `GET /api/memory` 返回 500、网络断开或 JSON 解析失败。
4. UI 把失败表现为无记忆数据。
5. 用户点击保存。
6. 前端发送 `PUT /api/memory`，把服务端的 `global` 覆盖为空数组。

### 影响

- 一次操作可清除全部全局记忆。
- 全局记忆影响后续所有角色和会话的系统提示词。
- 用户难以识别根因是加载失败而非数据为空。

### 最小且推荐的修复

在 `MemoryConfig` 显式区分加载状态：

```ts
type LoadState = "loading" | "ready" | "error";
```

要求：

1. 读取失败时显示可见错误。
2. 仅在 `loadState === "ready"` 时允许编辑与保存。
3. 重新加载失败时保留上一次成功数据，而不是回退到初始空数组。
4. 写入失败时保留草稿并展示错误。
5. 仅保存成功后广播更新事件。

```ts
const canSave = loadState === "ready" && !saving && selected !== undefined;
```

### 不建议的方案

- 服务端禁止空数组：用户主动清空记忆是合法行为。
- 仅加 `try/catch`：若仍可保存空草稿，问题没有解决。
- 为此引入 React Query、SWR、Axios：根因是读取失败状态建模错误，而不是缺少请求库。

### 验收与测试

- `GET /api/memory` 返回 500 时，不允许保存，不发送 PUT。
- 网络 reject 时，行为同上。
- 成功读取空数组时，仍允许用户主动保存空数组。
- 已成功读取数据后刷新失败，必须保留最后成功数据或进入不可编辑错误状态。
- PUT 失败后保留用户草稿，且不广播成功更新事件。

---

## 5. F-03：切换项目目录后，旧项目会话仍留在工作区

### 结论

**真实。** 当前代码表达的是单项目工作区语义，但实现只清理了选中状态，没有清理实际工作区状态。

### 证据

**文件：`components/AppShell.tsx:350-365`**

```ts
const handleCwdChange = useCallback((cwd: string | null) => {
  setActiveCwd(cwd);
  // Close any session that belongs to a different cwd
  setSelectedSession((prev) => {
    if (prev && prev.cwd !== cwd) return null;
    return prev;
  });
  setNewSessionCwd((prev) => {
    if (prev && prev !== cwd) return null;
    return prev;
  });
  replaceUrl("/");
}, [replaceUrl]);
```

该逻辑没有清理：

- `sessionTabs`
- `chatSlotIds`
- `activeSessionTabId`
- placeholder、pending session 等关联状态

但工作区实际依据 `sessionTabs` 与 `chatSlotIds` 渲染。

**文件：`components/AppShell.tsx:1862-1868`**

```tsx
<ChatWorkspace
  layoutMode={chatLayoutMode}
  slotIds={chatSlotIds}
  sessions={sessionTabs}
/>
```

槽位同步 Effect 还会将 `sessionTabs` 中的会话补回槽位。

**文件：`components/AppShell.tsx:415-430`**

```ts
for (const tab of sessionTabs) {
  if (!assignedIds.includes(tab.id)) assignedIds.push(tab.id);
}
```

### 触发路径

1. 打开项目 A 的会话。
2. 在侧边栏选择项目 B。
3. `activeCwd` 变为 B，`selectedSession` 被清空，URL 变为 `/`。
4. 项目 A 会话仍留在 `sessionTabs` 与 `chatSlotIds`。
5. `ChatWorkspace` 继续显示项目 A 会话。
6. 文件预览等依赖有效 CWD 的区域可能已指向项目 B，形成跨项目状态不一致。

### 最小且推荐的修复

先确认产品语义：当前注释与现有行为都表明切换项目应关闭不匹配会话。

在 `handleCwdChange` 中，以单次状态迁移原子清理不匹配新 CWD 的工作区数据：

- `sessionTabs` 只保留 `cwd === 新 cwd` 的 tab；
- 对应从 `chatSlotIds` 清除 ID；
- 清理 `activeSessionTabId`、placeholder、pending session、相关运行态展示；
- 把焦点槽位收敛到可见范围；
- 保持 `chatSlotIdsRef` 与 state 同步。

不要仅依赖后续 Effect 隐式收敛，因为当前同步 Effect 的输入是 `sessionTabs`，而 CWD 变化本身不会触发它清除旧会话。

### 产品决策分支

如果产品真正要求允许多个项目会话同时出现在工作区，应反向修正：

- 侧边栏项目选择只影响会话列表和新会话目录；
- 不应清空 `selectedSession` 并宣称关闭会话；
- 有效项目目录不能由当前选中项目隐式覆盖工作区会话目录。

该分支会改变产品语义。按当前注释，推荐采用前述局部清理修复。

### 验收与测试

- 打开 A 会话后切换至 B，A 不再出现在工作区、槽位、URL 和活跃 tab 中。
- A 正在流式运行时切换 B，不得残留错误的运行状态提示。
- A 的占位新会话、pending 首轮会话也应被清理。
- 从 URL 恢复会话时不得误触发跨项目清理。

---

## 6. F-04：多窗口布局缩减导致非首槽草稿丢失

### 结论

**真实。** 原先关于资源重复的判断需要降级，但草稿丢失已经被代码路径证实。

### 已有机制与非问题项

以下机制有效，不应误判为重复资源缺陷：

1. 模型请求有模块级共享 Promise，多个窗口不会并发重复请求 `/api/models`。
2. 运行中 Agent 状态轮询只对焦点窗口启用。
3. SSE 为标签页级复用，不会因多个 ChatWindow 建立多个物理 EventSource。
4. 不同会话各自加载历史、运行时状态和协作状态是必要请求，不属于相同资源重复加载。

### 证据

**文件：`components/ChatWorkspace.tsx:102-105`**

```ts
const visibleCount = CHAT_LAYOUT_COUNTS[layoutMode];
```

**文件：`components/ChatWorkspace.tsx:131-146`**

```tsx
Array.from({ length: visibleCount }, (_, index) => {
  // 渲染窗口 index
});
```

从六窗口切换为单窗口时，只渲染 index `0`。index `1` 至 `5` 对应 ChatWindow 会卸载。

草稿缓存定义在 ChatWindow 的实例内部。

**文件：`components/ChatWindow.tsx:1273-1297`**

```ts
const inputStateCache = useRef<Map<string, ChatInputState>>(new Map());
```

卸载时该 Ref 销毁，当前不存在更上层或持久化的草稿恢复来源。

### 触发路径

1. 打开六窗口。
2. 在第 2 至第 6 个窗口输入未发送草稿。
3. 切换为单窗口布局。
4. 恢复多窗口布局。
5. 非首槽位草稿无法恢复。

### 最小且推荐的修复

不要为了保留草稿而让隐藏窗口持续挂载，否则会保留不必要的订阅、渲染与局部状态。

将草稿缓存上提到 `ChatWorkspace` 或 `AppShell` 生命周期，并使用槽位级 key：

```ts
type DraftKey = `slot:${number}:session:${string}`;
```

使用槽位 ID 而不只用 session ID，可避免同一会话在两个槽位时草稿相互覆盖。

`ChatWindow` 需要接收：

- 初始草稿；
- 保存草稿的回调；
- 清理草稿的回调。

清理时机：

- 成功发送；
- 用户显式关闭槽位；
- 用户显式清空输入；
- 产品定义的会话关闭操作。

### 验收与测试

- 六窗口分别输入不同草稿，切到单窗口再恢复，六份草稿都可恢复。
- 同一会话位于两个不同槽位时，草稿互不覆盖。
- 关闭一个槽位只清理该槽位草稿。
- 成功发送后按产品规则清理相应草稿。

---

## 7. A-01：`useAgentSession` 的职责耦合

### 结论

**部分真实。** 这是架构债务，不是可以单纯以文件行数定性的线上缺陷。

### 合理内聚部分

以下内容属于会话生命周期的核心内聚，不应机械拆开：

- Agent 回合状态；
- 消息一致性；
- SSE 状态同步；
- 乐观消息与持久化快照对账；
- 发送、停止、恢复等核心会话动作。

### 已确认的耦合问题

**文件：`hooks/useAgentSession.ts:499-3122`**

该 Hook 同时包含：

1. 会话快照加载、分页、乐观消息确认；
2. SSE、瞬态状态订阅、渲染节流；
3. 发送、停止、steer、follow-up；
4. watchdog、重试、TTFT 超时与自动恢复；
5. 压缩、模型、thinking level、工具预设、Agent mode；
6. 子 Agent 短轮询与水合；
7. 控制面缓存和 `localStorage` 偏好；
8. 滚动 DOM Ref 与自动滚动策略。

**文件：`components/ChatWindow.tsx:523-547`**

`ChatWindow` 一次性解构约 55 个成员，包括领域状态、基础设施状态、DOM Ref、命令和低层 setter。

真正的风险不是文件长，而是 SSE 事件处理会同时编排流更新、历史重载、恢复、子 Agent 刷新、压缩状态、父回调与终态 UI，使任一事件分支的测试闭包过大。

### 推荐的渐进式拆分

保持 `useAgentSession` 对 `ChatWindow` 的公开接口兼容，逐步抽取：

```text
hooks/agent-session/
  useChatAutoScroll.ts
  useSessionHistory.ts
  useSessionStream.ts
  useTurnRuntime.ts
  useSessionPreferences.ts
```

建议顺序：

1. `useChatAutoScroll`：DOM 行为，风险最低。
2. `useSessionHistory`：快照、分页、对账、请求取消。
3. `useTurnRuntime`：SSE 事件决策、回合状态机、watchdog、恢复。
4. `useSessionPreferences`：模型、工具、模式、thinking、子 Agent 开关。

### 不建议的方案

- 不要因为文件过长就直接按函数名拆 Hook。
- 不要立即引入 Redux、Zustand 或全局 store。
- 不要重写 `ChatWindow` 与 RPC 会话协议。
- 不要在缺少回归测试的情况下重构运行时状态机。

### 验收与测试

拆分后应能分别测试：

- 消息对账，不依赖 SSE；
- 事件状态机，不依赖 DOM；
- 自动滚动，不依赖 Agent 命令；
- 模型和工具偏好，不依赖完整会话历史。

现有行为必须保持：会话切换、断线恢复、TTFT 自动恢复、工具结束、停止流程、压缩结束。

---

## 8. A-02：组件内 API 调用分散

### 结论

**部分真实。** 直接 `fetch` 不是天然问题；当前问题是请求语义、失败状态和缓存策略不一致。

### 已有合理边界

- `lib/agent-client.ts` 已为 Agent 命令提供超时、业务错误和不确定提交处理。
- `lib/client-resilience.ts` 已为控制面 GET 提供重试、超时与本地缓存工具。
- `FileExplorer` 按需请求、SSE、以及高频状态轮询不应强制采用同一种缓存和重试策略。

### 已确认风险

`MemoryConfig` 是直接后果：读取失败没有被建模为不可写状态，形成 F-02 数据覆盖问题。

### 推荐方案

不引入第三方请求库，不全量迁移所有 `fetch`。

建立按请求语义分类的轻量边界：

```text
lib/client-api/
  control-plane.ts  # 可缓存、可重试的低频 GET
  command.ts        # 非幂等写操作：超时与提交不确定性显式处理，不自动重试
  polling.ts        # 高频轮询：短超时、取消旧请求、默认不重试
```

迁移优先级：

1. `MemoryConfig`
2. `SystemPromptConfig`
3. `McpConfig`
4. `SkillsConfig`
5. `ModelsConfig`

### 不建议的方案

- 不要将 FileExplorer、SSE 和轮询请求全部强制迁移。
- 不要引入 React Query、SWR、Axios 作为修复 F-02 的前提。
- 不要让写操作继承 GET 的自动重试策略。

---

## 9. A-03：跨组件通信机制并存

### 结论

**部分真实。** 多种机制各自跨越不同边界，并不构成需要整体重写的架构错误。

| 机制 | 当前判断 |
|---|---|
| React props | 合理，组件树内部通信 |
| `BroadcastChannel` | 合理，用于主窗口与独立预览窗口 |
| Tauri event | 合理，用于跨 Webview 原生窗口通信 |
| `localStorage` | 合理，用于偏好持久化 |
| `refreshKey` | 可接受，但应限制新增使用 |
| `window.dispatchEvent` | 可用但类型弱，应逐步收敛 |
| `agentEventBus` | 有真实作用域缺陷，见 F-01 |

### 已确认的低优先级问题

1. `MemoryConfig` 保存成功后广播角色更新，会使保存方自身再加载一次。
2. 文件预览同时使用 `BroadcastChannel` 与 Tauri event，部分状态可能收到两次；当前处理基本幂等。
3. 模型配置保存和关闭可能让多个聊天窗口重复刷新模型列表。

这些路径暂未发现确定性状态错误，优先级应低于 F-01 至 F-04。

### 推荐方案

- 保留跨窗口的 `BroadcastChannel` 与 Tauri event。
- 对应用内通知逐步建立带类型和 payload 的轻量事件定义。
- 不再新增无 payload 的字符串 DOM Event。
- 修复 F-01 后再评估是否需要统一角色、模型等控制面通知。

---

## 10. O-01：低频配置面板静态导入增加初始客户端依赖

### 结论

**真实的性能优化点。** 但尚未证明已经造成用户可感知性能问题。

### 证据

**文件：`app/page.tsx:1-8`**

```tsx
import { AppShell } from "@/components/AppShell";
```

**文件：`components/AppShell.tsx:10-17`**

```ts
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { SchedulerPanel } from "./SchedulerPanel";
import { RoleConfig } from "./RoleConfig";
import { MemoryConfig } from "./MemoryConfig";
import { McpConfig } from "./McpConfig";
import { ExtensionsConfig } from "./ExtensionsConfig";
import { WeChatConfig } from "./WeChatConfig";
```

这些组件即便只在打开状态下挂载，仍属于 `/` 初始路由的客户端模块图。

### 表述边界

- 这不意味着模块源码进入第一个 HTML 响应。
- 这不保证每个模块分别形成独立网络请求，构建器可合并或提取 chunk。
- 但它们会增加初始路由需要下载、解析和执行的客户端 JS 依赖集合。
- 当前尚无 gzip/Brotli 体积、解析时间、LCP 或真实用户性能数据，因此不能断言已经造成卡顿。

### 推荐方案

对低频且体积较大的配置面板使用 `next/dynamic`：

```ts
import dynamic from "next/dynamic";

const ModelsConfig = dynamic(() =>
  import("./ModelsConfig").then((module) => module.ModelsConfig),
);
```

优先顺序：

1. `ModelsConfig`
2. `SkillsConfig`
3. `SchedulerPanel`
4. `RoleConfig`
5. `McpConfig`

默认保留 SSR 行为；只有明确不能安全服务端预渲染的组件，才使用 `ssr: false`。

### 验收建议

在 release 或专门性能分支测量，而不是开发期间运行 `next build`：

- `/` 路由的初始 JS 体积；
- 首次加载的脚本数量；
- 动态打开面板的加载时延；
- 低网速下初始可交互时间。

---

## 11. F-05：独立文件预览窗口主题不同步

### 结论

**真实。** 优先级较低，但修复成本小。

### 证据

**文件：`components/FilePreviewWindow.tsx:1-147`**

该组件没有调用 `useTheme()`，也没有监听主题同步事件。

**文件：`hooks/useTheme.ts:27-110`**

主题变更只会：

- 修改当前文档的 `html.dark` class；
- 写入 `localStorage`；
- 设置当前 Tauri Window 的主题。

因此独立文件预览窗口不会可靠初始化为主窗口当前主题，也不会在主窗口切换主题时实时同步。

### 触发路径

1. 主窗口使用深色主题。
2. 打开独立文件预览窗口。
3. 预览窗口默认可能显示浅色主题。
4. 在主窗口切换主题。
5. 预览窗口保持旧主题。

### 推荐方案

先在 `components/FilePreviewWindow.tsx` 调用 `useTheme()`：

```ts
export function FilePreviewWindow() {
  useTheme();
  // ...
}
```

这能保证独立窗口启动时读取已存主题。

若实测 Tauri 多 Webview 下 `storage` 事件无法处理运行期同步，再增加独立主题事件。不要复用文件预览状态事件，也不要为此引入全局主题状态框架。

---

## 12. 推荐实施顺序

### 第一批：修复确定性缺陷

1. F-01：为 `agentEventBus` 增加 `sessionId` 事件信封与订阅过滤。
2. F-02：修复 `MemoryConfig` 的加载失败与保存授权状态。
3. F-03：修复 CWD 切换时的工作区状态迁移。
4. F-04：将草稿缓存提升到窗口生命周期之外。

### 第二批：低风险完善

5. F-05：修复独立文件预览窗口主题初始化和同步。
6. O-01：动态加载低频大型配置面板。
7. A-02：建立轻量、按请求语义分类的 client API 边界。

### 第三批：渐进架构治理

8. 从 `useAgentSession` 提取滚动逻辑、历史读取、运行时事件决策。
9. 保持 `useAgentSession` 对外接口兼容，避免大规模重写。
10. 在重构前补足会话切换、流恢复、自动恢复、停止和压缩流程的回归测试。

---

## 13. 明确不建议执行的动作

- 不建议立即引入 Redux、Zustand、React Query、SWR 或其他全局状态与请求框架。
- 不建议因为 `useAgentSession` 较大就一次性重写聊天会话架构。
- 不建议强制所有 `fetch` 走同一客户端封装。
- 不建议为了保存草稿而让不可见窗口永久挂载。
- 不建议仅通过注释或人工约定维持会话状态一致性。
- 不建议开发期间运行 `next build`；如需验证，应优先使用类型检查、lint、既有测试与针对性浏览器回归。

---

## 14. 审计结论

当前 DeerHux 前端的基础通信架构是可持续的，特别是标签页级 SSE 多路复用和会话快照保护具备良好基础。

后续重点不应是重写，而应遵循以下策略：

1. 先修复已证实的会话作用域、数据覆盖、跨项目状态和草稿丢失问题。
2. 对低频配置和跨窗口体验做小范围、低风险改善。
3. 以保持会话协议稳定为前提，逐步拆分 `useAgentSession` 的非核心职责。

核心原则：**优先修复明确可复现的行为错误，避免为架构整洁而破坏已实现的异常时序防护。**
