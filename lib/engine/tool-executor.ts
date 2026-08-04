/**
 * ToolExecutor —— 按执行模式（sequential / parallel）调度工具（M2 产出）。
 *
 * 设计文档 §4.3 + §7.1（工具并行错误隔离风险）。
 *
 * 核心契约：
 * 1. **源序分段执行**：按 LLM 产出的 toolCall 源序切分 segment：
 *    - 连续 parallel 工具组成一个 segment，用 Promise.all 并发执行
 *    - sequential 工具按原始位置各自形成单工具 segment，严格等待前后 segment
 *    segment 之间按源序等待，保证 read → edit 这类有副作用链路不会被反序。
 * 2. **错误隔离**：单个工具 throw 不能拖垮同批其他工具。失败的工具转成
 *    `isError=true, content=[{type:"text", text: errorMessage}]` 的结果，
 *    其余工具照常完成。用「每个工具包一层 try/catch 的 Promise」实现。
 * 3. **AbortSignal 传播**：所有工具共享同一个 signal。abort 时正在跑的工具
 *    通过 signal 收到中断（execute 内部自己监听 signal.aborted）。executor
 *    不主动 reject 正在跑的 promise（让工具自己决定如何响应 abort）。
 * 4. **事件发射**：每个工具执行前后调 onToolEvent，顺序严格成对：
 *    tool_execution_start → tool_execution_update? → tool_execution_end。
 * 5. **结果按源序**：executeBatch 返回的数组顺序 = 输入 toolCalls 顺序（源序），
 *    与执行/完成顺序无关（保证 ToolResultMessage 回填 transcript 时 LLM 看到的
 *    顺序与 assistant 发出的 toolCall 顺序一致）。
 */
