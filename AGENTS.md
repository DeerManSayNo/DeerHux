# DeerHux - 开发笔记

## 编码规范

- 回答和思考过程（thinking）全部使用中文
- 查找函数、组件、类、接口、调用关系时，优先使用 codegraph_search / codegraph_callers / codegraph_callees / codegraph_impact，不要优先用 bash/grep/find。
- 用 code_search 做关键字快速检索，codegraph_search 做语义符号搜索。

## 快速开始

```bash
npm run dev   # 端口 30141
```

类型检查：`node_modules/.bin/tsc --noEmit`  
代码检查：`npm run lint`（Next 16 已移除 `next lint` 子命令，对应 `package.json` 中的 `eslint .`）  
**开发期间绝不要运行 `next build`** —— 会污染 `.next/` 目录并导致 `npm run dev` 无法正常工作。
`next build` 仅用于 release 流程（`npm run release`），开发期间禁止运行。

---

## 架构

```
浏览器                   Next.js 服务端             AgentSession（进程内）
  │                        │                               │
  ├─ GET /api/sessions ────▶ 读取 ~/.deerhux/agent/sessions/   │
  ├─ GET /api/sessions/[id] 直接读取 .jsonl 文件              │
  │                        │                               │
  ├─ 发送消息 ─────────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE 连接 ────────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session 浏览**（只读）：通过 `lib/session-reader.ts` 直接读取 `.jsonl` 文件 —— 不会创建 AgentSession。  
**发送消息**：`lib/rpc-manager.ts` 中的 `startRpcSession()` 在进程内创建一个 AgentSession。

---

## 文件地图

```
app/api/
  sessions/route.ts               GET  列出所有 session
  sessions/[id]/route.ts          GET/PATCH/DELETE 单个 session
  sessions/[id]/context/route.ts  GET ?leafId= — 获取指定叶子节点的上下文
  sessions/new/route.ts           返回 410（已废弃）
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET 获取状态 | POST 发送任意指令
  agent/[id]/events/route.ts      GET SSE 事件流
  files/[...path]/route.ts        GET 获取文件内容供查看器使用
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/POST — 读写 ~/.deerhux/agent/models.json

lib/
  rpc-manager.ts      AgentSessionWrapper + 注册表 + startRpcSession
  session-reader.ts   解析 .jsonl；getModelNameMap/getModelList/getDefaultModel
  types.ts            共享 TypeScript 类型定义
  normalize.ts        normalizeToolCalls() — 处理文件格式与内部类型间的字段名不匹配
  system-prompt-off.ts  所有工具禁用时的最小化 system prompt

components/
  AppShell.tsx        布局 + URL 状态 + 标签页管理
  SessionSidebar.tsx  session 树 + FileExplorer
  ChatWindow.tsx      消息 + 流式输出 + SSE + fork/navigate 逻辑
  ChatInput.tsx       输入栏 + 模型/思考/工具/压缩控制
  MessageView.tsx     渲染单条消息（user/assistant/toolCall/toolResult）
  BranchNavigator.tsx session 内分支切换器
  ChatMinimap.tsx     消息列表旁的滚动缩略图
  ToolPanel.tsx       导出 PRESET_NONE/DEFAULT/FULL + getPresetFromTools
  ModelsConfig.tsx    编辑 models.json 的弹窗（从侧边栏底部打开）
  FileExplorer.tsx    侧边栏内的文件树
  FileViewer.tsx      在标签页中显示文件内容
  TabBar.tsx          标签栏（聊天 + 打开的文件标签页）
```

---

## 关键设计决策与陷阱

### AgentSession 生命周期（`lib/rpc-manager.ts`）
- 每个 session id 对应一个 `AgentSessionWrapper`，以 `globalThis.__deerhuxSessions` 为键存储
- `globalThis` 能在 Next.js 热重载中存活；普通模块级 Map 做不到
- 空闲超时：10 分钟。并发 `startRpcSession()` 调用共享同一个启动 Promise（`globalThis.__deerhuxStartLocks`）

### Fork 必须立即销毁 wrapper
`AgentSession.fork()` **会原地修改 wrapper 的内部状态** —— fork 之后，`inner.sessionId` 变成了*新* session 的 id。如果 wrapper 在注册表中以旧 id 继续存活，下一次请求拿到的就是已经 fork 过的状态，后续 fork 会生成损坏的 `parentSession` 链。

**修复方案**：`send("fork")` 先捕获 `newSessionId`，然后在返回之前调用 `this.destroy()`。对原始 session 的下一次请求会从原始文件重新加载一个干净的 AgentSession。

### 两种分支 —— 不要混淆
- **Fork**（用户消息上的 Fork 按钮）：创建新的独立 `.jsonl` 文件。通过 header 中的 `parentSession` 字段在侧边栏树中显示为子节点。
- **Session 内分支**（Continue 按钮 / BranchNavigator）：在同一个文件内调用 `navigate_tree`。多个条目共享相同的 `parentId`。切换分支时调用 `/api/sessions/[id]/context?leafId=`。

### Session 文件可以被完整重写
Header 中的 `parentSession` **仅用于显示元数据** —— 对聊天内容没有任何影响。可以安全地 `writeFileSync` 整个文件（DeerHux 自己迁移时就是这么做的）。用于删除时级联重新挂接子节点。

### ToolCall 字段规范化
DeerHux 存储 toolCall 块格式为 `{type:"toolCall", id, name, arguments}`，但 `ToolCallContent` 使用的是 `{toolCallId, toolName, input}`。`lib/normalize.ts` 中的 `normalizeToolCalls()` 负责处理这个转换 —— 在 `session-reader.ts`（文件加载）和 `ChatWindow.handleAgentEvent()`（流式输出）中都会调用。

### 新 session 的工具预设
工具名称在 session 创建时传入（`POST /api/agent/new` → `toolNames[]`）。对已有 session，挂载时通过 `get_tools` → `getPresetFromTools()` 推断当前的预设。当工具被完全禁用时（`toolNames = []`），`rpc-manager.ts` 会通过 `system-prompt-off.ts` + `DefaultResourceLoader` 注入最小化 system prompt。

### 新 session 的模型默认值
`GET /api/models` 返回从 `~/.deerhux/agent/settings.json` 读取的 `defaultModel`。`ChatWindow` 在挂载时为新建 session 预选此默认模型。

### 页面刷新时中断流的 SSE 重连
`ChatWindow` 挂载时，会调用 `GET /api/agent/[id]`。如果 `state.isStreaming === true`，则自动重新连接 SSE。`thinkingLevel` 和 `isCompacting` 也会从此响应同步。

### 压缩 SSE 事件
新版 DeerHux 发出 `compaction_start` / `compaction_end`；旧版发出 `auto_compaction_start` / `auto_compaction_end`。`handleAgentEvent` 同时接受两组事件以保持 `isCompacting` 同步。手动压缩是阻塞式的 POST —— 按钮在响应返回前保持禁用状态。

### 孤儿 session
首行无法解析为有效 header 的 session 会在 API 响应中标记为 `orphaned: true` —— 在侧边栏中显示为「不完整」标记且不可点击。

---

## DeerHux Session 文件格式

存放位置：`~/.deerhux/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext` 中的 `entryIds[]` 是与 `messages[]` 并行的数组 —— 将每条展示消息映射回其 `.jsonl` 条目 id，供 fork 和 navigate_tree 调用使用。

---

## CSS 变量（`app/globals.css`）

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
