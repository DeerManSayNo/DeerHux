/**
 * LLM-driven subagent result aggregator.
 *
 * 当一个 subagent run 有多个 worker 完成（尤其 parallel 多方案对比、review 多视角），
 * 用一次轻量 LLM 调用把各 worker 的结论/diff 综合成一份对比综述 + 推荐，替换
 * subagent-aggregator.ts 的静态文本拼接 +「最小 diff = 推荐」启发式。
 *
 * 对比静态聚合（buildSubagentSummary）：
 * - 静态：纯字符串拼接，推荐 = diff 行数最少（常误导：最小可能意味着没覆盖边界）。
 * - LLM：真正读懂各方案差异，给出有依据的推荐和风险提示。
 *
 * 降级策略（关键）：无 model / 单 worker / 超时 / 失败 → 透明回退 buildSubagentSummary。
 */
import { buildSubagentSummary } from "./subagent-aggregator";
import { callLlmForText } from "./llm-call";
import type { CollaborationRunState } from "./collaboration-types";

export interface AggregateOptions {
  model?: { provider: string; modelId: string };
  /** LLM 调用超时，默认 30s。 */
  timeoutMs?: number;
}

/**
 * 聚合 subagent run 的结果：优先 LLM 综述，失败回退静态拼接。
 *
 * 触发 LLM 聚合的条件（全部满足）：
 * 1. 有可用 model。
 * 2. 有 ≥2 个 completed worker（单 worker 无需综合）。
 * 否则直接用静态聚合。
 */
export async function aggregateSubagentResults(run: CollaborationRunState, options: AggregateOptions = {}): Promise<string> {
  const completed = run.workers.filter((worker) => worker.status === "complete");
  const canAggregate = Boolean(options.model) && completed.length >= 2;

  if (canAggregate) {
    const llmSummary = await tryLlmAggregate(run, completed, options).catch(() => null);
    if (llmSummary) return llmSummary;
  }

  return buildSubagentSummary(run);
}

/** LLM 聚合核心：调一次 LLM 综述，返回 markdown 文本。失败返回 null。 */
async function tryLlmAggregate(
  run: CollaborationRunState,
  completed: CollaborationRunState["workers"],
  options: AggregateOptions,
): Promise<string | null> {
  if (!options.model) return null;
  const raw = await callLlmForText({
    model: options.model,
    systemPrompt: AGGREGATOR_SYSTEM_PROMPT,
    userPrompt: buildAggregatorUserPrompt(run, completed),
    timeoutMs: options.timeoutMs,
    requestKind: "aggregator",
  });
  if (!raw) return null;
  // 补一个标题头，让前端展示一致。
  return `## ${run.title ?? "Subagent 任务综合结论"}\n\n（由 LLM 综合 ${completed.length} 个子 Agent 的结果）\n\n${raw.trim()}`;
}

const AGGREGATOR_SYSTEM_PROMPT = [
  "你是一个 Agent 结果综合专家。多个子 Agent（subagent）各自独立完成了一个总目标的某个子任务，",
  "现在你要把它们的结论综合成一份给主 Agent 和用户看的综述。",
  "",
  "输出要求（markdown）：",
  "1. 先给一段「总体结论」，提炼共识和最终建议。",
  "2. 如果是多个方案对比（parallel），给「方案对比」表或列表，点明各方案的关键差异、优势和风险，并在末尾给出「推荐方案」及理由（推荐标准是「最契合目标且风险可控」，不是改动最少）。",
  "3. 如果不同 worker 有冲突或矛盾的结论，明确指出并说明应采信哪个、为什么。",
  "4. 如果有 worker 失败，简要说明失败项。",
  "5. 结尾给「下一步建议」：主 Agent 或用户接下来该做什么。",
  "6. 简洁，避免逐字复述每个 worker 的原文；重点是综合、对比、去重、提结论。",
].join("\n");

function buildAggregatorUserPrompt(run: CollaborationRunState, completed: CollaborationRunState["workers"]): string {
  const sections: string[] = [];
  sections.push(`# 总目标\n${run.message.trim()}`);
  sections.push(`# 任务模式\n${run.taskMode ?? run.mode}（编排：${run.workflow ?? "parallel"}）`);

  sections.push("# 各子 Agent 的结果");
  for (const worker of completed) {
    const parts: string[] = [`## ${worker.name}`];
    parts.push(`任务：${worker.task}`);
    if (worker.result?.trim()) {
      // 截断超长结果，避免上下文爆炸（单 worker 最多 10000 字符）。
      parts.push("结论：");
      parts.push(truncate(worker.result.trim(), 10000));
    }
    if (worker.diffStats?.trim()) {
      parts.push(`变更概览：\n${worker.diffStats.trim()}`);
    }
    sections.push(parts.join("\n"));
  }

  const failed = run.workers.filter((worker) => worker.status === "error");
  if (failed.length > 0) {
    sections.push("# 失败的子 Agent");
    for (const worker of failed) {
      sections.push(`- ${worker.name}: ${worker.error ?? "Unknown error"}`);
    }
  }

  sections.push("# 请输出综合综述（markdown）");
  return sections.join("\n\n");
}

/** 截断文本到 maxChars，保留完整性（末尾加省略提示）。 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…（已截断，原文 ${text.length} 字符）`;
}
