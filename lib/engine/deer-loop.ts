/**
 * DeerLoopEngine —— DeerHux 自研 Agent Loop 引擎。
 *
 * 负责 prompt 流式消费、工具调用循环、重试、steering/followUp 队列、压缩状态
 * 与 session jsonl 持久化编排。LLM 传输仍复用 pi-ai 的 streamSimple
 *（14+ provider 适配不动），DeerLoopEngine 只负责 loop 编排与事件契约。
 * streamFn 可注入，便于单测 mock。
 *
 * ★ 事件顺序契约（文档 §7.1）：严格
 *   agent_start → message_start → message_update*N → message_end → agent_end
 * abort 时：message_end{message.stopReason:"aborted"} → agent_end{willRetry:false}
 * 错误时：agent_end{error: message}
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  findCutPoint,
  generateSummary,
} from "@earendil-works/pi-coding-agent";
import type { AgentEnginePort } from "./port.ts";
import type { AgentMessage, CompactionResult, LoopEvent, QueueMode } from "./loop-event.ts";
import { ToolRegistry, type AnyToolDefinition } from "./tool-registry.ts";
import { ToolExecutor, toPiAiTool, type ToolExecOutput } from "./tool-executor.ts";
import {
  createMinimalExtensionContext,
} from "./extension-context.ts";
import {
  DefaultRetryPolicy,
  getAssistantContentLength,
  type RetryPolicy,
} from "./retry-policy.ts";
import {
  acquireLlmPermit,
  classifyLlmError,
  getLlmUserMessage,
  hashLlmApiKey,
  isLlmGatewayEnabled,
  type LlmPermit,
  type LlmRequestKind,
  type LlmRequestMeta,
  type NormalizedLlmError,
} from "../llm-gateway";
import {
  recordLlmError,
  recordLlmRequest,
  recordLlmSuccess,
} from "../llm-gateway/metrics";
import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
} from "../llm-gateway/upstream-health";
import {
  MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
  SUBAGENT_TOOL_NAME,
} from "../parallel-agent/subagent-concurrency";

/**
 * 不限定具体 Api 的 Model 类型别名。
 * pi-ai 的 Model<TApi extends Api> 要求一个 Api 类型实参；自研 loop 不关心具体 provider 的
 * Api 形状（交给 streamSimple 内部处理），这里用 Model<Api> 作为“任意 model”的类型。
 */
export type AnyModel = Model<Api>;

// ===========================================================================
// 类型定义
// ===========================================================================

/**
 * Stream 函数签名。默认用 pi-ai 的 streamSimple。
 * 抽象出来便于测试注入 mock（避免真实 LLM 调用）。
 */
export type StreamFn = (
  model: AnyModel,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface DeerLoopModelRegistry {
  find(provider: string, modelId: string): AnyModel | undefined;
}

/**
 * DeerLoopEngine 构造选项（文档 §4.5 的子集，M1 只保留流式必需字段）。
 */
export interface DeerLoopOptions {
  /** pi-ai 的 Model 实例。 */
  model: AnyModel;
  /** 初始系统提示词。 */
  systemPrompt?: string;
  /** 工作目录（sessionManager 代理的 getCwd 返回它）。 */
  cwd: string;
  /** 会话 id（透传给 provider 做 cache-aware；也用作 sessionId 属性）。 */
  sessionId?: string;
  /** 思考级别（pi-ai 的 ThinkingLevel，不含 "off"；off 时传 undefined）。 */
  thinkingLevel?: ThinkingLevel;
  /** 从持久化 session 恢复的模型上下文。新会话不传。 */
  initialMessages?: readonly AgentMessage[];
  /** ★ 可注入的 stream 函数，默认 streamSimple。测试用。 */
  streamFn?: StreamFn;
  /** API key 解析器（OAuth 短 token 用）。每次 LLM 调用前调。 */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** 真实 SessionManager。生产路径注入后，DeerLoopEngine 会把消息写入 jsonl。 */
  sessionManager?: SessionManager;
  /** 真实 ModelRegistry。用于 set_model/recover 和工具 ctx.modelRegistry，避免空代理。 */
  modelRegistry?: DeerLoopModelRegistry;

  // ─── M2：工具注册 ───────────────────────────────────────
  /** ★ 初始工具集（defineTool / createCodeGraphTools 等产物，直接喂给 registry）。 */
  tools?: AnyToolDefinition[];
  /** ★ 初始激活工具白名单（仅这些工具暴露给 LLM）。未传则激活全部已注册工具。 */
  activeToolNames?: string[];
  /** ★ 单工具 executionMode 覆盖表（消灭 H6/H7/H8）。 */
  toolExecutionModes?: Record<string, "sequential" | "parallel">;
  /** ★ 工具调用循环最大轮数（防 LLM 死循环；默认 20）。 */
  maxToolRounds?: number;
  /** ★ M4：注入自定义重试策略（测试用极小 delay/settle；不传则 installRetryHardening 时建 DefaultRetryPolicy）。 */
  retryPolicy?: RetryPolicy;
  /** LLM Gateway 调度用请求类型。主会话默认 main，subagent worker 传 subagent。 */
  requestKind?: LlmRequestKind;

  // ─── M5：steering / followUp 队列 ───────────────────────
  /** ★ M5：steering 队列模式（默认 "all"，turn 结束后一次注入全部插嘴消息）。
   *
   *  - "all"：drain 时把队列里全部消息作为 user message 注入 transcript
   *  - "one-at-a-time"：只注入最老一条，其余留队列等下一轮 drain 点 */
  steeringMode?: QueueMode;
  /** ★ M5：followUp 队列模式（默认 "all"）。语义同 steeringMode。 */
  followUpMode?: QueueMode;
  /** ★ M5：单个 prompt 内最多触发的 followUp 新 turn 数（防死循环，默认 10）。 */
  maxFollowUps?: number;
}

/** 标记当前处于未实现的里程碑路径抛出的错误。 */
function notImplemented(method: string, milestone: string): Error {
  return new Error(
    `DeerLoopEngine.${method}: not implemented (see ${milestone})`,
  );
}

/** ★ M2：工具调用循环最大轮数（防 LLM 无限调工具死循环）。
 *  与 subagent 默认预算（SUBAGENT_MAX_TOOL_ROUNDS=100）保持一致。 */
const DEFAULT_MAX_TOOL_ROUNDS = 100;

/** ★ M6 helper：从 AssistantMessage.content 提取所有 text block 拼接成字符串。 */
function extractText(message: { content?: unknown }): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * 保守估算文本 token：CJK 字符通常接近一字一 token，其余文本按约 4 字符一 token。
 * 相比统一 chars/4，不会在中文说明、中文日志和混合工具输出上严重低估。
 */
function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** ★ M6 helper：粗略估算 token 数。
 *
 * 非精确计数（真正的 tokenizer 依赖 provider），仅用于提前压缩和批次大小控制；
 * 估算必须宁高勿低，避免压缩请求本身超过上下文窗口。 */
function estimateTokens(messages: AgentMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    const summaryMessage = msg as { role?: string; summary?: unknown };
    if (
      (summaryMessage.role === "compactionSummary" || summaryMessage.role === "branchSummary")
      && typeof summaryMessage.summary === "string"
    ) {
      tokens += estimateTextTokens(summaryMessage.summary);
      continue;
    }
    if (typeof msg.content === "string") {
      tokens += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === "object") {
          const b = block as {
            text?: string;
            thinking?: string;
            type?: string;
            name?: string;
            arguments?: unknown;
          };
          if (typeof b.text === "string") tokens += estimateTextTokens(b.text);
          if (typeof b.thinking === "string") tokens += estimateTextTokens(b.thinking);
          if (b.type === "toolCall") {
            tokens += estimateTextTokens(b.name ?? "") + estimateTextTokens(JSON.stringify(b.arguments ?? {}));
          }
          // 图片不会作为文本出现在 jsonl，但会占用可观的视觉上下文预算。
          if (b.type === "image") tokens += 1_200;
        }
      }
    }
  }
  return tokens;
}

/** ★ M5：单个 prompt 内最多触发的 followUp 新 turn 数（防无限 followUp 死循环）。
 *
 *  followUp drain 在 turn 结束点触发新 turn（continue），若用户的 followUp 消息
 *  持续 push 且 LLM 始终不再调工具，会无限循环。这里设上限兜底。 */
const DEFAULT_MAX_FOLLOW_UPS = 10;

/** ★ M5 验收修复：队列容量上限（防内存 DoS）。
 *
 *  DeerHux 是本地桌面应用，正常使用不会超 10 条。 50 是宽松上限。
 *  超限时 enqueueBounded 丢弃最旧条目。 */
const MAX_QUEUE_LENGTH = 50;

/** ★ M5 验收修复：queue_update 事件中每条文本的最大暴露长度（防大文本进事件流）。
 *
 *  超过截断并加 ... 后缀。Drain 时仍用完整 text（只限制事件广播）。 */
const QUEUE_UPDATE_TEXT_TRUNCATE = 200;

/** ★ M5：队列条目类型（文本 + 可选图片，对齐 Port steer/followUp 的签名）。 */
interface QueueEntry {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
}

/** consumeStream 的返回值（一轮 LLM 调用的状态快照）。 */
interface ConsumedStream {
  /** 本轮的最终 AssistantMessage（done/error 的 message 或 lastPartial 或合成）。 */
  endMessage: AssistantMessage;
  /** 是否已 emit 过 message_start（用于补发逻辑）。 */
  started: boolean;
  /** 是否被 abort。 */
  aborted: boolean;
  /** 错误消息（非 abort）。 */
  errorMessage: string | undefined;
  /** 原始错误对象；用于统一 LLM 错误分类，避免丢失 status/headers。 */
  error: unknown;
  /** 标准化错误，存在时供 retry/UI 复用。 */
  normalizedError?: NormalizedLlmError;
  /** ★ M4 修复：consumeStreamWithRetry 是否已发射最终的 message_start+message_end。
   *
   *  当发生重试时，最终轮的 message_end 必须在 auto_retry_end 【之前】发射（事件顺序契约）。
   *  consumeStreamWithRetry 负责发，prompt 主循环看到此标记就跳过，避免重复。 */
  messageEndEmitted?: boolean;
  /** stream 的 stopReason（done.reason 或 error.reason）。 */
  stopReason: string | undefined;
}

/**
 * ★ M2：内置工具默认执行模式表（与 PiEngineAdapter.TOOL_EXECUTION_MODES 对齐）。
 *
 * read/grep/find/ls/code_search/subagent = parallel（无副作用，可并发）。
 * bash/edit/write = sequential（有副作用，必须串行防竞态）。
 *
 * 这是应用层预设，rpc-manager 调 applyToolExecutionModes() 时写入 registry 覆盖表。
 * 自定义工具（codegraph_* / mcp__*）自带 executionMode 字段，不在这里枚举。
 */
const DEFAULT_TOOL_EXECUTION_MODES: Record<string, "parallel" | "sequential"> = {
  read: "parallel",
  grep: "parallel",
  find: "parallel",
  ls: "parallel",
  code_search: "parallel",
  subagent: "parallel",
  bash: "sequential",
  edit: "sequential",
  write: "sequential",
};

