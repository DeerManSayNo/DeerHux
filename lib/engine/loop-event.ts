/**
 * LoopEvent 事件模型（discriminated union）。
 *
 * 对应设计文档 §4.2。这是 DeerLoopEngine 对外发射的事件总类型，与 pi 的
 * `AgentRuntimeEventBase` 结构兼容，DeerLoopEngine 可直接通过稳定事件 Port 透传。
 *
 * ★ M1 的 DeerLoopEngine 只 emit 标注「★M1」的事件：
 *   agent_start / message_start / message_update / message_end / agent_end
 *   （abort 时 message_end.message.stopReason === "aborted"）
 * 其余事件类型先定义好，为 M2-M5 铺路，M1 的 loop 不会 emit。
 *
 * 注意：文档 §4.2 里的 `agent_file_changed` / `agent_stale_warning` 是 wrapper 层
 * 合成的业务事件（rpc-manager.ts:686 / 757），loop 自身不发，因此不在这个 union 里。
 */
import type {
  AssistantMessage,
  Message,
} from "@earendil-works/pi-ai";
import type { LlmErrorCode, LlmSuggestedAction } from "../llm-gateway";
import { SESSION_PERSISTENCE_ERROR_CODE } from "../session/errors.ts";

/**
 * DeerLoopEngine 内部的消息类型别名。
 *
 * pi-agent-core@0.75.5 的 `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`，
 * 而 `CustomAgentMessages` 当前是空 interface，所以 AgentMessage === Message。
 * DeerHux 没有 pi-agent-core 的直接依赖，这里用 pi-ai 的 Message 作别名，
 * 与文档 §4.2 的 AgentMessage 概念对齐，并为 M2+（若引入 custom 消息）留扩展点。
 */
export type AgentMessage = Message;

/** 工具执行模式（M2 用，M1 仅定义类型）。 */
export type ToolExecutionMode = "sequential" | "parallel";

/** 队列模式（M5 用）。 */
export type QueueMode = "all" | "one-at-a-time";

/** 压缩结果（M6 用）。 */
export interface CompactionResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 工具执行结果（M2 用，M1 仅定义类型）。
 * 与 pi-agent-core 的 AgentToolResult 结构对齐，额外显式带 changedFiles
 * 以消灭 rpc-manager.ts 的 extractChangedFilePath 字段猜测。
 */
export interface AgentToolResult<T = unknown> {
  content: unknown[];
  details: T;
  /** 本次执行修改了哪些文件（绝对路径）。 */
  changedFiles?: string[];
  /** 终止 hint：本批所有工具都 terminate=true 时 loop 提前停。 */
  terminate?: boolean;
}

/**
 * Loop 事件总类型（discriminated union）。
 *
 * 运行时 wire 事件只保留 DeerHux 消费者需要的字段，避免透传 Provider 累计快照。
 */
export type LoopEvent =
  // ─── loop 级 ─────────────────────────────────────────────
  /** ★M1：一轮 prompt 开始。 */
  | { type: "agent_start" }
  /** ★M1：一轮 prompt 结束。正常时 error 不带；失败时 error 为错误消息。 */
  | {
      type: "agent_end";
      willRetry: boolean;
      /** 结构化终止原因；用户取消与模型/工具错误分离。 */
      stopReason?: "stop" | "aborted" | "error";
      error?: string;
      /** 标准化错误码（如 UPSTREAM_TTFT_TIMEOUT、SESSION_PERSIST_FAILED）。前端可据此触发恢复或展示确定错误。 */
      errorCode?: LlmErrorCode | typeof SESSION_PERSISTENCE_ERROR_CODE;
    }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: AgentMessage;
      toolResults: unknown[];
    }
  // ─── 消息流式 ────────────────────────────────────────────
  /** ★M1：assistant 消息流开始，message 是初始 partial。 */
  | { type: "message_start"; message: AgentMessage }
  /** ★M1：assistant 消息增量，message 是当前累计 partial。 */
  | {
      type: "message_update";
      message: AgentMessage;
    }
  /** ★M1：assistant 消息流结束，message 是最终 AssistantMessage（含 stopReason）。 */
  | { type: "message_end"; message: AgentMessage }
  // ─── 工具执行（M2）──────────────────────────────────────
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult<unknown>;
      isError: boolean;
      changedFiles?: string[];
    }
  // ─── 队列（M5）──────────────────────────────────────────
  | {
      type: "queue_update";
      steering: readonly string[];
      followUp: readonly string[];
    }
  // ─── 重试（M4）──────────────────────────────────────────
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
      errorCode?: LlmErrorCode;
      retryAfterMs?: number;
      userMessage?: string;
      suggestedAction?: LlmSuggestedAction;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  // ─── 压缩（M6）──────────────────────────────────────────
  | {
      type: "compaction_start";
      reason: "manual" | "threshold" | "overflow";
    }
  /** 压缩过程分步进度（准备 / 分批摘要 / 归档 / 落盘），供 UI 实时展示。 */
  | {
      type: "compaction_progress";
      phase: "preparing" | "summarizing" | "archiving" | "applying" | "done";
      message: string;
      batchIndex?: number;
      batchTotal?: number;
      tokensBefore?: number;
      tokensAfter?: number;
      model?: { provider: string; modelId: string };
    }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: CompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    };

/**
 * 工具函数：判断一个 LoopEvent 是否为 assistant 消息事件（用于测试与断言）。
 */
export function isAssistantMessageEvent(
  event: LoopEvent,
): event is
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AgentMessage;
    }
  | { type: "message_end"; message: AgentMessage } {
  return (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  );
}

/**
 * 工具函数：从 LoopEvent 提取可能携带的 AssistantMessage（测试用）。
 */
export function extractAssistantMessage(
  event: LoopEvent,
): AssistantMessage | null {
  if (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  ) {
    return event.message;
  }
  return null;
}
