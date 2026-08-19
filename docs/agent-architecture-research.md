# Coding Agent 技术架构预研：DeerHux 与主流 Agent 对比

> **文档状态**：技术预研（非竞品内部实现审计）
> **DeerHux 基线版本**：`0.6.12`
> **证据原则**：DeerHux 结论来自当前工作区源码；竞品结论仅使用官方公开文档、官方仓库入口或已安装的官方 npm 发布物。未公开的内部机制一律标为**不可验证**，不以产品功能反推实现。
> **本地参考项目说明**：`/Users/deerman/Documents/LuYuAllProject/TempProject/codeAgent` 不在当前工作区访问权限内，本次未对其作源码结论，后续需挂载只读副本补充。
> **外部引用说明**：竞品 URL 是官方复核入口；当前环境未抓取其网页正文，因此不记录为本次已复现的页面快照，也不据此推断未公开实现。

---

## 1. 执行摘要

### 1.1 DeerHux 是什么架构

DeerHux 不是单纯的 TypeScript 聊天 UI，而是一套以 **TypeScript/Node.js 为核心运行时** 的本地优先 Coding Agent Harness：

```text
┌──────────────────────────────── 浏览器 / 桌面端 ────────────────────────────────┐
│ Next.js + React UI                         Tauri 桌面壳（Rust）                 │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                │ HTTP / SSE
┌───────────────────────────────▼────────────────────────────────────────────────┐
│ Next.js Route Handler / rpc-manager（当前生产主链路）                             │
│ Session API · Agent API · 全局事件多路复用 · 断线重放 · 运行诊断                  │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                │ AgentSessionWrapper / AgentEnginePort
┌───────────────────────────────▼────────────────────────────────────────────────┐
│ DeerLoopEngine（自研 TypeScript Agent Loop）                                    │
│ Prompt 状态机 · 流式事件 · 工具循环 · 重试 · 中止 · Steering/Follow-up · 压缩     │
└───────┬─────────────────┬──────────────────┬─────────────────────┬─────────────┘
        │                 │                  │                     │
┌───────▼───────┐ ┌───────▼────────┐ ┌──────▼──────────┐ ┌────────▼───────────┐
│ ToolRegistry  │ │ ToolExecutor   │ │ SessionPort      │ │ LLM Gateway        │
│ MCP 热替换    │ │ 并/串行执行    │ │ JSONL 消息树     │ │ pi-ai streamSimple │
└───────┬───────┘ └───────┬────────┘ └──────┬──────────┘ └────────┬───────────┘
        │                 │                  │                     │
        ▼                 ▼                  ▼                     ▼
 标准代码工具 /        文件、Shell、      本地 session 文件       多 Provider 模型 API
 CodeGraph / MCP /     检索与扩展          与上下文归档
 Subagent
```

结论：

1. **主系统是 TypeScript**：Next.js、React、Agent Runtime、DeerLoop、MCP Runtime、Session、Subagent 编排均由 TS 实现。
2. **不是 TS-only**：桌面交付使用 Tauri，因此存在 Rust 壳层；工具也可能启动 Shell、MCP 子进程或访问外部服务。
3. **Agent Loop 所有权在 DeerHux**：`DeerLoopEngine` 持有工具循环、流式事件、重试、队列和压缩编排；并非把 `pi-coding-agent` 的完整 AgentSession 作为黑盒使用。
4. **pi 的定位是可控依赖而非宿主运行时**：`pi-ai` 提供模型/Provider 流式传输；`pi-coding-agent` 仍提供 `SessionManager`、上下文转换和部分压缩基础能力。
5. **当前部署形态是单机、Node 后端进程内优先**：`AgentSessionWrapper`、DeerLoop 与 EventStore 在同一 Next.js/Node 后端进程内管理活动会话，浏览器以 SSE 获取实时事件。`AgentEnginePort` 已形成可替换边界；`agent-app-server` 的 Protocol/Broker 目前是预留/试验性组件，尚未进入浏览器 HTTP/SSE 的主调用链。

### 1.2 与其他 Agent 的定位

