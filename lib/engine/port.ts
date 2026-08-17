import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentRuntimeEventBase } from "../agent-runtime/types";
import type { AgentTurnInput, QueuedTurnInput } from "./turn-context";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export type AgentEngineModel = Model<Api>;
export type AgentAutoRecoveryMode = "off" | "conservative" | "aggressive";
export type AgentImageInput = { type: "image"; data: string; mimeType: string };

export interface AgentNavigationResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface AgentEngineStatePort {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly autoRecoveryMode: AgentAutoRecoveryMode;
  readonly systemPrompt: string;
  readonly thinkingLevel: string;
  readonly model: AgentEngineModel;
  getContextUsage(): ContextUsage | undefined;
}

export interface AgentEventPort {
  subscribe(listener: (event: AgentRuntimeEventBase) => void): () => void;
}

export interface AgentTurnPort {
  /** 兼容纯文本调用；生产路径应传 AgentTurnInput 以冻结该回合执行环境。 */
  prompt(input: string | AgentTurnInput, options?: { images?: AgentImageInput[] }): Promise<void>;
  steer(input: string | QueuedTurnInput, images?: AgentImageInput[]): Promise<void>;
  followUp(input: string | QueuedTurnInput, images?: AgentImageInput[]): Promise<void>;
  abort(): Promise<void>;
}

export interface AgentModelPort {
  setModel(model: AgentEngineModel): Promise<void>;
  setThinkingLevel(level: string): void;
}

export interface AgentPromptPort {
  setSystemPromptPersistent(prompt: string): void;
}

export interface AgentNavigationPort {
  navigate(targetId: string): Promise<AgentNavigationResult>;
}

export interface AgentCompactionPort {
  compact(
    customInstructions?: string,
    reason?: "manual" | "threshold" | "overflow",
    options?: { provider?: string; modelId?: string; model?: AgentEngineModel },
  ): Promise<unknown>;
  abortCompaction(): void;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  setAutoRecoveryMode(mode: AgentAutoRecoveryMode): void;
}

export interface AgentToolControlPort {
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  applyToolExecutionModes(): void;
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void;
}

export interface AgentLifecyclePort {
  installRetryHardening(): void;
  dispose(): void;
}

/** DeerHux 与 Agent 引擎之间完全显式的组合能力边界。 */
export interface AgentEnginePort
  extends AgentEngineStatePort,
    AgentEventPort,
    AgentTurnPort,
    AgentModelPort,
    AgentPromptPort,
    AgentNavigationPort,
    AgentCompactionPort,
    AgentToolControlPort,
    AgentLifecyclePort {}

/** Agent 引擎实例化边界。 */
export interface AgentEngineFactoryPort<TCreateOptions> {
  create(options: TCreateOptions): AgentEnginePort;
}
