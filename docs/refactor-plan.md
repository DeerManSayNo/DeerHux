# 巨型文件拆分计划

## 背景

DeerHux 当前有 6 个超过 1800 行的源文件，总计约 12000 行，集中了过多职责，阻碍 code review、hot-reload 和单元测试覆盖。本计划给出按职责拆分的方案与优先级，**不实际修改代码**。

## 巨型文件清单

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `lib/engine/deer-loop.ts` | 2306 | 自研 Agent Loop 引擎（loop 主循环、compaction、steering、stream 消费） |
| `components/ChatInput.tsx` | 2144 | 聊天输入栏（模型选择、思考级别、工具面板、压缩控制、附件） |
| `components/FileViewer.tsx` | 2048 | 文件查看器（语法高亮、图片/音频/视频预览、文档渲染） |
| `components/SessionSidebar.tsx` | 2036 | 会话树 + 文件浏览器 + 项目切换 |
| `components/AppShell.tsx` | 1978 | 全局布局 + URL 状态 + 标签页管理 |
| `lib/rpc-manager.ts` | 1851 | AgentSessionWrapper + 注册表 + 启动锁 + session 生命周期 |

## 拆分总原则

1. **纯函数先行**：优先抽取无状态的纯函数 / 常量 / 类型，零行为风险。
2. **类型集中**：共享类型独立到 `types.ts`，减少循环依赖。
3. **public API 不变**：拆分后通过 barrel export 保持对外接口不变。
4. **小步快走**：每个 PR 只拆一个文件的一个职责层。
5. **不改行为**：拆分是纯结构重构，不修复 bug、不改逻辑。
6. **测试锚点**：高风险文件拆分前先补端到端测试。
7. **组合优于继承**：引擎内部用模块 + 函数注入 engine 实例，而非继承链。

## 逐文件拆分方案

### P0-a: `FileViewer.tsx` → `components/file-viewer/`

**风险**：低（大量纯渲染逻辑）

**目标结构**：
```
components/file-viewer/
  index.tsx          — FileViewer 主组件（路由分发）
  text-viewer.tsx    — 代码 / 文本渲染 + 语法高亮
  image-viewer.tsx   — 图片预览
  media-viewer.tsx   — 音频 / 视频预览
  doc-viewer.tsx     — PDF / Office 文档渲染
  mime-helpers.ts    — MIME 类型映射 + 扩展名判断（纯函数）
  constants.ts       — EXT_TO_LANGUAGE、IMAGE_EXT_TO_MIME 等常量表
```

### P0-b: `AppShell.tsx` → `components/shell/`

**风险**：中（涉及全局状态）

**目标结构**：
```
components/shell/
  AppShell.tsx        — 布局骨架（缩减到 ~300 行）
  use-tab-state.ts    — URL 状态 ↔ 标签页管理 hook
  use-layout-state.ts — 侧边栏宽度 / 面板折叠状态 hook
  tab-coordinator.ts  — 多标签页协调逻辑
```

### P0-c: `ChatInput.tsx` → `components/chat-input/`

**风险**：中（大量事件回调）

**目标结构**：
```
components/chat-input/
  index.tsx           — ChatInput 主组件
  model-selector.tsx  — 模型选择下拉
  thinking-control.tsx— 思考级别控制
  tool-panel-bridge.tsx— 工具预设桥接
  attachment-area.tsx — 图片上传 / 粘贴
  use-send-message.ts — 发送消息 hook
```

### P1-a: `SessionSidebar.tsx` → `components/sidebar/`

**风险**：中高（session 树状态机复杂）

**目标结构**：
```
components/sidebar/
  index.tsx              — SessionSidebar 容器
  session-tree.tsx       — 会话树渲染 + fork / navigate
  file-explorer-panel.tsx— 文件浏览器面板
  project-switcher.tsx   — 项目切换器
  use-session-tree.ts    — session 树数据 hook
```

### P1-b: `rpc-manager.ts` → `lib/rpc/`

**风险**：高（核心生命周期管理）

**关键约束**（必须保留）：
- `globalThis.__deerhuxSessions` 不能改成普通模块级 Map（无法在 Next.js 热重载中存活）
- `send("fork")` 必须在返回前调用 `this.destroy()`（否则 parentSession 链损坏）
- 空闲超时 10 分钟 + generation counter 竞态防护不能丢
- `globalThis.__deerhuxStartLocks` 启动锁共享逻辑不能丢
- `MAX_REGISTRY_SESSIONS` 容量上限 + evict 逻辑不能丢

**目标结构**：
```
lib/rpc/
  index.ts                 — barrel export（保持对外 API 不变）
  session-wrapper.ts       — AgentSessionWrapper 类
  registry.ts              — getRegistry / 别名 / evict / 容量上限
  session-lifecycle.ts     — startRpcSession / startDeerLoopSession
  event-bus.ts             — SSE 事件分发
  idle-watchdog.ts         — 空闲检测 / stale warning / destroy
```

### P2: `deer-loop.ts` → `lib/engine/`（多文件）

**风险**：最高（核心 Agent Loop 引擎）

**前置条件**：先补端到端集成测试覆盖 prompt → tool call → tool result → response 完整链路。

**目标结构**：
```
lib/engine/
  deer-loop.ts         — DeerLoopEngine 主类（缩减到 ~500 行）
  compaction.ts        — 上下文压缩逻辑
  steering-queue.ts    — steering 指令队列
  stream-consumer.ts   — SSE 流消费 + 事件分发
  loop-types.ts        — 引擎内部类型
```

## 执行路线图

| 批次 | 内容 | 前置 |
|------|------|------|
| PR-1 | FileViewer 拆分（纯函数 + 常量先抽） | 无 |
| PR-2 | AppShell + ChatInput hooks 抽取 | PR-1 验证通过 |
| PR-3 | SessionSidebar + rpc-manager 拆分 | 补 rpc-manager 单元测试 |
| PR-4 | deer-loop 拆分 | 补端到端集成测试 |

## 验收标准

- [ ] `tsc --noEmit` 零错误
- [ ] `npm run lint` 无新增错误
- [ ] 单文件 ≤ 800 行（引擎主文件 ≤ 600 行）
- [ ] 对外 import 路径不变（barrel export）
- [ ] 未运行 `next build`
- [ ] 手动验证：发消息 / fork / 切换分支 / 上传图片 / 查看文件均正常