| 产品 / 项目 | 可确认的产品形态 | Loop 内部实现公开度 | 与 DeerHux 最有价值的对照点 |
|---|---|---:|---|
| DeerHux | Web/桌面 Harness，本地 Agent Runtime | 高：当前仓库可审计 | 自研 Loop、JSONL 会话树、SSE 重放、MCP、协作 Agent |
| Claude Code | 本地终端 Coding Agent | 低：核心内部实现不应假定公开 | 权限规则、Hooks、Subagent 产品契约、CLI 自动化 |
| Cursor | 编辑器 Agent、CLI、云端 Background Agent | 低：内部拓扑与 Loop 不公开 | IDE 体验、代码库索引、云端异步执行、Rules/Skills |
| OpenCode | 开源 Coding Agent 项目 | 本次未获得源码正文，待核验 | 开源产品的会话、Provider、插件/MCP 取舍 |
| pi-mono / pi-coding-agent | TypeScript/Node Agent SDK 与 Coding Agent | 高：官方 npm 包已安装，可部分审计 | DeerHux 的直接上游依赖、会话树、压缩与扩展语义 |

> 不能根据 Claude Code、Cursor 的产品能力宣称其与 DeerHux 使用相同的 Loop、JSONL、SSE、工作线程或隔离算法；这些内部实现没有被本次资料证明。

---

## 2. 研究范围、方法与证据分级

### 2.1 研究问题

- DeerHux 是否主要由 TypeScript 构成？其运行时、Loop、工具、会话和事件架构是什么？
- 主流 Coding Agent 在 Agent Loop、工具协议、上下文、子 Agent、安全与可观测性上的公开设计是什么？
- DeerHux 应借鉴哪些机制，又应避免哪些过早复杂化？

### 2.2 证据等级

| 等级 | 定义 | 本文用法 |
|---|---|---|
| A | 当前工作区源码、已安装官方发布包、可读取的官方源码 | DeerHux 与 pi 的关键实现结论 |
| B | 官方文档、官方产品页、官方仓库入口 | Claude Code、Cursor 的能力与配置契约 |
| C | 社区文章、行业经验或未经验证推断 | 不作为架构事实；本文不据此下结论 |

### 2.3 本次限制

- 运行环境不能直接读取竞品官方网页正文，文中 URL 供后续复核；竞品部分只陈述对应官方资料公开的能力范围。
- `codeAgent` 本地参考目录不在可访问工作区，未纳入实现级比较。
- 这不是安全合规审计，未评估任何竞品或 DeerHux 的真实数据保留、密钥管理、供应链与合同承诺。

---

## 3. DeerHux 当前可审计架构

### 3.1 技术组成

`package.json` 显示当前核心依赖如下：

| 领域 | 技术 / 依赖 | 作用 |
|---|---|---|
| UI 与 Web 服务 | Next.js 16、React 19、TypeScript 5.9 | Web UI、API Route、SSE |
| Agent 模型层 | `@earendil-works/pi-ai` | 统一模型类型与 `streamSimple` 流式 Provider 调用 |
| Session 与基础语义 | `@earendil-works/pi-coding-agent` | JSONL `SessionManager`、上下文构建、部分压缩能力 |
| 本地检索 | `@colbymchenry/codegraph` | 代码图谱索引及语义检索 |
| 桌面端 | Tauri 2 | 原生桌面应用壳层，含 Rust 侧 |
| 扩展 | MCP stdio Runtime | 外部工具服务接入 |

源码证据：[`package.json`](../package.json)、[`lib/engine/deer-loop.ts`](../lib/engine/deer-loop.ts)。

### 3.1.1 部署与进程边界

| 场景 | UI 所在进程 | Agent Runtime 所在进程 |
|---|---|---|
| 开发 Web | 浏览器 | Next.js 开发服务器的 Node 进程 |
| Web 部署 | 浏览器 | Next.js/Node 服务进程 |
| Tauri Release | Tauri Rust/Webview | Tauri 拉起的本地 Node/Next 子进程 |

这里的“进程内”仅指 `AgentSessionWrapper`、DeerLoop 与 EventStore 在**同一个 Node/Next 后端进程**内，不代表 Tauri 桌面应用是单进程。Tauri Release 会启动本地 Node 后端，并让 Webview 导航至 `127.0.0.1` 的本地 HTTP 地址。

当前浏览器到 Agent 的生产调用链为：

```text
Browser / Webview → Next.js Route Handler → rpc-manager / ensureRpcSession
→ AgentSessionWrapper → DeerLoopEngine
```