import type { AssistantMessageEvent, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "./extension-context.ts";
import type { AgentToolResult, LoopEvent } from "./loop-event.ts";
import type { AnyToolDefinition, ToolRegistry } from "./tool-registry.ts";
import {
  MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
  SUBAGENT_TOOL_NAME,
  type SubagentConcurrencyRejectionDetails,
  makeSubagentToolCallLimitDetails,
} from "../parallel-agent/subagent-concurrency.ts";
import { spillLargeText } from "./context-archive.ts";

export interface ToolExecutorOptions {
  /** 用于长工具输出 spill；缺失时跳过落盘。 */
  sessionId?: string;
}

/**
 * 单个工具执行后的标准化输出。
 *
 * 无论工具成功还是 throw，executor 都产出这个结构，让上层统一处理。
 */
export interface ToolExecOutput {
  /** 工具的执行结果（成功时原样，失败时合成 {content:[错误文本]} ）。 */
  result: AgentToolResult;
  /** 是否为错误（工具 throw、或执行被 abort 中断）。 */
  isError: boolean;
  /** 本次执行修改的文件（绝对路径，从 result.changedFiles 透传）。 */
  changedFiles?: string[];
}

/** 单工具执行的事件发射回调（deer-loop 注入，转发为 LoopEvent）。 */
export type ToolEventEmitter = (event: LoopEvent) => void;

export interface ToolCallLimitState {
  toolName: string;
  maxCallsPerTurn: number;
  usedCalls: number;
}

export interface ToolExecuteBatchOptions {
  callLimits?: ToolCallLimitState[];
}

/**
 * 工具执行器。
 *
 * 一个 ToolRegistry 可对应一个 ToolExecutor（构造期绑定）。executor 自身无状态
 *（每次 executeBatch 的状态都在局部变量里），可被并发调用（虽然 DeerLoopEngine
 * 串行 prompt，不会真正并发调 executeBatch）。
 */
export class ToolExecutor {
  /** 绑定的工具注册表（查 executionMode / 取工具定义）。 */
  private readonly registry: ToolRegistry;
  private readonly sessionId?: string;

  constructor(registry: ToolRegistry, options?: ToolExecutorOptions) {
    this.registry = registry;
    this.sessionId = options?.sessionId;
  }

  /**
   * 批量执行工具调用。
   *
   * @param calls   本轮 LLM 产出的全部 ToolCall（源序）
   * @param signal  共享的 AbortSignal（abort 传播给所有在跑的工具）
   * @param ctx     ExtensionContext（execute 第 5 参）
   * @param onToolEvent  事件发射回调
   * @returns 与 calls 同序的 ToolExecOutput 数组（源序，非完成序）
   */
  async executeBatch(
    calls: readonly ToolCall[],
    signal: AbortSignal,
    ctx: ExtensionContext,
    onToolEvent: ToolEventEmitter,
    options?: ToolExecuteBatchOptions,
  ): Promise<ToolExecOutput[]> {
    if (calls.length === 0) return [];

    // 结果数组（按源序占位，最后返回）。
    const outputs: ToolExecOutput[] = new Array(calls.length);
    const rejectedCalls = this.collectRejectedLimitedToolCalls(calls, options);

    // ① 按源序切 segment：连续 parallel 并发；sequential 单独阻塞。
    let parallelSegment: number[] = [];
    const flushParallelSegment = async (): Promise<void> => {
      if (parallelSegment.length === 0) return;
      if (parallelSegment.length === 1) {
        const idx = parallelSegment[0];
        outputs[idx] = await this.executeLimitedAware(calls[idx], idx, signal, ctx, onToolEvent, rejectedCalls);
      } else {
        const segment = parallelSegment;
        const settled = await Promise.all(
          segment.map((idx) =>
            this.executeLimitedAware(calls[idx], idx, signal, ctx, onToolEvent, rejectedCalls),
          ),
        );
        for (let k = 0; k < segment.length; k++) {
          outputs[segment[k]] = settled[k];
        }
      }
      parallelSegment = [];
    };

    for (let i = 0; i < calls.length; i++) {
      const mode = this.registry.getExecutionMode(calls[i].name);
      if (mode === "sequential") {
        await flushParallelSegment();
        outputs[i] = await this.executeLimitedAware(calls[i], i, signal, ctx, onToolEvent, rejectedCalls);
      } else {
        parallelSegment.push(i);
      }
    }
    await flushParallelSegment();

    return outputs;
  }

  /**
   * 执行单个工具（带错误隔离 + onUpdate 转发 + 事件成对发射）。
   *
   * 事件顺序（严格成对，设计文档 §六.M2 验收 #8）：
   *   tool_execution_start → tool_execution_update? → tool_execution_end
   *
   * 错误隔离：工具 throw → 不向上抛，转成 isError=true 的 ToolExecOutput。
   * AbortSignal：透传给 execute，工具自己决定如何响应（execute 内部一般会在
   * signal.aborted 时抛 AbortError 或快速返回）。
   */
  private async executeOne(
    call: ToolCall,
    signal: AbortSignal,
    ctx: ExtensionContext,
    onToolEvent: ToolEventEmitter,
  ): Promise<ToolExecOutput> {
    const { id: toolCallId, name: toolName, arguments: rawArgs } = call;
    const tool = this.registry.get(toolName);

    // emit start（即使工具不存在也 emit，便于前端显示「调用了但没工具」）。
    onToolEvent({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args: rawArgs,
    });

    // 工具不存在：合成错误结果。
    if (!tool) {
      const errMsg = `Tool "${toolName}" is not registered`;
      const output = this.makeErrorOutput(errMsg);
      this.emitEnd(onToolEvent, toolCallId, toolName, output);
      return output;
    }

    // 准备参数：优先 prepareArguments，兜底处理「字符串 args」。
    const params = this.resolveArguments(tool, rawArgs);

    // onUpdate 回调：把工具的流式 partial 转成 tool_execution_update 事件。
    const onUpdate = (partialResult: AgentToolResult): void => {
      onToolEvent({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        args: rawArgs,
        partialResult,
      });
    };

    try {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      // pi 的 AgentToolResult 类型不保证有 changedFiles（那是 DeerHux 的扩展），
      // 但内置 bash/edit/write 工具会在运行时塞这个字段。用类型断言安全提取。
      const changedFiles = (result as { changedFiles?: string[] })?.changedFiles;
      const spilledResult = this.spillResultContent(result, toolCallId, toolName);
      const output: ToolExecOutput = {
        result: spilledResult,
        isError: false,
        changedFiles,
      };
      this.emitEnd(onToolEvent, toolCallId, toolName, output);
      return output;
    } catch (err) {
      // 错误隔离：不向上抛，转成 isError 结果。
      const isAborted = signal.aborted || this.isAbortError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      const output = this.makeErrorOutput(
        isAborted ? `Tool "${toolName}" aborted: ${errMsg}` : errMsg,
      );
      this.emitEnd(onToolEvent, toolCallId, toolName, output);
      return output;
    }
  }

  // -------------------------------------------------------------------------
  // 私有 helper
  // -------------------------------------------------------------------------

  private collectRejectedLimitedToolCalls(
    calls: readonly ToolCall[],
    options?: ToolExecuteBatchOptions,
  ): Map<number, { message: string; details?: SubagentConcurrencyRejectionDetails }> {
    const rejected = new Map<number, { message: string; details?: SubagentConcurrencyRejectionDetails }>();
    const limits = options?.callLimits;
    if (!limits?.length) return rejected;

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const limit = limits.find((item) => item.toolName === call.name);
      if (!limit) continue;
      if (limit.usedCalls >= limit.maxCallsPerTurn) {
        const details = call.name === SUBAGENT_TOOL_NAME
          ? makeSubagentToolCallLimitDetails(limit.usedCalls, 1)
          : undefined;
        rejected.set(index, {
          message: this.formatToolCallLimitError(call.name, limit, details),
          details,
        });
        continue;
      }
      limit.usedCalls += 1;
    }
    return rejected;
  }

  private async executeLimitedAware(
    call: ToolCall,
    index: number,
    signal: AbortSignal,
    ctx: ExtensionContext,
    onToolEvent: ToolEventEmitter,
    rejectedCalls: Map<number, { message: string; details?: SubagentConcurrencyRejectionDetails }>,
  ): Promise<ToolExecOutput> {
    const rejection = rejectedCalls.get(index);
    if (rejection) {
      return this.executeRejectedToolCall(call, rejection, onToolEvent);
    }
    return this.executeOne(call, signal, ctx, onToolEvent);
  }

  private async executeRejectedToolCall(
    call: ToolCall,
    rejection: { message: string; details?: SubagentConcurrencyRejectionDetails },
    onToolEvent: ToolEventEmitter,
  ): Promise<ToolExecOutput> {
    onToolEvent({
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    });
    const output = this.makeErrorOutput(rejection.message, rejection.details);
    this.emitEnd(onToolEvent, call.id, call.name, output);
    return output;
  }

  private formatToolCallLimitError(
    toolName: string,
    limit: ToolCallLimitState,
    details?: ReturnType<typeof makeSubagentToolCallLimitDetails>,
  ): string {
    const max = toolName === SUBAGENT_TOOL_NAME ? MAX_SUBAGENT_TOOL_CALLS_PER_TURN : limit.maxCallsPerTurn;
    const current = details?.current ?? limit.usedCalls;
    return [
      `Tool "${toolName}" exceeded this assistant tool-call batch limit: current ${current}, maximum ${max}.`,
      details?.suggestion ?? "Please split the task into a later turn or retry after current work finishes.",
    ].join(" ");
  }

  /** 解析工具参数：优先 prepareArguments，兜底字符串 JSON.parse。 */
  private resolveArguments(
    tool: AnyToolDefinition,
    raw: unknown,
  ): unknown {
    if (typeof tool.prepareArguments === "function") {
      try {
        return tool.prepareArguments(raw);
      } catch {
        // prepareArguments 抛错时退回原始值（兜底）。
      }
    }
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  /**
   * 长工具输出 spill：超过阈值时全文写入 context archive，LLM 只看到预览 + 路径。
   * 覆盖 bash / MCP / 任意自定义工具；已 spill 过的文本不会二次落盘。
   */
  private spillResultContent(
    result: AgentToolResult,
    toolCallId: string,
    toolName: string,
  ): AgentToolResult {
    if (!this.sessionId || !Array.isArray(result.content)) return result;
    let changed = false;
    const nextContent = result.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: string; text?: string };
      if (b.type !== "text" || typeof b.text !== "string") return block;
      try {
        const spilled = spillLargeText(b.text, {
          sessionId: this.sessionId!,
          toolCallId,
          toolName,
        });
        if (!spilled.spilled) return block;
        changed = true;
        return { ...b, text: spilled.preview };
      } catch (error) {
        console.warn(`ToolExecutor: spill failed for ${toolName}`, error);
        return block;
      }
    });
    if (!changed) return result;
    const details = result.details && typeof result.details === "object"
      ? { ...(result.details as Record<string, unknown>), spilledToArchive: true }
      : { spilledToArchive: true, originalDetails: result.details };
    return { ...result, content: nextContent, details };
  }

  /** 合成错误输出（content 是一段错误文本，给 LLM 看）。 */
  private makeErrorOutput(message: string, details?: unknown): ToolExecOutput {
    const result: AgentToolResult = {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: details ?? { error: message },
    };
    return { result, isError: true };
  }

  /** emit tool_execution_end（统一出口，保证字段齐全）。 */
  private emitEnd(
    onToolEvent: ToolEventEmitter,
    toolCallId: string,
    toolName: string,
    output: ToolExecOutput,
  ): void {
    onToolEvent({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: output.result,
      isError: output.isError,
      changedFiles: output.changedFiles,
    });
  }

  /** 判断错误是否为 abort 导致。 */
  private isAbortError(err: unknown): boolean {
    if (err instanceof Error) {
      return err.name === "AbortError" || /abort/i.test(err.message);
    }
    return false;
  }
}

// ===========================================================================
// 工具定义 → pi-ai Tool 转换（给 streamSimple 的 context.tools 用）
// ===========================================================================

/**
 * 把 ToolDefinition 转成 pi-ai 的 Tool（只取 LLM 需要的 name/description/parameters，
 * 不含 execute——execute 不传给 LLM）。
 *
 * pi-ai 的 `Tool<TParameters> = { name, description, parameters }`（见
 * pi-ai/dist/types.d.ts:231）。ToolDefinition 的同名字段直接透传。
 */
export function toPiAiTool(tool: AnyToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/**
 * 把一批 ToolDefinition 转成 pi-ai Tool 数组（context.tools 用）。
 * 类型 re-export，方便外部按 AnyToolDefinition 形状构造工具。
 */
export type { AnyToolDefinition, ToolDefinition, ExtensionContext };

/** re-export AssistantMessageEvent 仅供类型对齐引用。 */
export type { AssistantMessageEvent };