// ===========================================================================
// ★ R8：Promise-based Mutex（非排队、快速拒绝语义）
// ===========================================================================

/**
 * Promise-based Mutex（非排队、快速拒绝语义）。
 *
 * 用于 prompt() 并发保护：若当前已有 prompt 在执行，第二个请求立即
 * 抛出 AGENT_BUSY 错误而非排队等待。参考 Prisma 的 Mutex 类。
 */
class Mutex {
  private _locked = false;

  /** 尝试获取锁。成功返回 release 函数；已锁返回 null（快速拒绝）。 */
  tryAcquire(): (() => void) | null {
    if (this._locked) return null;
    this._locked = true;
    return () => {
      this._locked = false;
    };
  }
}

// ===========================================================================
// ★ R9：事件守卫（RAII guard）——保证 agent_start / agent_end 严格配对
// ===========================================================================

/**
 * 事件守卫（RAII guard）：保证 agent_start / agent_end 在 prompt 生命周期
 * 内严格配对发射。即使内部分支遗漏事件，finally 也会补发。
 *
 * 参考 Jupyter Kernel 的消息协议：scope guard 在入口创建，析构时自动补发
 * 缺失事件，不依赖手动 emit 的分支覆盖率。
 */
class EventGuard {
  private _agentStarted = false;
  private _agentEnded = false;
  private readonly _emit: (event: LoopEvent) => void;

  constructor(emit: (event: LoopEvent) => void) {
    this._emit = emit;
  }

  /** 发射 agent_start（幂等：已发射则跳过）。 */
  ensureAgentStart(): void {
    if (!this._agentStarted) {
      this._agentStarted = true;
      this._emit({ type: "agent_start" });
    }
  }

  /** 发射 agent_end（幂等：已发射则跳过）。
   *  可传额外字段（error / errorCode / willRetry / messages）。 */
  ensureAgentEnd(extra?: Record<string, unknown>): void {
    if (!this._agentEnded) {
      this._agentEnded = true;
      this._emit({ type: "agent_end", ...extra } as LoopEvent);
    }
  }

  /** 查询 agent_end 是否已发射（finally 中判断是否需要补发）。 */
  get agentEnded(): boolean {
    return this._agentEnded;
  }
}

// ===========================================================================
// DeerLoopEngine
// ===========================================================================

/**
 * 自研 Agent Loop 引擎（M1 最小骨架）。
 *
 * 一个实例 = 一个会话上下文（transcript + systemPrompt + model）。
 * 不持有 pi 的 AgentSession / SessionManager / SettingsManager——这些在 M1
 * 灰度路径上要么不需要（get_state/prompt），要么由 wrapper 层用最小代理满足类型。
 */
export class DeerLoopEngine implements AgentEnginePort {
  /** 事件订阅者集合。emit 时遍历调用。 */
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  /** 当前 in-flight stream 的 AbortController。null 表示空闲。 */
  private abortController: AbortController | null = null;

  /** ★ R8：prompt 并发保护 Mutex（快速拒绝语义，不排队）。 */
  private readonly _promptMutex = new Mutex();

  /** loop 级运行标记：agent_start → agent_end 之间为 true。 */
  private _isRunning = false;

  /** LLM 流式输出标记：仅在 stream for-await 期间为 true。 */
  private _isStreaming = false;

  /** 会话 transcript（pi-ai Message[]，= AgentMessage[]）。 */
  private readonly _messages: AgentMessage[];

  /** 持久系统提示词（loop 自持，天然免疫 H1——见 {@link DeerLoopEngine#setSystemPromptPersistent}）。
   *
   *  M3 已验证（scripts/test-system-prompt-persistence.mjs）：每轮 consumeStream
   *  都读这里的值构建 context，且不被任何外部逻辑重置（pi 的 _baseSystemPrompt
   *  私有字段覆盖 bug 在自研 loop 路径上不存在）。 */
  private _baseSystemPrompt: string;

  /** 当前思考级别（pi-ai ThinkingLevel | undefined）。 */
  private _thinkingLevel: ThinkingLevel | undefined;

  /** 当前模型。 */
  private _model: AnyModel;

  /** stream 函数（默认 streamSimple，可注入）。 */
  private readonly _streamFn: StreamFn;

  /** 会话 id。 */
  private readonly _sessionId: string;

  /** 工作目录。 */
  private readonly _cwd: string;

  /** API key 解析器。 */
  private readonly _getApiKey?: (provider: string) => Promise<string | undefined>;

  /** 真实 SessionManager（生产路径注入）；未注入时回退最小代理，方便单测。 */
  private readonly _sessionManager?: SessionManager;

  /** 真实 ModelRegistry（生产路径注入）；未注入时回退只读空代理，方便单测。 */
  private readonly _modelRegistry?: DeerLoopModelRegistry;

  /** LLM Gateway 调度用请求类型，影响 limiter 优先级。 */
  private readonly _requestKind: LlmRequestKind;

  /** ★ M2：工具注册表（单一数据源，消灭 pi 三份副本）。 */
  private readonly registry: ToolRegistry;

  /** ★ M2：工具执行器（并行/串行调度 + 错误隔离）。 */
  private readonly toolExecutor: ToolExecutor;

  /** ★ M2：工具调用循环最大轮数（防 LLM 死循环）。 */
  private readonly _maxToolRounds: number;

  /** ★ M4：当前重试策略（null = 未安装，不重试）。
   *
   *  installRetryHardening() 安装 DefaultRetryPolicy（封装 H2/H3/H4）。
   *  自研 loop 不再依赖 pi 的 `_isRetryableError` / `_prepareRetry` / `getRetrySettings`
   *  三处私有 hack——重试判定与退避全部在 RetryPolicy 里，由 consumeStreamWithRetry 驱动。 */
  private _retryPolicy: RetryPolicy | null = null;

  /** ★ M4：是否启用自动重试。installRetryHardening 后默认 true；setAutoRetryEnabled 可运行时关闭。 */
  private _autoRetryEnabled = false;

  /** ★ M6：是否正在进行 compact（互斥标记）。 */
  private _isCompacting = false;
  /** ★ M6：compact 的独立 AbortController（与 prompt 的 abortController 分离）。 */
  private compactionAbortController: AbortController | null = null;
  /** ★ M6：是否启用自动压缩。默认开启，在每个新回合前检查安全阈值。 */
  private _autoCompactionEnabled = true;

  // ─── ★ M5：steering / followUp 队列 ─────────────────────
  /** steering 队列：用户在 turn 进行中「插嘴补充」（steer 命令）。
   *
   *  drain 时机：每轮 consumeStream 【之前】（见 prompt 主循环顶部），
   *  保证同一轮 LLM 就能看到插嘴内容（踩坑预警 #1）。 */
  private readonly steeringQueue: QueueEntry[] = [];
  /** followUp 队列：用户在 turn 结束后「继续追问」（follow_up 命令）。
   *
   *  drain 时机：agent 本要停止时（无工具调用、stopReason=stop），
   *  若队列非空，注入触发新 turn（continue，不 break）。 */
  private readonly followUpQueue: QueueEntry[] = [];
  /** steering 队列模式（默认 "all"）。setSteeringMode 可运行时切换。 */
  private _steeringMode: QueueMode = "all";
  /** followUp 队列模式（默认 "all"）。setFollowUpMode 可运行时切换。 */
  private _followUpMode: QueueMode = "all";
  /** 单个 prompt 内最多触发的 followUp 新 turn 数（防死循环）。 */
  private readonly _maxFollowUps: number;

  /**
   * agent.state 的最小代理对象。
   *
   * Port 接口要求 `agent: { state?: { systemPrompt?; thinkingLevel? } }`。
   * wrapper 构造时会读 agent.state.systemPrompt，applyRolePrompt 会写。
   * get_state 命令也读这两个字段。这里维护一个真实的最小 state 对象。
   */
  private readonly _agentState: {
    systemPrompt: string;
    thinkingLevel: string;
  };