`lib/agent-app-server` 的 Protocol、Broker 与 in-process transport 是可独立测试的候选通信基础，尚未承载上述 HTTP/SSE 主链路；应在目标演进图中，而不是当前调用链中理解它。

源码证据：[`app/api/agent/[id]/route.ts`](../app/api/agent/[id]/route.ts)、[`lib/rpc-manager.ts`](../lib/rpc-manager.ts)、[`lib/agent-app-server/protocol.ts`](../lib/agent-app-server/protocol.ts)、[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs)。

### 3.2 Agent Loop：DeerLoopEngine

`lib/engine/deer-loop.ts` 声明 DeerLoop 负责：

- Prompt 的流式消费与规范化事件顺序；
- LLM 输出中的多轮工具调用循环，并使用轮数上限阻止无限调用；
- 工具结果回写，再次请求模型；
- Prompt 并发保护与中止；
- 自动重试、限流/上游健康度集成；
- Steering 与 Follow-up 队列；
- 手动/阈值/溢出压缩；
- Session JSONL 持久化编排；
- 可注入 `streamFn`，以便单元测试模拟模型流。

其关键事件顺序契约是：

```text
agent_start
  → message_start
  → message_update × N
  → message_end
  → agent_end
```

中止时仍保证 `message_end` 和 `agent_end` 配对。这是 UI 恢复、事件重放和外部观察者可以依赖的协议，不应由页面组件自行补齐。

**架构取舍**：DeerHux 保留 `pi-ai` 的模型 Provider 兼容性，但将 Agent Loop 从 pi 的完整运行时中抽出。这使工具执行模式、MCP 热替换、事件契约与可靠性策略可由本项目控制，同时避免重新维护各 Provider 的底层流式协议。

源码证据：[`lib/engine/deer-loop.ts`](../lib/engine/deer-loop.ts)、[`lib/engine/port.ts`](../lib/engine/port.ts)、[`lib/engine/deer-loop-engine-factory.ts`](../lib/engine/deer-loop-engine-factory.ts)。

### 3.3 端口与组合根：避免框架依赖扩散

`AgentEnginePort` 将引擎能力拆为以下接口面：

```text
AgentEnginePort
├── State：isStreaming、isCompacting、模型、思考等级、上下文用量
├── Event：subscribe
├── Turn：prompt / steer / followUp / abort
├── Model：setModel / setThinkingLevel
├── Prompt：setSystemPromptPersistent
├── Navigation：navigate
├── Compaction：compact / abortCompaction / 策略开关
├── ToolControl：工具白名单、执行模式、热替换
└── Lifecycle：installRetryHardening / dispose
```

`composeDeerLoopEngine()` 负责将资源组合到引擎，而 `rpc-manager` 继续负责 Wrapper、注册表、别名和 SSE 生命周期。组合时会：

1. 打开或新建 Session；
2. 从 Session 恢复消息、模型与思考等级；
3. 选择可用模型；
4. 汇集标准工具、索引工具、CodeGraph、Subagent 与 MCP 工具；
5. 根据模式/白名单决定活动工具；
6. 注入 Session、模型目录、系统提示词和 LLM API Key 解析器；
7. 创建 DeerLoop 实例。

这属于 **六边形架构 / Ports and Adapters** 的实践：UI、pi、MCP、Session 存储未来可替换，而 Agent Loop 仅依赖显式能力边界。

源码证据：[`lib/engine/port.ts`](../lib/engine/port.ts)、[`lib/engine/deer-loop-composition.ts`](../lib/engine/deer-loop-composition.ts)。

### 3.4 工具：注册、执行与安全边界

工具由 `ToolRegistry` 维护单一事实源：

```text
全部注册工具 Map
+ 当前激活工具 Set（仅白名单暴露给模型）
+ 单工具 executionMode 覆盖
= 引擎可见工具集
```

它支持原子热替换：先移除旧 MCP 工具、再注册新工具、最后重设白名单，避免模型在中间状态见到幽灵工具。`ToolExecutor` 是执行职责的独立层，支持并行/串行执行语义及结果截断/归档，避免把大工具原文重新注入所有 Runtime 通道。

当前组合层会接入：

- 标准编码工具；
- 本地索引存在时的 `code_search`；
- CodeGraph 工具；
- `subagent` 工具；
- MCP Runtime 暴露的工具。

