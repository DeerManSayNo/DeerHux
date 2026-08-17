/**
 * DeerHux Agent 引擎抽象层。
 *
 * - {@link AgentEnginePort}：由运行状态、回合、模型、导航、压缩、工具和生命周期组成的显式能力接口。
 * - {@link DeerLoopEngine}：自研 loop 引擎。
 * - {@link detectPiPrivateFields} / {@link isPiSdkDrifted}：SDK 升级探测。
 */
export type {
  AgentEnginePort,
  AgentEngineFactoryPort,
  AgentEngineStatePort,
  AgentEventPort,
  AgentTurnPort,
  AgentModelPort,
  AgentPromptPort,
  AgentNavigationPort,
  AgentCompactionPort,
  AgentToolControlPort,
  AgentLifecyclePort,
  AgentNavigationResult,
  AgentEngineModel,
  AgentAutoRecoveryMode,
  ContextUsage,
  ToolInfo,
} from "./port";
export { DeerLoopEngineFactory, deerLoopEngineFactory } from "./deer-loop-engine-factory";
export {
  composeDeerLoopEngine,
  type DeerLoopCompositionOptions,
  type ComposedDeerLoopEngine,
  type DeerLoopCompositionDependencies,
} from "./deer-loop-composition";
export {
  detectPiPrivateFields,
  isPiSdkDrifted,
  PI_SDK_DRIFT_ENV,
  REQUIRED_PRIVATE_FIELDS,
  type SdkGuardResult,
} from "./sdk-guard";
export { DeerLoopEngine } from "./deer-loop";
export type { DeerLoopOptions } from "./deer-loop";
export type {
  LoopEvent,
  AgentMessage,
  ToolExecutionMode,
  QueueMode,
  CompactionResult,
  AgentToolResult,
} from "./loop-event";
export type { StreamFn } from "./deer-loop";
export {
  ToolExecutionPipeline,
  type ToolExecutionContext,
  type ToolExecutionPipelineOptions,
  type ToolPipelineOutput,
  type ToolPolicyDecision,
  type ToolPolicyHook,
  type ToolPostExecuteHook,
  type ToolResultObserver,
} from "./tool-execution-pipeline";
