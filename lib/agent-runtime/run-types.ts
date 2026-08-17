export const AGENT_RUN_STATUS = [
  "accepted",
  "preparing",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunStatus = typeof AGENT_RUN_STATUS[number];

export const AGENT_RUN_TERMINAL_STATUS = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AgentRunTerminalStatus = typeof AGENT_RUN_TERMINAL_STATUS[number];

export function isTerminalAgentRunStatus(status: AgentRunStatus): status is AgentRunTerminalStatus {
  return (AGENT_RUN_TERMINAL_STATUS as readonly string[]).includes(status);
}

export interface AgentRunModelRef {
  provider: string;
  modelId: string;
}

/**
 * 持久化的单回合运行事实。
 *
 * Session JSONL 保存对话树；Run 文件保存易失执行期的控制面状态。两者刻意分层，
 * 避免高频运行态变更污染会话历史，也让进程重启后的中断收敛具有明确事实来源。
 */
export interface AgentRunRecord {
  version: 1;
  runId: string;
  sessionId: string;
  turnId: string;
  clientMessageId?: string;
  requestKind: "main" | "subagent" | "compaction";
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  ownerProcessId: number;
  ownerEpoch: string;
  lastEventType?: string;
  model?: AgentRunModelRef;
  errorCode?: string;
  error?: string;
}

export interface CreateAgentRunInput {
  runId: string;
  sessionId: string;
  turnId: string;
  clientMessageId?: string;
  requestKind?: AgentRunRecord["requestKind"];
  model?: AgentRunModelRef;
}

export interface AgentRunTransition {
  status: AgentRunStatus;
  lastEventType?: string;
  errorCode?: string;
  error?: string;
  model?: AgentRunModelRef;
}