**安全含义**：工具白名单是已生效的模型可见性控制，不能代替 OS 沙箱、网络出口治理、秘密信息脱敏或人工审批。现有 `ToolExecutionPipeline` 已提供 `preExecute`、`guards`、`postExecute` 与 `onResult` 扩展点，可在执行前拒绝调用；但当前 DeerLoop 生产初始化未注入统一的路径、命令、网络、MCP 与人工审批策略。因此应在既有 Pipeline 上落实策略，而不是另建一条绕过 Executor 的权限路径。

源码证据：[`lib/engine/tool-registry.ts`](../lib/engine/tool-registry.ts)、[`lib/engine/tool-executor.ts`](../lib/engine/tool-executor.ts)、[`lib/engine/deer-loop-composition.ts`](../lib/engine/deer-loop-composition.ts)。

### 3.5 Session、上下文与压缩

DeerHux Session 以本地 JSONL 条目和树形上下文为主；常规消息写入为追加式，但协作快照等维护操作可整文件重写：

```text
session header
  └─ entry(id, parentId)
      ├─ message / toolResult
      ├─ model_change / thinking_level_change
      ├─ compaction / branch summary
      └─ custom entry（如协作任务快照）
```

`AgentSessionPort` 已将身份、读取自定义条目、写入模型/思考级别/自定义条目、导航和 Fork 等操作抽象出来。但它**尚未完全隔离存储实现**：DeerLoop 的压缩和上下文重建仍直接依赖 pi `SessionManager` 的分支、条目与 `appendCompaction()` 语义。因此，未来若迁移到数据库，需要先补齐 `SessionHistoryPort` / `SessionCompactionPort` 等能力，再移除引擎对具体 `SessionManager` 的直接依赖。

上下文策略包含：

- 使用当前 leaf 构建消息路径；
- 模型与思考等级可从持久化记录恢复；
- 历史图片在后续 Turn 降级为文本占位，防止换模型时重复发送图像；
- 压缩可按批处理并将历史转录归档；
- 会话内导航与 Fork 有不同语义：前者共享一个 Session 树，后者生成独立 Session 文件。

源码证据：[`lib/session/port.ts`](../lib/session/port.ts)、[`lib/engine/deer-loop.ts`](../lib/engine/deer-loop.ts)、[`lib/session/pi-session-adapter.ts`](../lib/session/pi-session-adapter.ts)。

### 3.6 事件、SSE 与恢复

运行时事件不是只靠一次 SSE 连接直接透传。`EventStore` 是内存事件日志，提供：

- run、session、global 三种作用域的序号；
- `epoch + globalSeq` 恢复游标；
- 容量、字节数与 TTL 限制；
- 游标被驱逐、超前、epoch 不匹配时明确要求客户端请求快照；
- 全局严格追加顺序的订阅；
- 事件合并时不混淆合并与驱逐。

这使页面刷新或 SSE 断线可优先尝试事件重放，无法安全重放时退化为状态快照，而不是静默丢失状态。

源码证据：[`lib/agent-runtime/event-store.ts`](../lib/agent-runtime/event-store.ts)、[`lib/agent-runtime/recovery-buffer.ts`](../lib/agent-runtime/recovery-buffer.ts)、[`lib/agent-runtime/sse-backpressure.ts`](../lib/agent-runtime/sse-backpressure.ts)、[`app/api/agent/events/route.ts`](../app/api/agent/events/route.ts)。

### 3.7 多 Agent：协作运行而非直接共享父上下文

`parallel-agent` 子系统已覆盖：任务规划、并发配额、Worker Session、运行状态、取消、结果聚合、运行快照持久化与 Git Worktree 隔离。

```text
父 Agent 的 subagent 工具
  → 任务规划（显式 worker 或 LLM 规划）
  → 预留并发配额
  → 只读研究 / 同工作区执行 / 隔离 worktree 编码
  → Worker 独立 Session 与事件
  → Collaboration Run Store（运行状态的持久化来源）
  → 结果聚合、Diff 回收
  → 父 Session custom entry（best-effort 关联/展示快照）
```

当前 `isolated_coding` 产品路径要求 Git 仓库，并在默认情况下拒绝 dirty worktree，避免 Worker 基于 `HEAD` 的隔离副本覆盖父工作区的未提交变更。底层 Worktree 模块仍保留非 Git 的临时目录复制能力，但该 fallback 尚未构成可审核 Diff、回收策略完整的稳定产品契约。父 Session 协作快照写入是 best-effort，失败不会中止协作运行。

