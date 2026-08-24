import type { AgentMode } from "../agent-modes";
import type { FileReference, SkillReference } from "../types";
import type { AgentImageInput } from "./port";

/**
 * 一次主回合的不可变执行环境。
 *
 * Wrapper 在准入成功后冻结它；Engine 的所有 LLM round 和工具执行都只读此快照。
 * 后续 set_role / set_mode / set_tools / MCP reload 只改变下一次准入创建的快照。
 */
export interface TurnContextSnapshot {
  turnId: string;
  effectiveSystemPrompt: string;
  /** 仅与该条用户指令相关的文件引用 system 块。 */
  instructionContext?: string;
  /** 用户显式引用的主动 Skill 正文；作为 user-role 内容注入，不进入 system prompt。 */
  skillUserPrompt?: string;
  activeToolNames: readonly string[];
  roleId: string | null;
  agentMode: AgentMode;
  references: readonly FileReference[];
  skill?: SkillReference;
  createdAt: number;
}

export interface AgentTurnInput {
  text: string;
  images?: AgentImageInput[];
  context?: TurnContextSnapshot;
}

/** 入队的 steer / follow-up 同样保留准入时上下文，不能等执行时读取可变全局 Prompt。 */
export interface QueuedTurnInput extends AgentTurnInput {
  context?: TurnContextSnapshot;
}
