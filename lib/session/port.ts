import type { AgentMessage } from "../engine/loop-event";

export interface SessionModelSelection {
  provider: string;
  modelId: string;
}

export interface SessionContextSnapshot {
  messages: AgentMessage[];
  model?: SessionModelSelection;
  thinkingLevel?: string;
  /** 导航到用户消息时返回原文本，调用方可放回编辑器。 */
  editorText?: string;
}

export interface SessionIdentityPort {
  readonly id: string;
  readonly file?: string;
  readonly cwd: string;
  readonly persisted: boolean;
  readonly leafId?: string;
}

export interface SessionCustomEntrySnapshot {
  id: string;
  data?: unknown;
}

export interface SessionForkResult {
  sessionId: string;
  sessionFile: string;
}

export interface SessionReadPort {
  getCustomEntries(customType: string): SessionCustomEntrySnapshot[];
}

export interface SessionWritePort {
  appendModelChange(provider: string, modelId: string): string | undefined;
  appendThinkingLevelChange(level: string): string | undefined;
  appendCustomEntry(customType: string, data?: unknown): string | undefined;
}

export interface SessionNavigationPort {
  navigate(targetId: string | null): SessionContextSnapshot;
  /** 从目标 Entry 之前创建独立 Session 文件。 */
  fork(entryId: string): SessionForkResult | undefined;
}

/** DeerHux 引擎与 Wrapper 依赖的最小 Session 能力，不暴露具体持久化实现。 */
export interface AgentSessionPort
  extends SessionIdentityPort, SessionReadPort, SessionWritePort, SessionNavigationPort {}