源码证据：[`lib/parallel-agent/collaboration-orchestrator.ts`](../lib/parallel-agent/collaboration-orchestrator.ts)、[`lib/parallel-agent/worktree.ts`](../lib/parallel-agent/worktree.ts)、[`lib/parallel-agent/subagent-tool.ts`](../lib/parallel-agent/subagent-tool.ts)。

---

## 4. 主流 Agent 架构预研

### 4.1 Claude Code：闭源内核上的本地 CLI Agent

#### 可确认能力

Anthropic 官方文档公开 Claude Code 具备：本地 CLI 交互、代码库任务执行、MCP Server 集成、项目 Memory、工具权限规则、Subagents、Hooks、会话继续/压缩及组织使用量监控等能力。

| 维度 | 可确认的公开契约 | 内部实现边界 |
|---|---|---|
| 形态 | 本地安装的终端 Coding Agent，提供 CLI 自动化入口 | 具体语言、是否存在 daemon、进程拓扑不可确认 |
| 工具与 MCP | 可通过 MCP 扩展工具和上下文 | MCP 生命周期、缓存、stdio/HTTP transport 实现不可确认 |
| Subagents | 可定义带独立上下文、工具和权限配置的子 Agent | 并行调度、上下文汇总、隔离机制不可确认 |
| 权限 | 允许/询问/拒绝规则及权限模式 | 规则匹配与系统级沙箱实现不可确认 |
| 上下文 | Memory、会话继续、上下文管理与压缩能力 | 存储格式、摘要算法、裁剪规则不可确认 |
| Hooks | 生命周期 Hook 可供集成外部检查或观测 | 内部事件总线与遥测流水线不可确认 |

#### 对 DeerHux 的启示

1. **借鉴权限产品契约**：将工具权限区分为 allow / ask / deny，而不仅是活动工具白名单。
2. **借鉴 Hooks 的稳定性**：将 `agent_start`、工具前后、压缩、会话结束定义成可版本化的外部事件契约。
3. **不应照搬未知实现**：Claude Code 的内部 Loop、会话格式、并行模型没有公开证据，DeerHux 应继续以自身可测试的 `AgentEnginePort` 与事件协议演进。

官方资料：

