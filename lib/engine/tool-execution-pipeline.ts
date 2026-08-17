import type { ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "./extension-context.ts";
import type { AgentToolResult } from "./loop-event.ts";

/** 单次工具执行经过策略流水线时携带的不可变上下文。 */
export interface ToolExecutionContext {
  readonly call: ToolCall;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArguments: unknown;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly extensionContext: ExtensionContext;
}

/** 工具执行的标准化结果。 */
export interface ToolPipelineOutput {
  result: AgentToolResult;
  isError: boolean;
  changedFiles?: string[];
}

/** 前置策略和 Guard 的单调决策：后续策略不能推翻已有拒绝。 */
export type ToolPolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string; details?: unknown };

export type ToolPolicyHook = (
  context: ToolExecutionContext,
) => ToolPolicyDecision | void | Promise<ToolPolicyDecision | void>;

export type ToolPostExecuteHook = (
  context: ToolExecutionContext,
  output: Readonly<ToolPipelineOutput>,
) => ToolPipelineOutput | void | Promise<ToolPipelineOutput | void>;

export type ToolResultObserver = (
  context: ToolExecutionContext,
  output: Readonly<ToolPipelineOutput>,
) => void | Promise<void>;

/**
 * 可组合的工具策略流水线。
 *
 * - preExecute：审批、参数级策略等可扩展入口。
 * - guards：只允许继续收紧权限，任一拒绝即停止执行。
 * - postExecute：按注册顺序转换最终结果。
 * - onResult：只读观察最终事实；观察器失败不会改变工具结果。
 */
export interface ToolExecutionPipelineOptions {
  preExecute?: readonly ToolPolicyHook[];
  guards?: readonly ToolPolicyHook[];
  postExecute?: readonly ToolPostExecuteHook[];
  onResult?: readonly ToolResultObserver[];
}

export class ToolExecutionPipeline {
  private readonly preExecute: readonly ToolPolicyHook[];
  private readonly guards: readonly ToolPolicyHook[];
  private readonly postExecute: readonly ToolPostExecuteHook[];
  private readonly resultObservers: readonly ToolResultObserver[];

  constructor(options: ToolExecutionPipelineOptions = {}) {
    this.preExecute = [...(options.preExecute ?? [])];
    this.guards = [...(options.guards ?? [])];
    this.postExecute = [...(options.postExecute ?? [])];
    this.resultObservers = [...(options.onResult ?? [])];
  }

  async execute(
    context: ToolExecutionContext,
    dispatch: () => Promise<ToolPipelineOutput>,
  ): Promise<ToolPipelineOutput> {
    const denied = await this.firstDenial(context);
    let output = denied
      ? this.deniedOutput(denied.reason, denied.details)
      : await dispatch();

    // Guard 拒绝是单调决策，后置转换不能把拒绝伪造成成功。
    if (!denied) {
      for (const hook of this.postExecute) {
        try {
          const next = await hook(context, output);
          if (next) output = next;
        } catch (error) {
          output = this.deniedOutput(
            `Tool post-execute policy failed: ${this.errorMessage(error)}`,
            { phase: "postExecute" },
          );
          break;
        }
      }
    }

    const observerSnapshot = this.readonlySnapshot(output);
    for (const observer of this.resultObservers) {
      try {
        await observer(context, observerSnapshot);
      } catch {
        // 结果已经成为事实；可观测性插件失败不能篡改工具执行结果。
      }
    }

    return output;
  }

  private async firstDenial(
    context: ToolExecutionContext,
  ): Promise<Extract<ToolPolicyDecision, { action: "deny" }> | undefined> {
    for (const [phase, hooks] of [
      ["preExecute", this.preExecute],
      ["guard", this.guards],
    ] as const) {
      for (const hook of hooks) {
        try {
          const decision = await hook(context);
          if (decision?.action === "deny") return decision;
        } catch (error) {
          return {
            action: "deny",
            reason: `Tool ${phase} policy failed: ${this.errorMessage(error)}`,
            details: { phase },
          };
        }
      }
    }
    return undefined;
  }

  private deniedOutput(reason: string, details?: unknown): ToolPipelineOutput {
    return {
      result: {
        content: [{ type: "text", text: `Error: ${reason}` }],
        details: details ?? { error: reason },
      },
      isError: true,
    };
  }

  private readonlySnapshot(output: ToolPipelineOutput): Readonly<ToolPipelineOutput> {
    try {
      return structuredClone(output);
    } catch {
      // AgentToolResult 应为可序列化数据；若第三方工具返回特殊对象，至少隔离顶层和数组。
      return {
        ...output,
        result: {
          ...output.result,
          content: [...output.result.content],
        },
        changedFiles: output.changedFiles ? [...output.changedFiles] : undefined,
      };
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