  constructor(options: DeerLoopOptions) {
    if (!options?.model) {
      throw new Error("DeerLoopEngine: options.model is required");
    }
    if (!options?.cwd) {
      throw new Error("DeerLoopEngine: options.cwd is required");
    }
    this._model = options.model;
    this._cwd = options.cwd;
    this._sessionId = options.sessionId ?? `deer-loop-${Date.now()}`;
    this._baseSystemPrompt = options.systemPrompt ?? "";
    this._thinkingLevel = options.thinkingLevel;
    this._messages = options.initialMessages ? [...options.initialMessages] : [];
    this._streamFn = options.streamFn ?? defaultStreamFn;
    this._getApiKey = options.getApiKey;
    this._sessionManager = options.sessionManager;
    this._modelRegistry = options.modelRegistry;
    this._requestKind = options.requestKind ?? "main";
    this._agentState = {
      systemPrompt: this._baseSystemPrompt,
      thinkingLevel: this._thinkingLevel ?? "off",
    };

    // M2：初始化工具注册表与执行器。
    this.registry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(this.registry);
    this._maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    // M4：可选注入自定义重试策略（测试用极小 delay/settle）。未传时为 null，
    // 等 installRetryHardening() 安装 DefaultRetryPolicy（生产路径）。
    if (options.retryPolicy) {
      this._retryPolicy = options.retryPolicy;
      this._autoRetryEnabled = true;
    }
    // M5：队列模式与 followUp 上限（构造期注入，运行时仍可 setSteeringMode/setFollowUpMode 改）。
    this._steeringMode = options.steeringMode ?? "all";
    this._followUpMode = options.followUpMode ?? "all";
    this._maxFollowUps = options.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS;
    if (options.tools && options.tools.length > 0) {
      this.registry.registerAll(options.tools);
      // 未传 activeToolNames 时激活全部已注册工具（方便灰度：传工具即启用）。
      if (options.activeToolNames !== undefined) {
        this.registry.setActive(options.activeToolNames);
      } else {
        this.registry.setActive(options.tools.map((t) => t.name));
      }
    }
    if (options.toolExecutionModes) {
      this.registry.setExecutionModes(options.toolExecutionModes);
    }
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：prompt 流式
  // -------------------------------------------------------------------------

  /**
   * 发起一轮 prompt。消费 pi-ai 的 AssistantMessageEventStream，转成 LoopEvent emit。
   *
   * ★ M2 改造为工具调用循环（设计文档 §4「核心实现要点」#3）：
   *   while (true) {
   *     consume stream → 得到 finalMessage + stopReason
   *     abort/error → emit message_end + agent_end, break
   *     push assistant message to transcript
   *     if (stopReason !== toolUse || 无 toolCall) → emit message_end, break
   *     emit message_end（本轮 assistant 结束）
   *     executeBatch(toolCalls) → emit tool_execution_*
   *     abort 期間 → break
   *     push ToolResultMessage × N to transcript
   *     continue（下一轮 LLM 看到工具结果）
   *   }
   *
   * 事件顺序（单轮无工具）：
   *   agent_start → message_start → message_update*N → message_end → agent_end
   * 事件顺序（一轮有工具，工具后不再调）：
   *   agent_start → message_start → message_update*N → message_end
   *     → tool_execution_start → tool_execution_update? → tool_execution_end(×N)
   *     → message_start(第二轮) → ... → message_end → agent_end
   *
   * abort 行为：stream 或工具执行期间 abort，发 message_end{stopReason:"aborted"}
   * + agent_end{willRetry:false}。
   * 错误行为：stream 抛非 abort 错误，发 message_end{stopReason:"error"} +
   * agent_end{error}。工具执行错误被错误隔离（不中断 loop，结果回填给 LLM）。
   * 防死循环：连续 maxToolRounds 轮仍要工具 → 强制 break + agent_end{error}。
   */
  async prompt(
    text: string,
    options?: {
      images?: Array<{ type: "image"; data: string; mimeType: string }>;
    },
  ): Promise<void> {
    // ★ R8：用 Mutex 替代非原子 boolean 检查（tryAcquire 快速拒绝，不排队）
    const release = this._promptMutex.tryAcquire();
    if (!release) {
      throw new Error(
        "AGENT_BUSY: a prompt is already running (不支持并发 prompt)",
      );
    }

    // ★ R9：事件守卫——保证 agent_start / agent_end 严格配对，
    //   任何分支遗漏事件都会在 finally 中补发。
    const guard = new EventGuard((e) => this.emit(e));

    let agentError: string | undefined; // 记录 agent_end 携带的错误消息
    let agentErrorCode: NormalizedLlmError["code"] | undefined; // 记录标准化错误码

    try {
      // ★ R9：进入 prompt 立即发射 agent_start（幂等；内层若重复 emit 也安全）
      guard.ensureAgentStart();

      // 在写入下一条用户消息前先压缩旧历史，避免请求抵达模型时已经超过上下文窗口。
      await this.compactBeforePromptIfNeeded();

      // 1. 把用户输入包成 UserMessage，追加到 transcript。
      const userContent = this.buildUserContent(text, options?.images);
      const userMessage: UserMessage = {
        role: "user",
        content: userContent,
        timestamp: Date.now(),
      };
      this._messages.push(userMessage);
      this.persistMessage(userMessage);

      // 2. 进入 running 态（_isRunning 保留为观察字段，并发保护由 Mutex 负责）。
      this._isRunning = true;
      this.abortController = new AbortController();

      try {
        let toolRounds = 0;
        // ★ M5：本 prompt 内已触发的 followUp 新 turn 数（防无限 followUp 死循环）。
        //   followUp drain 时 ++；达到 _maxFollowUps 后不再触发，正常结束。
        let followUpTurnsConsumed = 0;
        // ★ 工具调用循环：每轮 consume stream → 判断 toolUse → 执行工具 → 回填 → 继续。
        while (true) {
          // ★ M5：drain steering 队列（turn 进行中的插嘴）。
          //   时机：consumeStream 【之前】注入，保证同一轮 LLM 就能看到插嘴内容
          //   （踩坑预警 #1：若在 consumeStream 之后注入，要多等一轮）。
          //   行为：
          //     - "all"：全部插嘴消息每条一条 user message 入 transcript
          //     - "one-at-a-time"：只注入最老一条，其余留队列等下一轮
          //   drain 后 emit queue_update（队列变化）。abort 不会清空队列（见 abort 注释）。
          if (this.steeringQueue.length > 0) {
            const toInject =
              this._steeringMode === "one-at-a-time"
                ? [this.steeringQueue.shift()!]
                : this.steeringQueue.splice(0);
            for (const entry of toInject) {
              const steerMsg: UserMessage = {
                role: "user",
                content: this.buildUserContent(entry.text, entry.images),
                timestamp: Date.now(),
              };
              this._messages.push(steerMsg);
              this.persistMessage(steerMsg);
            }
            this.emitQueueUpdate();
          }

          // ★ M3 持久性关键：Context 在 while 循环【内】每轮重新构造，
          //   systemPrompt 直接读 this._baseSystemPrompt（不缓存到循环外）。
          //   因此 setSystemPromptPersistent 的修改从下一轮 consumeStream 立即生效，
          //   且连发 N 个 prompt 值恒定不变（免疫 H1）。
          //   见 scripts/test-system-prompt-persistence.mjs 用例 1/2。
          const activeTools = this.registry.getActive();
          const context: Context = {
            systemPrompt: this._baseSystemPrompt || undefined,
            messages: convertToLlm(this._messages as never) as Message[],
            ...(activeTools.length > 0
              ? { tools: activeTools.map(toPiAiTool) }
              : {}),
          };

          // ★ M4：消费 stream（带重试）。失败时 consumeStreamWithRetry 内部判定是否重试，
          //   并发射 auto_retry_start/end + agent_end{willRetry:true} 事件。
          //   返回的 consumed 是【最终结果】（成功 / abort / 不可重试错误 / 全部重试失败）。
          const consumed = await this.consumeStreamWithRetry(context);

          // abort / error：收尾后跳出循环。
          if (consumed.aborted || consumed.errorMessage) {
            // ★ M4 修复：若 consumeStreamWithRetry 已发过 message_end（重试场景的最终轮），
            //   这里不重复发；否则补发。
            if (!consumed.messageEndEmitted) {
              this.emitMessageStartIfNeeded(consumed);
              this.emit({ type: "message_end", message: consumed.endMessage });
            }
            // ★ M4 修复（问题 #3）：abort 时不 push endMessage 到 transcript（aborted 不算有效对话）。
            //   error（不可重试/全部重试失败）仍 push（保留错误上下文，下次 prompt LLM 能看到）。
            if (!consumed.aborted) {
              this._messages.push(consumed.endMessage);
              this.persistMessage(consumed.endMessage);
            }
            if (consumed.errorMessage) agentError = consumed.errorMessage;
            if (consumed.normalizedError) agentErrorCode = consumed.normalizedError.code;
            break;
          }

          // 把本轮 assistant 最终消息追加到 transcript。
          const assistantMessage = consumed.endMessage;
          this._messages.push(assistantMessage);
          this.persistMessage(assistantMessage);

          // ★ 提取本轮的 ToolCall（源序）。
          const toolCalls = assistantMessage.content.filter(
            (c): c is ToolCall => c.type === "toolCall",
          );

          // ★ 保守判断进工具循环（踩坑预警 #1）：
          //   stopReason === "toolUse" 或 content 含 toolCall 即进。
          const wantsTools =
            consumed.stopReason === "toolUse" || toolCalls.length > 0;

          if (!wantsTools || toolCalls.length === 0) {
            // LLM 不再要工具 → 正常结束（emit message_end 后跳出循环）。
            if (!consumed.messageEndEmitted) {
              this.emitMessageStartIfNeeded(consumed);
              this.emit({ type: "message_end", message: assistantMessage });
            }

            // ★ M5：drain followUp 队列（turn 结束后的追问）。
            //   时机：agent 本要停止时（无工具调用、stopReason=stop）。
            //   行为：
            //     - 队列非空且未达 maxFollowUps 上限 → 注入触发新 turn（continue 不 break）
            //     - "all" 模式：全部 followUp 消息每条一条 user message
            //     - "one-at-a-time" 模式：只注入最老一条
            //   followUp 触发的新 turn 重置 toolRounds（新 turn 独立 maxToolRounds 预算），
            //   避免原 turn 的工具轮数被 followUp 消耗。防死循环靠 _maxFollowUps 上限。
            //   ★ 不发 agent_end（turn 还没结束）；只在队列真的空了且不调工具时才 break 走 finally。
            if (
              this.followUpQueue.length > 0 &&
              followUpTurnsConsumed < this._maxFollowUps
            ) {
              const toInject =
                this._followUpMode === "one-at-a-time"
                  ? [this.followUpQueue.shift()!]
                  : this.followUpQueue.splice(0);
              this.emitQueueUpdate();
              for (const entry of toInject) {
                const followMsg: UserMessage = {
                  role: "user",
                  content: this.buildUserContent(entry.text, entry.images),
                  timestamp: Date.now(),
                };
                this._messages.push(followMsg);
                this.persistMessage(followMsg);
              }
              toolRounds = 0; // ★ followUp 是新 turn，重置工具轮数预算
              followUpTurnsConsumed++;
              continue; // ★ 不 break，进入下一轮 consumeStream（新 turn）
            }

            break;
          }

          // 有 toolCall：本轮 assistant 消息结束（emit message_end），接下来是工具执行。
          if (!consumed.messageEndEmitted) {
            this.emitMessageStartIfNeeded(consumed);
            this.emit({ type: "message_end", message: assistantMessage });
          }

          // 防死循环：超过 maxToolRounds 强制停。
          toolRounds++;
          if (toolRounds > this._maxToolRounds) {
            agentError = `DeerLoopEngine: 超过最大工具调用轮数（${this._maxToolRounds}），强制停止`;
            break;
          }

          // 构造 ExtensionContext + 执行工具。
          const ctx = this.buildExtensionContext();
          const outputs = await this.toolExecutor.executeBatch(
            toolCalls,
            this.abortController!.signal,
            ctx,
            (e) => this.emit(e),
            {
              // Limit fan-out inside one assistant tool-call batch only. A later
              // LLM round may start another subagent after the previous one
              // completed and its ToolResultMessage has been written back.
              callLimits: [{
                toolName: SUBAGENT_TOOL_NAME,
                maxCallsPerTurn: MAX_SUBAGENT_TOOL_CALLS_PER_TURN,
                usedCalls: 0,
              }],
            },
          );

          // abort 发生在工具执行期间：回填已有结果后跳出。
          if (this.abortController?.signal.aborted) {
            const toolResults = this.buildToolResultMessages(toolCalls, outputs);
            this._messages.push(...toolResults);
            for (const msg of toolResults) this.persistMessage(msg);
            agentError = "aborted";
            break;
          }

          // 构造 ToolResultMessage × N 入 transcript（源序，对齐 toolCalls）。
          const toolResults = this.buildToolResultMessages(toolCalls, outputs);
          this._messages.push(...toolResults);
          for (const msg of toolResults) this.persistMessage(msg);

          // 继续下一轮 LLM 调用（while true 顶部重新构造 context，此时 transcript
          // 已含工具结果，LLM 会看到）。
        }
      } catch (err) {
        // 兜底：循环内不应抛（abort/error 已在 consumeStream/executeBatch 内部隔离），
        // 这里只防未预期异常。
        if (this.isAbortError(err)) {
          agentError = "aborted";
        } else {
          agentError = err instanceof Error ? err.message : String(err);
          const classified = classifyLlmError(err);
          agentErrorCode = classified.code;
        }
      } finally {
        this._isStreaming = false;
        this._isRunning = false;
        this.abortController = null;
        // ★ R9：agent_end 由外层 guard.ensureAgentEnd 统一发射，此处不再重复
      }
    } finally {
      // ★ R9：守卫兜底——保证 agent_end 一定发射（若内部已发射则幂等跳过）。
      //   无论 prompt 正常完成、abort、error、或 compactBeforePromptIfNeeded 抛异常，
      //   这里都会补发 agent_end{willRetry:false}，前端不会永久等待。
      if (!guard.agentEnded) {
        this._isStreaming = false;
        this._isRunning = false;
        this.abortController = null;

        const agentEndEvent: LoopEvent = {
          type: "agent_end",
          messages: [...this._messages],
          willRetry: false,
        };
        if (agentError && agentError !== "aborted") {
          (agentEndEvent as { error?: string }).error = agentError;
        }
        if (agentErrorCode) {
          (agentEndEvent as { errorCode?: NormalizedLlmError["code"] }).errorCode = agentErrorCode;
        }
        this.emit(agentEndEvent);
        guard.ensureAgentEnd();
      }

      // ★ R8：释放 mutex（无论成功/失败/abort，finally 确保锁一定释放）
      release();
    }
  }

  /**
   * 将 transcript 中的有效消息写入 jsonl。
   *
   * SessionManager 的持久化策略是：只有出现第一条 assistant message 后才真正 flush
   * 文件。因此在 prompt 开始时先 append user 不会让侧边栏立刻出现半截空 session；
   * assistant 结束后 append assistant 会一次性写出 header + user + assistant。
   */
  private persistMessage(message: AgentMessage): void {
    const manager = this._sessionManager;
    if (!manager?.isPersisted()) return;
    try {
      manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
    } catch (error) {
      console.warn("DeerLoopEngine: 写入 session jsonl 失败", error);
    }
  }

  private buildLlmRequestMeta(
    requestKind: LlmRequestKind,
    stream: boolean,
    apiKeyHash: string | undefined,
    context: Context,
  ): LlmRequestMeta {
    const chars = JSON.stringify(context.messages ?? []).length + (context.systemPrompt?.length ?? 0);
    return {
      provider: this._model.provider,
      modelId: this._model.id,
      ...(apiKeyHash ? { apiKeyHash } : {}),
      sessionId: this._sessionId,
      requestKind,
      priority: requestKind === "main" ? "high" : requestKind === "subagent" ? "medium" : "low",
      stream,
      estimatedInputTokens: Math.ceil(chars / 4),
    };
  }

  // -------------------------------------------------------------------------
  // ★ M2：stream 消费 + 工具循环辅助方法
  // -------------------------------------------------------------------------

  /**
   * 消费一轮 stream：构造 SimpleStreamOptions → for-await → 跟踪状态 → 返回快照。
   *
   * 把 M1 内联在 prompt 里的流式逻辑提取成独立方法，让 prompt 主循环只管
   * 「消费 → 判断 toolUse → 执行工具 → 回填 → 继续」。
   *
   * emit：message_start（首个 partial 时）、message_update（每个 partial）。
   * **不** emit message_end（交给调用方决定，因为 abort/error/toolUse 的收尾时机不同）。
   */
  private async consumeStream(context: Context): Promise<ConsumedStream> {
    this._isStreaming = true;

    let started = false;
    let lastPartial: AssistantMessage | null = null;
    let finalMessage: AssistantMessage | null = null;
    let aborted = false;
    let errorMessage: string | undefined;
    let rawError: unknown;
    let normalizedError: NormalizedLlmError | undefined;
    let stopReason: string | undefined;
    let permit: LlmPermit | null = null;
    let meta: LlmRequestMeta | null = null;

    // ★ TTFT（首事件超时）：独立于用户 abortController，用于在中转站高峰排队、
    //   HTTP 已建连但迟迟不返回首个流事件时主动取消本次上游请求。触发时
    //   aborted=false（非用户主动停止），归类为 UPSTREAM_TTFT_TIMEOUT，由
    //   consumeStreamWithRetry + RetryPolicy 走自动退避重试。
    let ttftController: AbortController | null = null;
    let ttftTimer: ReturnType<typeof setTimeout> | undefined;
    let ttftCancelled = false;
    const cancelTtft = (): void => {
      ttftCancelled = true;
      if (ttftTimer) {
        clearTimeout(ttftTimer);
        ttftTimer = undefined;
      }
    };

    try {
      ttftController = new AbortController();
      // 合成用户 abort 与 TTFT 两个信号：任一触发都让 stream 抛 AbortError。
      const combinedSignal = AbortSignal.any([
        this.abortController!.signal,
        ttftController.signal,
      ]);
      const streamOptions: SimpleStreamOptions = {
        signal: combinedSignal,
        sessionId: this._sessionId,
      };
      let apiKey: string | undefined;
      if (this._thinkingLevel) {
        streamOptions.reasoning = this._thinkingLevel;
      }
      if (this._getApiKey) {
        // pi-ai 的 SimpleStreamOptions 有 apiKey 字段（同步），而我们持有的是
        // 异步 getApiKey(provider)。在调 stream 前先解析一次（与 pi-agent-core 的
        // AgentLoopConfig.getApiKey 行为一致：每次 LLM 调用前解析）。
        const provider = this._model.provider;
        apiKey = await this._getApiKey(provider);
        if (apiKey) streamOptions.apiKey = apiKey;
      }

      meta = this.buildLlmRequestMeta(this._requestKind, true, hashLlmApiKey(apiKey), context);
      if (isLlmGatewayEnabled()) recordLlmRequest(meta);
      // acquireLlmPermit 仍只听用户 abort：本地排队等待期间不应被 TTFT 打断
      //（排队是 DeerHux 自身的限流，与上游中转站无响应是两件事）。
      permit = await acquireLlmPermit(meta, this.abortController!.signal);
      const stream = this._streamFn(this._model, context, streamOptions);

      // 启动 TTFT 计时器：首个流事件到达前若超时，abort ttftController。
      const ttftMs = this.computeTtftTimeoutMs();
      ttftTimer = setTimeout(() => {
        if (!ttftCancelled && ttftController) {
          ttftController.abort();
        }
      }, ttftMs);
      // unref：与 rate-limiter.drainTimer 一致，避免请求进行中的 45-120s timer
      // 拖住 Node 进程优雅退出。正常路径 cancelTtft() 在 finally 清理。
      ttftTimer.unref?.();

      for await (const ev of stream) {
        // abort 检查：即便 stream 没抛，也主动退出。
        if (this.abortController?.signal.aborted) {
          aborted = true;
          break;
        }

        if (ev.type === "done") {
          cancelTtft();
          finalMessage = ev.message;
          stopReason = ev.reason;
          break;
        }

        if (ev.type === "error") {
          // 上游已响应（即便错误），TTFT 不再适用——取消计时器。
          cancelTtft();
          // stream 显式报告错误（含 aborted）。
          if (ev.reason === "aborted") {
            aborted = true;
          } else {
            errorMessage = ev.error.errorMessage ?? ev.reason;
            rawError = ev.error;
          }
          // ★ 优先保留已生成的 partial 内容（H3 判定需要 contentLength）。
          //   ev.error 通常是空 content 的错误壳；若 lastPartial 有内容，用它
          //   并注入 errorMessage，避免丢弃 LLM 已产出的有效内容。
          finalMessage = lastPartial ?? ev.error;
          stopReason = ev.reason;
          break;
        }

        // start / text_* / thinking_* / toolcall_* 事件：partial 是累计 AssistantMessage。
        lastPartial = ev.partial;
        if (!started) {
          // 首个流事件到达：立即取消 TTFT 计时器，不再因排队超时中断。
          cancelTtft();
          started = true;
          // 上游健康：首事件到达 = 该 endpoint 健康，清零连续失败/退出冷却。
          recordUpstreamSuccess(this.modelRef, meta?.apiKeyHash);
          this.emit({ type: "message_start", message: ev.partial });
        }
        this.emit({
          type: "message_update",
          message: ev.partial,
          assistantMessageEvent: ev,
        });
      }
    } catch (err) {
      // TTFT 超时：ttftController 触发但用户未 abort → 归类为可重试的上游排队超时，
      // 不算用户主动停止（aborted=false），交由 consumeStreamWithRetry 走退避重试。
      if (ttftController?.signal.aborted && !this.abortController?.signal.aborted && !ttftCancelled) {
        const ttftMsg = getLlmUserMessage("UPSTREAM_TTFT_TIMEOUT");
        errorMessage = "模型服务长时间未返回首个响应（UPSTREAM_TTFT_TIMEOUT）";
        normalizedError = {
          code: "UPSTREAM_TTFT_TIMEOUT",
          message: errorMessage,
          retryable: true,
          provider: this._model.provider,
          modelId: this._model.id,
          userMessage: ttftMsg,
          suggestedAction: "wait",
        };
      } else if (this.isAbortError(err)) {
        // 用户 abort 导致的抛错。
        aborted = true;
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
        rawError = err;
      }
    } finally {
      cancelTtft();
      permit?.release();
      this._isStreaming = false;
      ttftController = null;
    }

    if (errorMessage && !aborted) {
      if (!normalizedError) {
        normalizedError = classifyLlmError(rawError ?? errorMessage, meta ?? undefined);
      }
      recordLlmError(meta ?? {}, normalizedError.code);
      // 上游健康：TTFT 超时 / 过载 / 限流计入连续失败，达阈值进入冷却。
      recordUpstreamFailure(this.modelRef, meta?.apiKeyHash, normalizedError.code);
    } else if (!aborted && meta) {
      recordLlmSuccess(meta);
    }

    const displayErrorMessage = normalizedError?.userMessage ?? errorMessage;
    const endMessage = this.resolveEndMessage(
      finalMessage,
      lastPartial,
      aborted,
      displayErrorMessage,
    );

    return { endMessage, started, aborted, errorMessage, error: rawError, normalizedError, stopReason };
  }

  /**
   * 若 consumeStream 未 emit message_start（stream 立即结束/出错/abort），补一次。
   * 保证 message_start / message_end 严格成对。
   */
  private emitMessageStartIfNeeded(consumed: ConsumedStream): void {
    if (!consumed.started) {
      this.emit({ type: "message_start", message: consumed.endMessage });
    }
  }

  // -------------------------------------------------------------------------
  // ★ M4：重试循环（封装 H2/H3/H4）
  // -------------------------------------------------------------------------

  /**
   * 带重试的 stream 消费（M4 核心）。
   *
   * 在 {@link consumeStream} 外层包一个重试循环。失败时调 {@link RetryPolicy.isRetryable}
   * 判定是否重试，并发射 `auto_retry_start` / `auto_retry_end` 事件。
   *
   * 事件顺序契约（设计文档 §7.1 + wrapper rpc-manager.ts:666-688）：
   *
   * 首轮失败 + 可重试：
   * ```
   *   message_start → message_update*N → message_end (失败)
   *   → agent_end{willRetry:true}
   *   → auto_retry_start{attempt, delayMs, errorMessage}
   *   → (sleep settleMs + delayMs，可被 abort 打断)
   *   → message_start → ... (重试)
   * ```
   *
   * 重试后成功：
   * ```
   *   → message_end (成功) → auto_retry_end{success:true, attempt}
   * ```
   *
   * 全部重试失败 / 不可重试：
   * ```
   *   → auto_retry_end{success:false, attempt, finalError}
   * ```
   *
   * abort 打断 sleep：
   * ```
   *   → auto_retry_end{success:false, attempt, finalError:"aborted"}
   * ```
   *
   * ★ 重试与工具循环的交互：本方法只管 consumeStream 的重试，与外层工具循环解耦。
   *   如果失败发生在工具执行后、第二轮 consumeStream——此时 transcript 已含 toolResult，
   *   重试第二轮会带上工具结果，这是合理的。工具执行本身的错误不重试（M2 错误隔离已做）。
   *
   * ★ transcript 处理：失败轮次的 assistant message 【不】入 transcript（重试是"假装上一轮
   *   没发生"，否则 LLM 会看到自己的失败消息）。只有最终结果由调用方 push。
   *
   * @returns 最终的 ConsumedStream（成功 / abort / 不可重试错误 / 全部重试失败）。
   *          失败轮次的 message 事件已在本方法内 emit；调用方只需处理最终结果。
   */
  private async consumeStreamWithRetry(context: Context): Promise<ConsumedStream> {
    let retryCount = 0; // 已完成的重试次数（0 = 初始尝试，未重试过）
    // ★ R9：记录最近一次 consumed 快照，用于兜底补发 message_end
    let lastConsumedForGuard: ConsumedStream | null = null;

    while (true) {
      const consumed = await this.consumeStream(context);
      lastConsumedForGuard = consumed; // ★ R9：记录快照供兜底

      // 成功或 abort：不重试。
      // ★ M4 修复（事件顺序契约）：重试后的最终轮，先发 message_start+message_end，
      //   再发 auto_retry_end——保证 message_end 在 auto_retry_end 之前。
      if (!consumed.errorMessage || consumed.aborted) {
        if (retryCount > 0 && !consumed.aborted) {
          // 重试后成功：先补 message_start（如未发）+ message_end，再发 auto_retry_end{success:true}
          this.emitMessageStartIfNeeded(consumed);
          this.emit({ type: "message_end", message: consumed.endMessage });
          this.emit({ type: "auto_retry_end", success: true, attempt: retryCount });
          return { ...consumed, messageEndEmitted: true };
        }
        return consumed;
      }

      // 错误：检查是否可重试
      const policy = this._retryPolicy;
      if (!policy || !this._autoRetryEnabled) {
        return consumed; // 未安装策略或运行时关闭 → 不重试
      }

      const nextAttempt = retryCount + 1; // 1-indexed：第一次重试 attempt=1
      const contentLength = getAssistantContentLength(consumed.endMessage);
      const normalizedError = consumed.normalizedError ?? classifyLlmError(consumed.error ?? consumed.errorMessage);
      const decision = policy.isRetryable({
        attempt: nextAttempt,
        errorMessage: consumed.errorMessage,
        partialMessage: consumed.endMessage,
        contentLength,
        normalizedError,
      });

      // 不可重试或超过 maxAttempts
      if (!decision.retry || nextAttempt > policy.maxAttempts) {
        if (retryCount > 0) {
          // ★ M4 修复（事件顺序契约）：重试后最终失败，先发 message_start+message_end，
          //   再发 auto_retry_end{success:false}。
          this.emitMessageStartIfNeeded(consumed);
          this.emit({ type: "message_end", message: consumed.endMessage });
          this.emit({
            type: "auto_retry_end",
            success: false,
            attempt: retryCount,
            finalError: consumed.errorMessage,
          });
          return { ...consumed, messageEndEmitted: true };
        }
        return consumed;
      }

      // ★ 可重试：发射失败轮次的收尾事件
      // message_start（若 consumeStream 未发）+ message_end（失败轮次）
      this.emitMessageStartIfNeeded(consumed);
      this.emit({ type: "message_end", message: consumed.endMessage });

      // agent_end{willRetry:true}：告诉前端/ wrapper 本轮失败但会重试（保持 _isRunning=true）
      this.emit({
        type: "agent_end",
        messages: [...this._messages],
        willRetry: true,
      });

      // auto_retry_start：通知前端开始重试
      this.emit({
        type: "auto_retry_start",
        attempt: nextAttempt,
        maxAttempts: policy.maxAttempts,
        delayMs: decision.delayMs,
        errorMessage: consumed.errorMessage,
        errorCode: normalizedError.code,
        retryAfterMs: normalizedError.retryAfterMs,
        userMessage: normalizedError.userMessage,
        suggestedAction: normalizedError.suggestedAction,
      });

      // ★ H4（settleMs）+ H2（delayMs）sleep。可被 abort 打断。
      await this.sleepInterruptible(policy.getSettleMs() + decision.delayMs);

      // abort 打断 sleep：立即停止重试
      if (this.abortController?.signal.aborted) {
        // ★ M4 修复（问题 #2）：重新 resolve endMessage 为 aborted 版本。
        //   原本 consumed.endMessage 是失败轮次的 error 消息，
        //   abort 后应该发 message_end{stopReason:"aborted"}（语义正确）。
        const abortedMessage = this.resolveEndMessage(
          consumed.endMessage,
          null,
          true, // aborted
          undefined,
        );
        // ★ M4 修复（问题 #1）：先发 message_start+message_end{aborted}，再发 auto_retry_end。
        this.emitMessageStartIfNeeded(consumed);
        this.emit({ type: "message_end", message: abortedMessage });
        this.emit({
          type: "auto_retry_end",
          success: false,
          attempt: nextAttempt,
          finalError: "aborted",
        });
        // ★ M4 修复（问题 #3）：abort 不污染 transcript——返回 abortedMessage
        //   但标记不 push（prompt 主循环检查 aborted 分支不 push）。
        return {
          ...consumed,
          endMessage: abortedMessage,
          aborted: true,
          errorMessage: undefined,
          messageEndEmitted: true,
        };
      }

      retryCount = nextAttempt;
      // 继续循环 → 重新 consumeStream（重试）
    }
    // ★ R9：防御性保护——若 while 循环因未预期异常退出（非正常 return），
    //   补发 message_end 避免前端永久等待。正常 return 路径不受影响。
    if (lastConsumedForGuard) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const fc = lastConsumedForGuard as ConsumedStream;
      if (!fc.messageEndEmitted) {
        try {
          this.emitMessageStartIfNeeded(fc);
          this.emit({ type: "message_end", message: fc.endMessage });
        } catch {
          // 静默：事件发射失败不应掩盖原始错误
        }
      }
    }
  }