- [Claude Code Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [How Claude Code works](https://docs.anthropic.com/en/docs/claude-code/how-claude-code-works)
- [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Permissions](https://docs.anthropic.com/en/docs/claude-code/permissions)
- [Memory](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Hooks guide](https://docs.anthropic.com/en/docs/claude-code/hooks-guide)
- [Monitoring usage](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)

### 4.2 Cursor：编辑器、CLI 与云端后台执行的混合产品

#### 可确认能力

Cursor 官方资料公开：编辑器内 Agent、CLI、MCP、Rules、Skills、Subagents、代码库索引，以及可异步在远程环境执行任务的 Background Agents。

| 维度 | 可确认的公开契约 | 内部实现边界 |
|---|---|---|
| 客户端 | 编辑器内 Agent 与终端 CLI 两种入口 | 编辑器进程、本地宿主与云服务的精确拓扑不可确认 |
| 后台执行 | Background Agents 是独立于本地编辑器的远程异步执行能力 | VM/容器、网络策略、数据隔离及任务调度实现不可确认 |
| 上下文 | Codebase indexing、Rules、Skills 参与 Agent 上下文 | 索引位置、嵌入模型、召回排序、prompt 拼装不可确认 |
| MCP / Subagents | 支持 MCP Server 与 Subagents | 子 Agent 上下文继承、并行、模型选择与聚合不可确认 |
| 隐私 | 提供 Privacy Mode 与公开安全/隐私说明 | 具体数据流须以当期账户、模式、合同和 Provider 为准 |

#### 对 DeerHux 的启示

1. **可借鉴双执行面**：将“本机交互式 Turn”和“远程/后台长任务”视为不同产品与安全域，而非给现有 Session 加一个后台开关。
2. **可借鉴上下文产品化**：CodeGraph、项目规则与 Skills 应在 UI 显示“本回合实际加载了什么”，增强可解释性和成本控制。
3. **不可直接比较**：Cursor 的 Agent Loop、索引算法和后台沙箱未公开；不能断言其可靠性或安全策略优于/等同 DeerHux。

官方资料：

- [Agent Overview](https://docs.cursor.com/agent/overview)
- [Cursor CLI](https://docs.cursor.com/cli/overview)
- [Background Agents](https://docs.cursor.com/background-agent/overview)
- [MCP](https://docs.cursor.com/context/mcp)
- [Rules](https://docs.cursor.com/context/rules)
- [Skills](https://docs.cursor.com/context/skills)
- [Subagents](https://docs.cursor.com/agent/subagents)
- [Codebase Indexing](https://docs.cursor.com/context/codebase-indexing)
- [Privacy Mode](https://docs.cursor.com/settings/privacy)

### 4.3 OpenCode：待获得官方源码副本后的重点对照对象

OpenCode 的官方入口为：

- [官方仓库：anomalyco/opencode](https://github.com/anomalyco/opencode)
- [官方文档](https://opencode.ai/docs)

本次环境未能读取该官方仓库或文档正文，因此以下事项**不在本文中断言**：

- 其实际运行时与主语言；
- Session / Message Tree 数据模型；
- Agent Loop 是否独立于 UI；
- Provider、MCP、插件、权限和压缩的实现方式；
- 子 Agent 是否存在及其隔离策略。

#### 后续补证清单

将 OpenCode 官方仓库以只读方式提供后，按下面的同一张审计表完成对比：

```text
package / runtime entry
→ agent loop 入口和状态机
→ tool schema、executor、permission gate
→ session schema、branch、compaction
→ provider abstraction、retry/rate limit
→ MCP / plugin host
→ subagent、worktree、cancellation
→ event transport、logging、metrics
```

这样可以避免因为它是开源项目，就错误地把不同版本、Fork 或社区插件的实现归因给官方架构。

### 4.4 pi-mono / pi-coding-agent：DeerHux 的直接技术参照

已安装的官方 npm 包 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 均为 `0.75.5`，包元数据指向官方 `pi-mono` 仓库。可确认其定位为 TypeScript/ESM/Node.js 体系，Node 运行时要求 `>=22.19.0`。

概念分层：

```text
pi-ai
  = 模型、Provider、消息类型、流式 API

pi-agent-core
  = 通用 Agent Loop、Agent 状态、工具调度、生命周期事件

pi-coding-agent
  = Coding CLI/TUI、Session JSONL 消息树、内置工具、资源加载、
    Extension、模型注册、上下文构建与压缩
```

pi 的核心价值是提供成熟的 Coding Agent 语义，特别是 Session 追加记录、`id/parentId` 消息树、叶节点导航、Fork、压缩与扩展生命周期。

#### DeerHux 与 pi 的边界

| 能力 | DeerHux 当前策略 |
|---|---|
| Provider 流式调用 | 复用 `pi-ai` |
| Agent Loop | 自研 `DeerLoopEngine` |
| 工具注册 / 执行 | 自研 `ToolRegistry`、`ToolExecutor` 与流水线 |
| MCP Runtime | 自研运行时与 stdio framing |
| 协作 / Subagent | 自研 planner、worker、worktree、聚合与状态持久化 |
| Session 与上下文基础 | 适配 pi 的 `SessionManager`、`buildSessionContext`、转换与部分压缩能力 |
| Web / Desktop UI | DeerHux 自研 Next.js + Tauri |

因此更准确的定位是：**DeerHux 是建立在 pi Provider/Session 语义基础上的独立 Agent Runtime 与可视化控制台，而不是 pi-coding-agent 的薄 UI 包装。**

官方入口：

- [pi-mono](https://github.com/earendil-works/pi-mono)
- [pi-ai](https://github.com/earendil-works/pi-mono/tree/main/packages/ai)
- [pi-agent-core](https://github.com/earendil-works/pi-mono/tree/main/packages/agent)
- [pi-coding-agent](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)

---

## 5. 横向对比矩阵

符号说明：**已实现**指 DeerHux 当前源码可见；**官方能力**仅指竞品文档公开能力，不表示内部实现相同；**待核验**表示本次没有一手实现证据。

| 架构维度 | DeerHux | Claude Code | Cursor | OpenCode | pi |
|---|---|---|---|---|---|
| 核心形态 | Web/桌面、本地进程内 Runtime | 本地 CLI，官方能力 | 编辑器 + CLI + 云后台，官方能力 | 待源码核验 | CLI/SDK，官方包可审计 |
| 主语言 / Runtime | TypeScript/Node；Tauri 含 Rust | 内部实现不可确认 | 内部实现不可确认 | 待核验 | TypeScript/ESM/Node |
| Loop 所有权 | 自研 DeerLoop | 未公开 | 未公开 | 待核验 | `pi-agent-core` / coding-agent |
| Provider 层 | `pi-ai` | 未公开 | 未公开 | 待核验 | `pi-ai` |
| 工具控制 | Registry 白名单、执行模式、Executor | 官方权限规则 | 官方 Agent 工具能力 | 待核验 | 工具定义与 Agent Runtime |
| MCP | 已实现 Runtime、stdio | 官方支持 | 官方支持 | 待核验 | 扩展/MCP 能力需按版本核验 |
| Session / 分支 | JSONL、树、导航、Fork | 继续会话能力；存储未公开 | 产品能力；存储未公开 | 待核验 | JSONL 消息树 |
| 压缩 | 已实现，支持归档 | 官方能力；算法未公开 | 内部算法未公开 | 待核验 | Session 语义支持 |
| Subagent | 协作运行、配额、Worktree | 官方支持 | 官方支持 | 待核验 | 以 extension/组合方式支持，具体实现按版本 |
| 断线恢复 | Event journal、cursor replay、snapshot fallback | 未公开 | 未公开 | 待核验 | CLI/SDK 机制不等同 Web SSE |
| 后台远程执行 | 当前未见托管远程执行面 | 产品能力不等于可确认内部拓扑 | 官方有 Background Agents | 待核验 | 非其核心目标 |
| 可观测性 | Runtime diagnostics、事件日志、LLM metrics | Hooks/监控能力公开 | 产品与安全资料公开 | 待核验 | 生命周期事件与扩展 |

---

## 6. 推荐目标架构与取舍

### 6.1 近期推荐：保持单机控制面 + 可替换 Runtime

```text
Browser / Tauri
   │
Next.js Control Plane
   ├── 会话与项目管理
   ├── SSE / Event Journal API
   ├── 鉴权、权限审批、配置
   │
Agent Runtime（当前进程内；后续可独立进程）
   ├── DeerLoopEngine
   ├── Tool Executor / Permission Gate
   ├── MCP Host
   ├── Subagent Orchestrator
   └── Session Adapter
```

选择理由：

- 当前 `AgentEnginePort` 为 Loop 替换提供边界；Node 后端进程内运行对本地文件访问、调试和迭代成本最低。
- 当前生产主链路是 `Route Handler → rpc-manager → AgentSessionWrapper → DeerLoopEngine`。`agent-app-server` 的 Protocol/Broker 可作为未来候选基础，但尚缺真实 transport、进程生命周期、鉴权、Session 所有权、取消与事件重放适配，不能视为已完成进程化。
- 立即拆微服务会引入工作区挂载、Session 所有权、工具进程、鉴权、流控和分布式追踪的复杂度，短期收益不够。
- 将 Runtime 从进程内迁移至本地子进程或远程 Worker 时，可保留 UI/API 和大部分 Loop 契约，但 Session 压缩相关的 pi `SessionManager` 直接依赖仍需先解耦。

### 6.2 中期推荐：建立显式的 Permission Gate

当前工具白名单控制“模型能否看到工具”；`ToolExecutionPipeline` 已具备执行前拒绝与审计扩展点。建议将其配置为统一的策略决策层：

```text
Tool call
  → schema validation
  → capability policy（allow / ask / deny）
  → 路径、命令、网络、MCP server 规则
  → 审批 / 审计日志
  → execute
```

建议策略粒度：

- 文件：工作区外读写、删除、批量改动；
- 命令：Shell、包安装、Git push、进程管理；
- 网络：域名 allowlist、上传与下载；
- MCP：Server 级别信任、工具级权限、密钥可见性；
- 子 Agent：是否可写、是否必须 Worktree、是否可使用高危工具。

**为什么不只靠 System Prompt**：提示词不能作为安全边界；模型输出、MCP 返回内容和 prompt injection 均可能绕过自然语言约束。

### 6.3 长期可选：本地执行面与远程后台执行面分离

若要引入类似 Background Agent 的能力，应建立新执行域，而不是复用当前交互 Session：

| 域 | 目标 | 强制机制 |
|---|---|---|
| 本地交互 Runtime | 低延迟、用户可见、可直接协作 | 本地权限审批、SSE、快速中止 |
| 本地隔离 Worker | 复杂编码但仍在用户机 | Git worktree、资源配额、可回收进程 |
| 远程后台 Worker | 长任务、异步 PR/结果交付 | 临时凭据、仓库快照、容器隔离、任务队列、审计与结果签名 |

放弃的备选方案：

- **直接把 Next.js Route Handler 当作远程 Job Worker**：请求生命周期和部署实例不稳定，长任务、恢复、取消与资源隔离都难以可靠处理。
- **所有 Subagent 共享主工作区**：会造成写入竞态和难以审查的变更；当前 Worktree 策略更安全。
- **以数据库替换 JSONL 作为第一优先级**：优先提升审计/恢复/权限的价值更高；同时当前压缩与上下文重建仍耦合 pi `SessionManager`，存储迁移必须先补齐历史与压缩端口，数据量和跨设备需求明确后再推进。

---

## 7. 分阶段演进路线图

| 优先级 | 工作项 | 价值 | 验证方式 | 风险与回滚 |
|---|---|---|---|---|
| P0 | 固化 Loop、工具、事件、Session 的契约测试 | 防止迭代破坏恢复与消息树语义 | 扩充 `test:core`；模拟重放、驱逐、abort、工具失败 | 仅加测试，可直接回滚 |
| P0 | 在 UI 展示本 Turn 的上下文来源、工具白名单、模型和预算 | 提高可解释性与成本控制 | UI 集成测试、人工场景测试 | 仅展示层，保持后端兼容 |
| P1 | Permission Gate 与工具审计日志 | 降低高危执行和 MCP 风险 | allow/ask/deny 策略矩阵、拒绝路径测试 | 先 audit-only，再逐步强制 |
| P1 | 统一 Runtime Trace ID | 串联 API、Loop、工具、MCP、Subagent 和 SSE | 单 Turn 可按 Trace 查询完整生命周期 | 兼容字段可选，逐步接入 |
| P1 | 事件日志容量、背压与恢复演练 | 保障刷新、网络波动与高频输出 | cursor 驱逐、epoch 变化、慢客户端压测 | 调整保留上限需监控内存 |
| P2 | Local Runtime 子进程化 | 提升崩溃隔离与桌面/服务端边界清晰度 | RPC 兼容测试、崩溃后重连/恢复测试 | 保留进程内 Adapter 作为回退 |
| P2 | Subagent 资源治理 | 控制 token、并发、磁盘与子进程泄漏 | 配额、超时、取消、dirty worktree 回归 | 先记录再限制，避免影响既有流程 |
| P3 | 远程后台 Worker | 支持异步长任务 | 临时凭据、容器回收、任务幂等、审计测试 | 与本地 Runtime 完全独立发布 |

---

## 8. 结论

1. **是的，DeerHux 的核心运行时主要由 TypeScript 构成**；Next.js/React 是界面与服务层，`DeerLoopEngine`、工具、Session、MCP、事件和协作编排同样是 TypeScript。Tauri 为桌面交付引入 Rust 壳层，因此不应称为纯 TS 项目。
2. DeerHux 已拥有较完整的 Agent 架构骨架：自研 Loop、部分端口化边界、工具注册/执行分离、以 JSONL 消息树为主的持久化、压缩、SSE 事件日志和 Worktree 协作 Agent；其中压缩与上下文重建仍耦合 pi `SessionManager`。
3. Claude Code 和 Cursor 可作为**能力与产品契约**的参照：前者重点是权限、Hooks、CLI/Subagent；后者重点是 IDE 上下文产品化与本地/远程执行域分离。但它们的核心内部实现未公开，不应反推为可复制的具体架构。
4. pi 是 DeerHux 最具工程价值的直接对照：DeerHux 应持续保持“复用 Provider/Session 基础语义，自己拥有 Loop/工具/事件/协作控制面”的边界。
5. 下一阶段最值得投入的是：**工具权限 Gate、端到端 Trace、上下文可解释性和运行恢复演练**；而非立即微服务化或过早迁移 Session 存储。
