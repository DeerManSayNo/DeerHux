/**
 * LLM-driven subagent task planner.
 *
 * 用一次轻量 LLM 调用把用户的自然语言 message 规划成结构化 plan：
 *   - taskMode（隔离方式：ask 只读 / code 隔离编码 / parallel 多方案 / review 审查）
 *   - workflow（worker 间时序：parallel 并行 / sequential 逐次 / pipeline 链式）
 *   - workers（按真实需求动态拆分，含 dependsOn 依赖链）
 *
 * 对比 subagent-planner.ts 的正则推断：正则只能靠关键词命中 4 种 mode 且 worker
 * 是死模板；LLM 能理解「先调研再实现再审查」这类隐含 pipeline 语义并动态拆 worker。
 *
 * 降级策略（关键）：任何 LLM 失败（无 model / 超时 / 空响应 / JSON 解析失败）都
 * 透明回退到正则 planner，绝不中断主流程。用户显式指定的字段（taskMode/workflow/
 * workers）永远优先，不被 LLM 覆盖。
 */
import { callLlmForText } from "./llm-call";
import { MAX_WORKERS_PER_RUN, planSubagentTask, type SubagentPlan } from "./subagent-planner";
import type {
  CollaborationWorkerSpec,
  SubagentRunPlacement,
  SubagentTaskMode,
  SubagentWorkflow,
} from "./collaboration-types";

export interface LlmPlanOptions {
  message: string;
  model?: { provider: string; modelId: string };
  /** 用户显式指定的字段优先，不交 LLM 推断。 */
  taskMode?: SubagentTaskMode;
  workflow?: SubagentWorkflow;
  workers?: CollaborationWorkerSpec[];
  placement?: SubagentRunPlacement;
  /** LLM 调用超时，默认 30s。 */
  timeoutMs?: number;
}

/**
 * 规划 subagent 任务：优先 LLM 智能规划，失败回退正则。
 *
 * 何时跳过 LLM（直接走正则）：
 * 1. 没有可用 model（parentModel 缺失）。
 * 2. taskMode + workflow + workers 三者全部已被显式指定（无需推断）。
 */
export async function planSubagentTaskWithLlm(options: LlmPlanOptions): Promise<SubagentPlan> {
  const allSpecified = options.taskMode && options.workflow && options.workers;
  const canUseLlm = Boolean(options.model) && !allSpecified;

  if (canUseLlm) {
    const llmResult = await tryLlmPlan(options).catch(() => null);
    if (llmResult) return llmResult;
  }

  // 正则 fallback（用户显式字段会透传进去，保证不被丢弃）。
  return planSubagentTask({
    message: options.message,
    taskMode: options.taskMode,
    placement: options.placement,
    workflow: options.workflow,
    workers: options.workers,
  });
}

/** LLM 规划核心：调一次 LLM，解析 JSON，校验合并。失败返回 null。 */
async function tryLlmPlan(options: LlmPlanOptions): Promise<SubagentPlan | null> {
  if (!options.model) return null;
  const raw = await callLlmForText({
    model: options.model,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt: buildPlannerUserPrompt(options),
    timeoutMs: options.timeoutMs,
    requestKind: "planner",
  });
  if (!raw) return null;
  const parsed = parsePlanJson(raw);
  if (!parsed) return null;

  // 用户显式字段永远优先。
  const taskMode = options.taskMode ?? parsed.taskMode;
  const workflow = options.workflow ?? parsed.workflow;
  const workers = options.workers ?? parsed.workers;

  // 用正则 planner 收口（它负责 mode 推断、worker 默认模板、dependsOn 链补全、title）。
  return planSubagentTask({
    message: options.message,
    taskMode,
    placement: options.placement,
    workflow,
    workers,
  });
}