  /**
   * 可被 abort 打断的 sleep（M4 关键：abort 优先于 retry）。
   *
   * - 若 abortController 已 aborted，立即 resolve。
   * - 否则设一个 timer，同时监听 abort 信号；任一触发即 resolve。
   *
   * 这保证重试 sleep 期间用户点"停止"能立即生效（不等完 delayMs）。
   */
  private async sleepInterruptible(ms: number): Promise<void> {
    const controller = this.abortController;
    if (!controller) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    const signal = controller.signal;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /**
   * 构造工具 execute 第 5 参用的 MinimalExtensionContext。
   *
   * 复用 loop 的最小代理（sessionManager / modelRegistry）与状态（cwd / model /
   * abortController / _isStreaming）。signal 必非空（工具执行期间在 prompt 调用，
   * abortController 已创建）。
   */
  private buildExtensionContext(): import("./extension-context.ts").ExtensionContext {
    const signal = this.abortController?.signal;
    if (!signal) {
      // 理论上不会发生（buildExtensionContext 只在 prompt 内调，abortController 非空）。
      throw new Error(
        "DeerLoopEngine.buildExtensionContext: abortController.signal 不可用（不在 prompt 执行期间）",
      );
    }
    return createMinimalExtensionContext({
      cwd: this._cwd,
      model: this._model,
      signal,
      abort: () => {
        void this.abort();
      },
      isIdle: () => !this._isStreaming && !this._isRunning,
      getSystemPrompt: () => this._baseSystemPrompt,
      // ★ M5：工具 execute 可通过 ctx.hasPendingMessages 查询队列状态（如 subagent
      //   工具想根据是否有待处理 steer/followUp 改变行为）。返回两个队列任一非空。
      hasPendingMessages: () => this.hasQueuedMessages(),
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
    });
  }

  /**
   * 构造 ToolResultMessage × N（每个 toolCall 一条，源序）。
   *
   * pi-ai 的 ToolResultMessage（types.d.ts:203）：
   *   { role: "toolResult", toolCallId, toolName, content, details?, isError, timestamp }
   * ★ role 是 "toolResult"（不是 "tool"），每个 toolCall 一条独立消息。
   * content 从 AgentToolResult.content 透传（[TextContent | ImageContent]）。
   */
  private buildToolResultMessages(
    toolCalls: readonly ToolCall[],
    outputs: readonly ToolExecOutput[],
  ): ToolResultMessage[] {
    const now = Date.now();
    return toolCalls.map((call, i) => {
      const output = outputs[i];
      const content = (output?.result?.content ?? [
        { type: "text" as const, text: "(no result)" },
      ]) as ToolResultMessage["content"];
      return {
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content,
        ...(output?.result?.details !== undefined ? { details: output.result.details } : {}),
        isError: output?.isError ?? false,
        timestamp: now,
      } satisfies ToolResultMessage;
    });
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：abort
  // -------------------------------------------------------------------------

  /**
   * 中止当前 in-flight stream。
   *
   * 立即触发 abortController.abort()；返回的 promise 在 prompt 的 try/finally
   * 跑完（agent_end 已 emit、_isRunning 归零）后 resolve。
   *
   * 若当前没有运行中的 prompt，直接 resolve（幂等）。
   *
   * ★ M5 队列行为决策（验收后调整）：abort 清空【steering】但【保留 followUp】。
   *   理由：steering 是 turn 进行中的「插嘴」，语义绑当前 turn——abort 放弃当前 turn
   *   时插嘴也应作废（避免下次 prompt 上下文串线 / 旧指令污染）。
   *   followUp 是 turn 结束后的「追问」，abort 后用户仍可能想继续追问，保留。
   *   如需全部清空，调 clearQueues()。 */
  async abort(): Promise<void> {
    const controller = this.abortController;
    if (!controller || this._isRunning === false) {
      return;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
    // ★ 清空 steering（插嘴绑当前 turn，abort 应作废），保留 followUp。
    if (this.steeringQueue.length > 0) {
      this.steeringQueue.splice(0);
      this.emitQueueUpdate();
    }
    // 等待 prompt 主循环感知到 abort 并完成收尾。
    await this.waitForIdle();
  }

  // -------------------------------------------------------------------------
  // ★ M1 核心方法：subscribe / dispose
  // -------------------------------------------------------------------------

  /**
   * 订阅 LoopEvent。返回取消订阅函数。
   * listener 签名按 Port 契约声明为 AgentSessionEvent（与 pi 兼容），
   * DeerLoopEngine emit 的 LoopEvent 对象结构兼容，透传安全。
   */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 释放底层资源：中止运行 + 清空监听 + 清空队列。之后再调 prompt 行为未定义
   * （M1 不做重启保护）。
   *
   * ★ M5：dispose 会清空 steering/followUp 队列（与 abort 不同——dispose 是「销毁」，
   *   保留排队消息无意义）。 */
  dispose(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.clearQueues();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // 只读属性
  // -------------------------------------------------------------------------

  get sessionId(): string {
    return this._sessionId;
  }

  /** 真实 SessionManager 注入时返回当前 jsonl 文件路径。 */
  get sessionFile(): string | undefined {
    return this._sessionManager?.getSessionFile?.() ?? undefined;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  get autoCompactionEnabled(): boolean {
    return this._autoCompactionEnabled;
  }

  /** ★ M4：返回真实重试状态（installRetryHardening 后为 true）。 */
  get autoRetryEnabled(): boolean {
    return this._autoRetryEnabled;
  }

  get model(): AnyModel {
    return this._model;
  }

  /** 当前模型的 ModelRef 视图（provider + modelId + baseUrl），用于上游健康 key 构造。
   *  baseUrl 区分同 provider 同模型但走不同中转站的 endpoint——用户多中转站场景关键。 */
  get modelRef(): { provider: string; modelId: string; baseUrl: string } {
    return { provider: this._model.provider, modelId: this._model.id, baseUrl: this._model.baseUrl };
  }

  get thinkingLevel(): ThinkingLevel | undefined {
    return this._thinkingLevel;
  }

  /**
   * agent.state 代理（Port 过渡字段）。
   *
   * wrapper 构造时读 agent.state.systemPrompt；get_state 读 systemPrompt + thinkingLevel。
   * 返回内部维护的最小 state 对象（真实值，非 mock）。
   */
  get agent(): { state: { systemPrompt: string; thinkingLevel: string } } {
    return { state: this._agentState };
  }

  /**
   * sessionManager 代理（Port 过渡字段）。
   *
   * wrapper 构造时 applyRolePrompt 会调 sessionManager.getCwd()；
   * 多处读 isPersisted() / appendCustomEntry()。生产路径注入真实 SessionManager，
   * 未注入时提供最小代理满足这些调用（getCwd 返回 cwd，isPersisted 返回 false，
   * appendCustomEntry 返回占位 id）。其他方法（getBranch/fork 等）被调时 throw。
   */
  get sessionManager(): import("@earendil-works/pi-coding-agent").SessionManager {
    return this._sessionManager ?? createMinimalSessionManager(this._cwd);
  }

  /**
   * settingsManager 代理（Port 过渡字段）。
   *
   * M1 灰度路径不读 settingsManager（compact/retry 命令不走）。提供最小代理
   * 满足 Port 类型；getCompactionSettings 返回默认值。
   */
  get settingsManager(): import("@earendil-works/pi-coding-agent").SettingsManager {
    return createMinimalSettingsManager();
  }

  /**
   * modelRegistry 代理（Port 过渡字段）。
   *
   * 生产路径由 startDeerLoopSession 注入真实 ModelRegistry；测试未注入时保留
   * 空代理，避免构造最小 engine 需要读用户模型配置。
   */
  get modelRegistry(): DeerLoopModelRegistry {
    return this._modelRegistry ?? { find: () => undefined };
  }

  // -------------------------------------------------------------------------
  // Hack 方法（Port 要求，M1 最小/空实现）
  // -------------------------------------------------------------------------

  /**
   * 设置持久 system prompt（Port hack 方法，消灭 H1）。
   *
   * ★ M3 验证结论（scripts/test-system-prompt-persistence.mjs +
   *   scripts/test-turn-context-block.mjs 全过）：
   *   1. 持久性：连发 N 个 prompt，每轮 consumeStream 构建的
   *      context.systemPrompt 都等于这里写入的值（不被重置）——因为
   *      DeerLoopEngine 自持 _baseSystemPrompt，没有 pi 那种「外部
   *      _rebuildSystemPrompt 把 state.systemPrompt 覆盖回私有字段」的问题。
   *   2. agent.state 同步：_agentState.systemPrompt 与 _baseSystemPrompt
   *      双写，wrapper 读 this.inner.agent.state.systemPrompt 永远拿到最新值。
   *   3. turn_context 责任分工：本方法是【纯透传】——set 什么，context 就用什么。
   *      它【不】自动 stripTurnContextBlock（DeerLoopEngine 不知道 turn_context
   *      是什么）。strip 是 wrapper 的职责（rpc-manager.ts 的 stripTurnContextBlock
   *      + applyRolePrompt + withTemporarySystemPrompt.finally）。这样保持语义
   *      单一：wrapper 全权决定 prompt 内容，loop 只负责「值精确透传 + 持久」。
   *      若这里加防御性 strip，会与 wrapper 的 strip 重叠且改变 set 的语义（set X
   *      不一定得 X），故【刻意不加】。
   *
   * 不能 throw——wrapper 构造时 applyRolePrompt 会立即调用。
   */
  setSystemPromptPersistent(prompt: string): void {
    this._baseSystemPrompt = prompt;
    this._agentState.systemPrompt = prompt;
  }

  /**
   * 应用工具执行模式（Port hack 方法，消灭 H5/H6/H7/H8）。★ M2 真正实现。
   *
   * 对齐 PiEngineAdapter 的逻辑：
   * - PI_DISABLE_PARALLEL_TOOLS=1 时，全局默认设为 sequential（H5）。
   * - 按 DEFAULT_TOOL_EXECUTION_MODES 表为内置工具设 sequential/parallel（H6/H7/H8）。
   *
   * DeerLoopEngine 只有一份 registry，写入即生效，无需三处同步。
   */
  applyToolExecutionModes(): void {
    const forceSequential =
      process.env.PI_DISABLE_PARALLEL_TOOLS === "1" ||
      process.env.PI_DISABLE_PARALLEL_TOOLS === "true";
    if (forceSequential) {
      this.registry.setDefaultExecutionMode("sequential");
    }
    // 为已注册的内置工具应用预设 mode（仅当表里有该工具名时）。
    for (const tool of this.registry.getAll()) {
      const mode = DEFAULT_TOOL_EXECUTION_MODES[tool.name];
      if (mode) {
        this.registry.setExecutionMode(tool.name, mode);
      } else if (forceSequential) {
        // 未在表里的工具，强制串行时也设 sequential。
        this.registry.setExecutionMode(tool.name, "sequential");
      }
    }
  }

  /**
   * 安装自动重试加固（Port hack 方法，消灭 H2/H3/H4）。★ M4 真正实现。
   *
   * pi 路径（PiEngineAdapter）里这是三处私有字段 hack（getRetrySettings /
   * _isRetryableError / _prepareRetry）。自研 loop 不需要 hack——直接安装
   * {@link DefaultRetryPolicy}，重试判定与退避全部走公开接口。
   *
   * 安装后 `_autoRetryEnabled` 默认 true（与 pi 行为一致）。可用
   * {@link setAutoRetryEnabled} 运行时关闭。
   *
   * 重复调用幂等：重新安装会覆盖旧策略（便于运行时换策略）。
   */
  installRetryHardening(): void {
    this._retryPolicy = new DefaultRetryPolicy();
    this._autoRetryEnabled = true;
  }

  /**
   * 运行时热替换自定义工具（Port hack 方法，消灭 H9）。★ M2 实现。
   *
   * 原子操作：register+unregister+setActive 一次完成。对应 rpc-manager.installMcpRuntime
   * 里对 pi 私有字段 _customTools / _allowedToolNames / _refreshToolRegistry 的操作。
   * DeerLoopEngine 走公开 registry.replaceBatch，无中间态。
   */
  replaceCustomTools(options: {
    removeNames: readonly string[];
    addTools: ToolDefinition[];
    extraAllowedNames: readonly string[];
    activeToolNames: readonly string[];
  }): void {
    this.registry.replaceBatch({
      removeNames: options.removeNames,
      addTools: options.addTools as AnyToolDefinition[],
      activeToolNames: options.activeToolNames,
      extraAllowedNames: options.extraAllowedNames,
    });
    // 热替换后重新应用执行模式（新注册的工具需要 mode 预设）。
    this.applyToolExecutionModes();
  }

  // -------------------------------------------------------------------------
  // Port其余方法：M2-M6 的能力，统一 throw not-implemented
  // -------------------------------------------------------------------------

  async setModel(model: AnyModel): Promise<void> {
    if (this._isRunning) {
      throw new Error("DeerLoopEngine.setModel: 无法切换模型——prompt 正在运行");
    }
    // rpc-manager 通常传入 ModelRegistry.find() 返回的完整 Model；若只传 {id, provider}，
    // 保留当前 model 的 api/contextWindow 等 provider 元数据，只覆盖选择项。
    this._model = { ...this._model, ...model } as AnyModel;
  }

  async navigateTree(
    _targetId: string,
    _options?: { summarize?: boolean },
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
  }> {
    throw notImplemented("navigateTree", "M6 (SessionStore)");
  }

  /**
   * appendCustomEntry：wrapper 用它写 display_user_message / turn_context /
   * agent_mode 等 UI 元数据。注入了真实 sessionManager 时透传写 jsonl；否则 no-op。
   */
  appendCustomEntry(customType: string, data?: unknown): string {
    const manager = this._sessionManager;
    if (manager?.isPersisted()) {
      try {
        return manager.appendCustomEntry(customType, data);
      } catch (error) {
        console.warn("DeerLoopEngine: 写入 custom entry 失败", error);
      }
    }
    // 未注入 sessionManager（单测路径）或写入失败：返回稳定占位 id 避免上游炸。
    return `deer-loop-custom-${Date.now()}-${customType}`;
  }

  setThinkingLevel(level: string): void {
    if (level === "off" || !level) {
      this._thinkingLevel = undefined;
      this._agentState.thinkingLevel = "off";
      return;
    }
    this._thinkingLevel = level as ThinkingLevel;
    this._agentState.thinkingLevel = level;
  }

  /**
   * ★ M6 实现：压缩对话历史。
   *
   * 用 streamFn 单轮调 LLM（不带工具），把当前 transcript 总结成一段 summary，
   * 然后用 summary assistant message 替换整个 transcript（splice(0) 清空 + push）。
   * 发射 compaction_start / compaction_end 事件。
   *
   * 互斥保护：prompt 运行中 / 已在 compact 时 throw。abortCompaction 可打断。
   *
   * @param customInstructions 额外的压缩指令（追加到 systemPrompt）
   * @returns CompactionResult（summary / tokensBefore / tokensAfter）
   */
  /**
   * 压缩历史并把结果持久化为 session 的 compaction 条目。
   *
   * 不能只替换内存 transcript：wrapper 被回收或刷新页面后会从 jsonl 重建上下文，
   * 因此必须调用 SessionManager.appendCompaction()，再从持久化分支重新加载。
   */
  async compact(
    customInstructions?: string,
    reason: "manual" | "threshold" | "overflow" = "manual",
  ): Promise<CompactionResult> {
    if (this._isRunning) {
      throw new Error("DeerLoopEngine.compact: 无法压缩——prompt 正在运行");
    }
    if (this._isCompacting) {
      throw new Error("DeerLoopEngine.compact: 压缩已在进行中");
    }

    this._isCompacting = true;
    this.compactionAbortController = new AbortController();
    this.emit({ type: "compaction_start", reason });

    const tokensBefore = this.getContextUsage()?.tokens ?? estimateTokens(this._messages);
    try {
      const manager = this._sessionManager;
      if (!manager?.isPersisted()) {
        throw new Error("当前会话尚未持久化，无法安全压缩");
      }

      const entries = manager.getBranch();
      const contextWindow = this._model.contextWindow ?? 8192;
      const settings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        // 默认配置面向大上下文模型；小窗口模型必须按窗口比例缩小保留区和摘要预算。
        reserveTokens: Math.max(256, Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(contextWindow * 0.2))),
        keepRecentTokens: Math.max(512, Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(contextWindow * 0.35))),
      };
      let previousCompactionIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type === "compaction") {
          previousCompactionIndex = i;
          break;
        }
      }

      let boundaryStart = 0;
      let previousSummary: string | undefined;
      if (previousCompactionIndex >= 0) {
        const previous = entries[previousCompactionIndex] as {
          firstKeptEntryId?: string;
          summary?: string;
        };
        previousSummary = previous.summary;
        const firstKeptIndex = previous.firstKeptEntryId
          ? entries.findIndex((entry) => entry.id === previous.firstKeptEntryId)
          : -1;
        boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : previousCompactionIndex + 1;
      }

      const rawCutPoint = findCutPoint(entries, boundaryStart, entries.length, settings.keepRecentTokens);
      // 绝不能从 tool call 与 tool result 的中间切开：部分 provider 会拒绝孤立的
      // toolResult。宁可多保留当前完整回合，也不能生成不合法的消息序列。
      const firstKeptEntryIndex = rawCutPoint.isSplitTurn && rawCutPoint.turnStartIndex >= boundaryStart
        ? rawCutPoint.turnStartIndex
        : rawCutPoint.firstKeptEntryIndex;
      const historyEnd = firstKeptEntryIndex;
      if (historyEnd <= boundaryStart) {
        throw new Error("Conversation too short to compact");
      }
      const firstKeptEntryId = entries[firstKeptEntryIndex]?.id;
      if (!firstKeptEntryId) throw new Error("无法确定压缩边界，session 可能已损坏");

      // 普通 custom 是 UI 元数据，不参与模型上下文；custom_message / branch_summary 则必须纳入摘要。
      const messagesToSummarize = entries.slice(boundaryStart, historyEnd).flatMap((entry) => {
        if (entry.type === "message") return [entry.message as AgentMessage];
        if (entry.type === "custom_message") {
          return [{
            role: "user",
            content: entry.content,
            timestamp: Date.parse(entry.timestamp) || Date.now(),
          } as AgentMessage];
        }
        if (entry.type === "branch_summary" && entry.summary) {
          return [{
            role: "user",
            content: `[Branch summary]\n${entry.summary}`,
            timestamp: Date.parse(entry.timestamp) || Date.now(),
          } as AgentMessage];
        }
        return [];
      });
      if (!messagesToSummarize.length) throw new Error("Conversation too short to compact");

      const apiKey = this._getApiKey ? await this._getApiKey(this._model.provider) : undefined;
      const summary = await this.generateCompactionSummary(
        messagesToSummarize,
        settings.reserveTokens,
        apiKey,
        customInstructions,
        previousSummary,
      );
      if (this.compactionAbortController.signal.aborted) {
        const result = { summary: "", tokensBefore, tokensAfter: tokensBefore };
        this.emit({ type: "compaction_end", reason, aborted: true, willRetry: false });
        return result;
      }
      if (!summary.trim()) throw new Error("压缩模型未返回有效摘要");

      manager.appendCompaction(summary, firstKeptEntryId, tokensBefore);
      const compactedContext = buildSessionContext(manager.getEntries(), manager.getLeafId());
      this._messages.splice(0, this._messages.length, ...(compactedContext.messages as AgentMessage[]));

      const tokensAfter = this.getContextUsage()?.tokens ?? estimateTokens(this._messages);
      const result: CompactionResult = { summary, tokensBefore, tokensAfter };
      this.emit({ type: "compaction_end", reason, result, aborted: false, willRetry: false });
      return result;
    } catch (err) {
      if (this.compactionAbortController?.signal.aborted || this.isAbortError(err)) {
        const result = { summary: "", tokensBefore, tokensAfter: tokensBefore };
        this.emit({ type: "compaction_end", reason, aborted: true, willRetry: false });
        return result;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emit({ type: "compaction_end", reason, aborted: false, willRetry: false, errorMessage });
      throw err;
    } finally {
      this._isCompacting = false;
      this.compactionAbortController = null;
    }
  }

  /**
   * 分批生成滚动摘要，避免历史已经过大时，首次压缩请求本身再次超过模型上下文。
   * 每批摘要会合并进 previousSummary；因此最终只保留一份可继续使用的检查点。
   */
  private async generateCompactionSummary(
    messages: AgentMessage[],
    reserveTokens: number,
    apiKey: string | undefined,
    customInstructions: string | undefined,
    previousSummary: string | undefined,
  ): Promise<string> {
    // 摘要模型不需要复现原始工具协议；统一转成带原角色标记的文本，
    // 从而可在任意位置安全切批，避免 toolCall/toolResult 被拆开后被 API 拒绝。
    const summaryMessages = messages.map((message) => this.toCompactionTextMessage(
      this.truncateMessageForCompaction(message),
    ));
    const contextWindow = this._model.contextWindow ?? 8192;
    const outputAndPromptReserve = Math.max(1_024, Math.floor(contextWindow * 0.125));
    // 当前批次 + 上一份滚动摘要 + 新摘要输出 + 系统提示词必须同时装进窗口。
    const batchTokenLimit = Math.max(
      512,
      Math.min(12_000, contextWindow - reserveTokens * 2 - outputAndPromptReserve),
    );
    const batches: AgentMessage[][] = [];
    let batch: AgentMessage[] = [];
    let batchTokens = 0;

    for (const message of summaryMessages) {
      const messageTokens = estimateTokens([message]);
      if (batch.length > 0 && batchTokens + messageTokens > batchTokenLimit) {
        batches.push(batch);
        batch = [];
        batchTokens = 0;
      }
      batch.push(message);
      batchTokens += messageTokens;
    }
    if (batch.length) batches.push(batch);

    let summary = previousSummary;
    for (const currentBatch of batches) {
      if (this.compactionAbortController?.signal.aborted) return "";
      summary = await generateSummary(
        currentBatch as never,
        this._model as never,
        reserveTokens,
        apiKey,
        undefined,
        this.compactionAbortController?.signal,
        customInstructions,
        summary,
        this._thinkingLevel,
        this._streamFn as never,
      );
      if (!summary.trim()) throw new Error("压缩模型未返回有效摘要");
    }
    return summary ?? "";
  }

  /** 将超大记录裁成可摘要的代表性片段，不修改原始会话内容。 */
  private truncateMessageForCompaction(message: AgentMessage): AgentMessage {
    const contextWindow = this._model.contextWindow ?? 8192;
    // 工具结果常是冗长日志；一个回合可能含数十条，必须比普通消息更严格截断。
    const maxChars = message.role === "toolResult"
      ? Math.max(1_024, Math.min(2_048, Math.floor(contextWindow * 0.125)))
      : Math.max(4_000, Math.min(24_000, contextWindow * 2));
    const truncate = (text: string): string => {
      if (text.length <= maxChars) return text;
      const half = Math.floor((maxChars - 96) / 2);
      return `${text.slice(0, half)}\n\n[... 为生成会话摘要，已省略 ${text.length - half * 2} 个字符 ...]\n\n${text.slice(-half)}`;
    };
    const content = message.content;
    if (typeof content === "string") {
      const next = truncate(content);
      return next === content ? message : ({ ...message, content: next } as AgentMessage);
    }
    if (!Array.isArray(content)) return message;

    let changed = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const next = { ...block } as Record<string, unknown>;
      for (const key of ["text", "thinking"] as const) {
        if (typeof next[key] === "string") {
          const truncated = truncate(next[key] as string);
          if (truncated !== next[key]) {
            next[key] = truncated;
            changed = true;
          }
        }
      }
      if (next.type === "image") {
        changed = true;
        return { type: "text", text: "[图片已省略；原始图片仍保留在会话记录中]" } as unknown as typeof block;
      }
      if (next.type === "toolCall" && next.arguments !== undefined) {
        const serialized = JSON.stringify(next.arguments) ?? "";
        if (serialized.length > maxChars) {
          next.arguments = { _truncatedForCompaction: truncate(serialized) };
          changed = true;
        }
      }
      return next as unknown as typeof block;
    });
    return changed ? { ...message, content: nextContent } as AgentMessage : message;
  }

  /** 将摘要输入转成普通文本，隔离原始工具调用协议和大对象结构。 */
  private toCompactionTextMessage(message: AgentMessage): AgentMessage {
    let content: string;
    try {
      content = typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    } catch {
      content = "[无法序列化的历史消息内容已省略]";
    }
    return {
      role: "user",
      content: `<history role="${message.role}">\n${content}\n</history>`,
      timestamp: message.timestamp ?? Date.now(),
    } as AgentMessage;
  }

  /** 在下一回合开始前预留足够空间，避免模型先因超上下文失败。 */
  private async compactBeforePromptIfNeeded(): Promise<void> {
    if (!this._autoCompactionEnabled || !this._sessionManager?.isPersisted()) return;
    const usage = this.getContextUsage();
    if (!usage?.tokens || usage.contextWindow <= 0) return;
    // 标准 reserveTokens 对小窗口模型会过大；统一在 70% 时提前压缩。
    if (usage.tokens / usage.contextWindow < 0.7) return;
    try {
      await this.compact(undefined, "threshold");
    } catch (error) {
      // 压缩失败不丢弃用户本轮请求；原 prompt/重试链仍可报告上游错误。
      console.warn("DeerLoopEngine: 自动压缩失败，将继续本轮请求", error);
    }
  }

  setAutoCompactionEnabled(enabled: boolean): void {
    this._autoCompactionEnabled = enabled;
  }

  /** ★ M4：运行时开关自动重试（set_auto_retry 命令用）。 */
  setAutoRetryEnabled(enabled: boolean): void {
    this._autoRetryEnabled = enabled;
  }

  async steer(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    // ★ M5 实现：消息入 steeringQueue，emit queue_update。
    //   drain 时机在 prompt 主循环顶部（consumeStream 之前），见 prompt 注释。
    this.enqueueBounded(this.steeringQueue, { text, images }, "steering");
    this.emitQueueUpdate();
  }

  async followUp(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    // ★ M5 实现：消息入 followUpQueue，emit queue_update。
    //   drain 时机在 turn 结束点（无工具调用、stopReason=stop），见 prompt 注释。
    //   ★ 注意：rpc-manager 的 follow_up 命令在 turn 活跃时调本方法入队；
    //   turn 已结束时直接调 prompt 开新 turn（不走队列）。两条路径互斥。
    this.enqueueBounded(this.followUpQueue, { text, images }, "followUp");
    this.emitQueueUpdate();
  }

  /** ★ M5 验收修复：有界入队（防内存 DoS）。
   *
   *  超过 MAX_QUEUE_LENGTH 时丢弃最旧条目并 console.warn（不 throw，保持 fire-and-forget 语义）。
   *  DeerHux 是本地桌面应用，DoS 风险低，但加限制是防御性最佳实践。 */
  private enqueueBounded(queue: QueueEntry[], entry: QueueEntry, name: string): void {
    queue.push(entry);
    if (queue.length > MAX_QUEUE_LENGTH) {
      const dropped = queue.shift();
      console.warn(`[DeerLoopEngine] ${name} 队列超过上限 ${MAX_QUEUE_LENGTH}，丢弃最旧条目: ${dropped?.text.slice(0, 50)}...`);
    }
  }

  /** ★ M5：设置 steering 队列模式（运行时切换）。
   *
   *  - "all"：drain 时一次注入全部插嘴消息
   *  - "one-at-a-time"：只注入最老一条
   *
   *  不发 queue_update（mode 不是队列内容变化）。 */
  setSteeringMode(mode: QueueMode): void {
    this._steeringMode = mode;
  }

  /** ★ M5：设置 followUp 队列模式。语义同 setSteeringMode。 */
  setFollowUpMode(mode: QueueMode): void {
    this._followUpMode = mode;
  }

  /** ★ M5：读取当前 steering 队列模式（测试 / get_state 用）。 */
  get steeringMode(): QueueMode {
    return this._steeringMode;
  }

  /** ★ M5：读取当前 followUp 队列模式。 */
  get followUpMode(): QueueMode {
    return this._followUpMode;
  }

  /** ★ M5：steering 队列中的消息条数。 */
  get steeringQueueLength(): number {
    return this.steeringQueue.length;
  }

  /** ★ M5：followUp 队列中的消息条数。 */
  get followUpQueueLength(): number {
    return this.followUpQueue.length;
  }

  /** ★ M5：是否还有排队消息（steering 或 followUp 任一非空）。 */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
  }

  /** ★ M5：清空 steering 队列。返回被清除的消息文本列表。 */
  clearSteeringQueue(): string[] {
    const removed = this.steeringQueue.splice(0).map((e) => e.text);
    if (removed.length > 0) this.emitQueueUpdate();
    return removed;
  }

  /** ★ M5：清空 followUp 队列。返回被清除的消息文本列表。 */
  clearFollowUpQueue(): string[] {
    const removed = this.followUpQueue.splice(0).map((e) => e.text);
    if (removed.length > 0) this.emitQueueUpdate();
    return removed;
  }

  /** ★ M5：清空 steering + followUp 两个队列。
   *
   *  ★ abort 不调本方法（abort 后队列保留，让用户 abort 后继续追问）。
   *   只在显式 clear / dispose 时调。 */
  clearQueues(): { steering: string[]; followUp: string[] } {
    const result = {
      steering: this.steeringQueue.splice(0).map((e) => e.text),
      followUp: this.followUpQueue.splice(0).map((e) => e.text),
    };
    // ★ 验收修复：只有实际清除内容才 emit（与 clearSteeringQueue/clearFollowUpQueue 一致）
    if (result.steering.length > 0 || result.followUp.length > 0) {
      this.emitQueueUpdate();
    }
    return result;
  }

  /** ★ M5：发射 queue_update 事件（每次队列变化时调）。
   *
   *  只暴露 text（不暴露 images），与 LoopEvent.queue_update 契约一致。
   *  ★ 验收修复：每条 text 截断到 QUEUE_UPDATE_TEXT_TRUNCATE 字符（防大文本进事件流）。 */
  private emitQueueUpdate(): void {
    const truncate = (s: string): string =>
      s.length > QUEUE_UPDATE_TEXT_TRUNCATE
        ? s.slice(0, QUEUE_UPDATE_TEXT_TRUNCATE) + "..."
        : s;
    this.emit({
      type: "queue_update",
      steering: this.steeringQueue.map((e) => truncate(e.text)),
      followUp: this.followUpQueue.map((e) => truncate(e.text)),
    });
  }

  /** ★ M2：返回全部已注册工具的 name/description（给 get_state 命令用）。 */
  getAllTools(): { name: string; description: string }[] {
    return this.registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** ★ M2：返回当前激活工具名（白名单）。 */
  getActiveToolNames(): string[] {
    return this.registry.getActiveNames();
  }

  /** ★ M2：重设激活白名单（setActiveToolsByName 命令用）。 */
  setActiveToolsByName(names: string[]): void {
    this.registry.setActive(names);
  }

  /** ★ M6：打断压缩（abortCompaction 命令用）。幂等。 */
  abortCompaction(): void {
    if (this.compactionAbortController && !this.compactionAbortController.signal.aborted) {
      this.compactionAbortController.abort();
    }
  }

  /** ★ M6：返回真实的上下文用量估算（用于触发自动压缩 / get_state）。 */
  getContextUsage():
    | {
        percent: number | null;
        contextWindow: number;
        tokens: number | null;
      }
    | undefined {
    const contextWindow = this._model.contextWindow ?? 8192;
    const tokens = estimateTokens([
      ...this._messages,
      { role: "system", content: this._baseSystemPrompt } as unknown as AgentMessage,
    ]);
    const percent = tokens > 0 ? tokens / contextWindow : null;
    return { percent, contextWindow, tokens };
  }

  // -------------------------------------------------------------------------
  // 私有 helper
  // -------------------------------------------------------------------------

  /**
   * 发射一个 LoopEvent 给所有订阅者。
   * LoopEvent 结构兼容 Port 要求的 AgentSessionEvent，用类型断言桥接。
   */
  private emit(event: LoopEvent): void {
    const listeners = Array.from(this.listeners);
    for (const listener of listeners) {
      try {
        listener(event as unknown as AgentSessionEvent);
      } catch (err) {
        // 订阅者异常不能拖垮 loop。记录后继续。
        console.error("[DeerLoopEngine] subscribe listener threw:", err);
      }
    }
  }

  /** 构造 user message 的 content（文本 + 可选图片）。 */
  private buildUserContent(
    text: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): string | NonNullable<UserMessage["content"]> {
    if (!images || images.length === 0) {
      return text;
    }
    const parts: NonNullable<UserMessage["content"]> = [{ type: "text", text }];
    for (const img of images) {
      parts.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return parts;
  }

  /** 判断错误是否为 abort 导致（stream 中断后 next() 抛 AbortError）。 */
  private isAbortError(err: unknown): boolean {
    if (this.abortController?.signal.aborted) return true;
    if (err instanceof Error) {
      return err.name === "AbortError" || /abort/i.test(err.message);
    }
    return false;
  }

  /**
   * 计算本次上游请求的首事件（首 token）超时阈值。
   *
   * 按思考级别放大：普通模型 45s，high 90s，xhigh 120s。可被环境变量覆盖
   *（DEERHUX_LLM_TTFT_TIMEOUT_MS / _HIGH_MS / _XHIGH_MS，仅正整数生效）。
   * 仅用于上游中转站「HTTP 已建连但迟迟不发首事件」的排队场景；本地限流
   * 队列等待不受此值影响（acquireLlmPermit 用独立信号）。
   */
  private computeTtftTimeoutMs(): number {
    const readEnv = (name: string, fallback: number): number => {
      const raw = process.env[name];
      if (!raw) return fallback;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };
    const level = this._thinkingLevel;
    if (level === "xhigh") {
      return readEnv("DEERHUX_LLM_TTFT_TIMEOUT_XHIGH_MS", 120_000);
    }
    if (level === "high") {
      return readEnv("DEERHUX_LLM_TTFT_TIMEOUT_HIGH_MS", 90_000);
    }
    return readEnv("DEERHUX_LLM_TTFT_TIMEOUT_MS", 45_000);
  }

  /**
   * 计算 message_end 应使用的 AssistantMessage。
   *
   * 优先级：
   * 1. stream 的 done/error 事件携带的 message（finalMessage）
   * 2. 最后一次 partial（lastPartial）
   * 3. 合成空 AssistantMessage（极端情况：没收到任何 partial）
   *
   * abort 时强制覆盖 stopReason 为 "aborted"。
   */
  private resolveEndMessage(
    finalMessage: AssistantMessage | null,
    lastPartial: AssistantMessage | null,
    aborted: boolean,
    errorMessage: string | undefined,
  ): AssistantMessage {
    const base =
      finalMessage ??
      lastPartial ??
      this.synthesizeEmptyAssistantMessage(aborted ? "aborted" : "error", errorMessage);

    if (!aborted && base.stopReason !== "error" && !errorMessage) {
      return base;
    }

    // abort 或 error：覆盖 stopReason / errorMessage（不修改原对象）。
    return {
      ...base,
      stopReason: aborted ? "aborted" : errorMessage ? "error" : base.stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /** 合成一个空 AssistantMessage（stream 没收到任何 partial 时的兜底）。 */
  private synthesizeEmptyAssistantMessage(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: this._model.api,
      provider: this._model.provider,
      model: this._model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason,
      timestamp: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /** 等待 loop 进入 idle 态（_isRunning=false）。 */
  private async waitForIdle(): Promise<void> {
    // 简单轮询：每 10ms 检查一次，最多等 10s（避免死锁）。
    const deadline = Date.now() + 10_000;
    while (this._isRunning && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// ===========================================================================
// 默认 streamFn：委托给 pi-ai 的 streamSimple
// ===========================================================================

/**
 * 默认 StreamFn 实现：直接调 pi-ai 的 streamSimple。
 *
 * 拆成单独函数是为了：
 * 1. 延迟 import（避免模块加载时就拉起 pi-ai provider 注册）。
 * 2. 测试可注入 mock，绕过此默认实现。
 */
function defaultStreamFn(
  model: AnyModel,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // pi-ai 是 ESM-only，不能用 require()；这里用动态 import 包一层 async generator，
  // 既保持 StreamFn 的同步返回契约（返回 AsyncIterable），也避免 top-level provider 注册副作用。
  return (async function* streamFromPiAi() {
    const { streamSimple } = await import("@earendil-works/pi-ai");
    yield* streamSimple(model, context, options);
  })() as unknown as AssistantMessageEventStream;
}

// ===========================================================================
// 最小代理工厂（sessionManager / settingsManager）
// ===========================================================================

/**
 * 创建最小的 SessionManager 代理，满足 wrapper 构造与 get_state 的调用。
 *
 * DeerLoopEngine 不做 jsonl 持久化（M6 的事），所以 isPersisted 返回 false、
 * appendCustomEntry 返回占位 id。其他方法（getBranch/createBranchedSession 等）
 * 在被调时 throw——M1 灰度路径不会触碰它们。
 */
function createMinimalSessionManager(
  cwd: string,
): import("@earendil-works/pi-coding-agent").SessionManager {
  const minimal = {
    getCwd: () => cwd,
    isPersisted: () => false,
    appendCustomEntry: (_customType: string, _data?: unknown) =>
      `deer-loop-custom-${Date.now()}`,
    getBranch: () => [] as unknown[],
    getSessionFile: () => undefined,
  };
  // 用 Proxy 把未实现的方法统一转成 throw，避免返回一个"看起来完整"的假对象。
  return new Proxy(minimal, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // 访问任何未实现的方法/属性时返回一个 throw 函数（兼容方法调用）或 throw。
      throw new Error(
        `DeerLoopEngine.sessionManager.${String(prop)}: not implemented in M1 (see M6 / SessionStore)`,
      );
    },
  }) as unknown as import("@earendil-works/pi-coding-agent").SessionManager;
}

/**
 * 创建最小的 SettingsManager 代理。
 * M1 灰度不读 settings；提供默认值满足 Port 类型。
 */
function createMinimalSettingsManager(): import("@earendil-works/pi-coding-agent").SettingsManager {
  const minimal = {
    getCompactionSettings: () => ({ threshold: 0.5, autoCompact: false }),
    getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 5000 }),
  };
  return new Proxy(minimal, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      throw new Error(
        `DeerLoopEngine.settingsManager.${String(prop)}: not implemented in M1`,
      );
    },
  }) as unknown as import("@earendil-works/pi-coding-agent").SettingsManager;
}
