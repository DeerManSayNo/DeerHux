# DeerHux 项目指令

## 开发规则

- 回答和思考过程使用中文。
- 查找函数、组件、类、接口和调用关系时，优先使用 `codegraph`，按任务选择 `search` / `callers` / `callees` / `impact` 操作。
- `code_search` 仅在当前会话实际提供时使用；否则用 Bash 中的 `rg` 检索普通文本、配置和非符号内容。
- 类型检查：`node_modules/.bin/tsc --noEmit`。
- 代码检查：`npm run lint`。
- 开发期间禁止运行 `next build`，它会污染 `.next/` 并影响 `npm run dev`；仅在 release 流程使用。

## 关键不变量

- 生产主链路使用自研 `DeerLoopEngine`；Pi 提供模型传输、`SessionManager`、上下文转换和部分压缩能力，不是生产 Agent Loop 宿主。
- Session 浏览由 `lib/session-reader.ts` 直接读取 JSONL，不应创建运行时 Wrapper。
- Fork 与 Session 内分支是两种机制；Fork 返回新 Session ID 前必须销毁原 `AgentSessionWrapper`。
- ToolCall 持久化字段与 UI 类型不同，统一通过 `lib/normalize.ts` 的 `normalizeToolCalls()` 转换。
- 不要破坏 SSE 对新旧压缩事件名的兼容处理。

详细架构、模块边界与演进说明见 `docs/agent-architecture-research.md`，仅在相关任务需要时读取。