const PLANNER_SYSTEM_PROMPT = [
  "你是一个 Agent 任务编排专家。给定一个用户目标，你要决定如何把它拆分成子 agent（subagent）任务。",
  "",
  "你需要输出一个 JSON 对象，字段如下：",
  '- "taskMode": 子任务类型，取值 "ask"（只读调研，不改代码）| "code"（隔离环境编码改代码，产出 diff）| "parallel"（多个独立方案并行尝试同一目标）| "review"（专门审查代码/安全/CI）。',
  '- "workflow": worker 之间的调度时序，取值 "parallel"（全部同时跑，互不可见）| "sequential"（逐个跑，后一个能看到前一个的结论）| "pipeline"（链式流水线，前一步产出喂给下一步，适合 调研→实现→审查 这类有上下游依赖的流程）。',
  '- "workers": 数组，每个元素 { "name": 短标签, "task": 自包含的子任务指令(含目标和约束), "dependsOn": [前置worker的name]（仅 pipeline/sequential 多 worker 时需要）}。',
  '- "reasoning": 一句话说明你为什么这样拆（中文）。',
  "",
  "决策规则：",
  "1. 简单查询/单次调研/单点修改不要拆成多 worker，用一个 worker 即可。",
  "2. 目标里含「先…再…」「调研后实现」「实现后审查」等上下游语义时，用 pipeline 并按顺序给 worker 加 dependsOn 链。",
  "3. 目标里含「对比/多个方案/并行尝试」时用 parallel，每个 worker 独立尝试同一目标。",
  `4. workers 数量 1~${MAX_WORKERS_PER_RUN} 个，每个 task 要自包含（subagent 不共享主对话上下文）。`,
  "5. 只输出 JSON，不要 markdown 代码块、不要多余解释。",
].join("\n");

function buildPlannerUserPrompt(options: LlmPlanOptions): string {
  const hints: string[] = [];
  if (options.taskMode) hints.push(`用户已显式指定 taskMode=${options.taskMode}，请沿用。`);
  if (options.workflow) hints.push(`用户已显式指定 workflow=${options.workflow}，请沿用。`);
  if (options.workers?.length) hints.push(`用户已显式指定 workers，请沿用，不要重新拆分。`);
  const hintLine = hints.length ? `\n\n约束：\n${hints.join("\n")}` : "";
  return `请为以下目标规划 subagent 任务，只输出 JSON：\n\n目标：${options.message.trim()}${hintLine}`;
}

interface ParsedPlan {
  taskMode?: SubagentTaskMode;
  workflow?: SubagentWorkflow;
  workers?: CollaborationWorkerSpec[];
}

/** 从 LLM 文本里提取并校验 JSON plan。非法返回 null。 */
function parsePlanJson(raw: string): ParsedPlan | null {
  const jsonText = extractJsonBlock(raw);
  if (!jsonText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;

  const taskMode = normalizeTaskMode(record.taskMode);
  const workflow = normalizeWorkflow(record.workflow);
  const workers = normalizeWorkers(record.workers);

  // 至少要给出 taskMode 或 workers 才算有效（否则不如直接走正则）。
  if (!taskMode && !workers?.length) return null;

  return {
    taskMode,
    workflow,
    workers,
  };
}

/** 容错提取 JSON：LLM 可能把 JSON 包在 ```json fence 或附带文字。 */
function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  // 直接是 JSON。
  if (trimmed.startsWith("{")) return trimmed;
  // ```json ... ``` 包裹。
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  // 退化：找第一个 { 到最后一个 }。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function normalizeTaskMode(value: unknown): SubagentTaskMode | undefined {
  return value === "ask" || value === "code" || value === "parallel" || value === "review" ? value : undefined;
}

function normalizeWorkflow(value: unknown): SubagentWorkflow | undefined {
  return value === "parallel" || value === "sequential" || value === "pipeline" || value === "dag" ? value : undefined;
}

function normalizeWorkers(value: unknown): CollaborationWorkerSpec[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const workers: CollaborationWorkerSpec[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; task?: unknown; dependsOn?: unknown };
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    if (typeof record.task !== "string" || !record.task.trim()) continue;
    const dependsOn = Array.isArray(record.dependsOn)
      ? record.dependsOn.map((d) => (typeof d === "string" ? d.trim() : "")).filter(Boolean)
      : [];
    workers.push({ name: record.name.trim(), task: record.task.trim(), ...(dependsOn.length ? { dependsOn } : {}) });
    if (workers.length >= MAX_WORKERS_PER_RUN) break;
  }
  return workers.length > 0 ? workers : undefined;
}
