import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "@/lib/deerhux-types";

/**
 * 旧 pi AgentSession 兼容边界。
 *
 * rpc-manager 仍有一批迁移中的调用依赖 sessionManager / settingsManager /
 * navigateTree 等 pi 风格字段。这里显式列出这些字段，避免 AgentEnginePort
 * 继续无条件继承完整 AgentSessionLike；后续每迁移掉一个调用，就从此 bridge
 * 删除一个键。
 */
export type LegacyAgentSessionLikeBridge = Pick<AgentSessionLike,
  | "sessionId"
  | "sessionFile"
  | "isStreaming"
  | "isCompacting"
  | "autoCompactionEnabled"
  | "autoRetryEnabled"
  | "model"
  | "modelRegistry"
  | "sessionManager"
  | "settingsManager"
  | "agent"
  | "subscribe"
  | "prompt"
  | "abort"
  | "setModel"
  | "navigateTree"
  | "appendCustomEntry"
  | "setThinkingLevel"
  | "compact"
  | "setAutoCompactionEnabled"
  | "setAutoRetryEnabled"
  | "steer"
  | "followUp"
  | "getAllTools"
  | "getActiveToolNames"
  | "setActiveToolsByName"
  | "abortCompaction"
  | "getContextUsage"
>;

export interface AgentRuntimePort {
  /** 设置持久 system prompt，保证后续轮次 prompt() 重置时不回退到内置 prompt。 */
  setSystemPromptPersistent(prompt: string): void;

  /** 应用工具执行模式（read/grep/find/ls/code_search/subagent 并行，bash/edit/write 串行）。 */
  applyToolExecutionModes(): void;

  /** 安装自动重试加固（最小退避、假性流错误判定、settle 静默窗口）。 */
  installRetryHardening(): void;

  /**
   * 同步前端「激进/保守/关闭」自动续跑模式。
   * 激进模式下 TTFT（首包）超时使用更短的 120s，与前端 watchdog 的 120s 对齐。
   */
  setAutoRecoveryMode(mode: "off" | "conservative" | "aggressive"): void;

  /** 当前自动续跑模式（供 get_state 暴露）。 */
  readonly autoRecoveryMode: "off" | "conservative" | "aggressive";

  /** 运行时热替换自定义工具（MCP 工具集）。 */
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void;

  /** 释放底层资源：中止运行 + 清空监听 + 清空队列。销毁路径必须调用。 */
  dispose(): void;
}

/**
 * AgentEnginePort —— DeerHux 与 Agent 引擎之间的稳定边界。
 * 由显式 runtime 能力 + 迁移中的 legacy bridge 组成，不再直接 extends 完整
 * AgentSessionLike。
 */
export interface AgentEnginePort extends AgentRuntimePort, LegacyAgentSessionLikeBridge {}
