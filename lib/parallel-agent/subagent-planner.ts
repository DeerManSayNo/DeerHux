import type {
  CollaborationRunMode,
  CollaborationWorkerSpec,
  SubagentRunPlacement,
  SubagentTaskMode,
  SubagentWorkflow,
} from "./collaboration-types";

export interface SubagentPlan {
  title: string;
  message: string;
  mode: CollaborationRunMode;
  taskMode: SubagentTaskMode;
  runPlacement: SubagentRunPlacement;
  workflow: SubagentWorkflow;
  workers: CollaborationWorkerSpec[];
}

export const MAX_WORKERS_PER_RUN = 5;

export function planSubagentTask(params: {
  message: string;
  taskMode?: SubagentTaskMode;
  placement?: SubagentRunPlacement;
  workflow?: SubagentWorkflow;
  workers?: CollaborationWorkerSpec[];
}): SubagentPlan {
  const message = params.message.trim();
  const taskMode = params.taskMode ?? inferTaskMode(message);
  const mode: CollaborationRunMode = taskMode === "code" || taskMode === "parallel" ? "isolated_coding" : "analysis";
  const workflow = params.workflow ?? inferWorkflow(taskMode, message);
  const workers = normalizeWorkers(params.workers, taskMode, message, workflow);
  return {
    title: buildTitle(message, taskMode),
    message,
    mode,
    taskMode,
    runPlacement: params.placement ?? "foreground",
    workflow,
    workers,
  };
}

function inferTaskMode(message: string): SubagentTaskMode {
  if (/review|审查|安全|security/i.test(message)) return "review";
  if (/并行|parallel|多个|multi|方案|attempt/i.test(message)) return "parallel";
  if (/实现|修改|修复|code|implement|fix/i.test(message)) return "code";
  return "ask";
}

/**
 * 根据任务模式推断默认编排模式。LLM planner 可显式覆盖。
 *
 * - parallel（多方案对比）：worker 间并行 → "parallel"
 * - review（审查）：单 worker，并行无意义 → "parallel"（单 worker 并行=顺序）
 * - ask/code：单 worker → "parallel"（单 worker 等价顺序）
 *
 * 多 worker 且有上下游依赖（如「先调研再实现」）的场景由 LLM planner 显式声明
 * sequential/pipeline；正则 fallback 无法识别，默认 parallel 保证向后兼容。
 */
function inferWorkflow(taskMode: SubagentTaskMode, _message: string): SubagentWorkflow {
  if (taskMode === "parallel") return "parallel";
  // 单 worker 任务并行=顺序，无实质区别；保持 parallel 以兼容旧 Promise.all 路径。
  return "parallel";
}

function normalizeWorkers(workers: CollaborationWorkerSpec[] | undefined, taskMode: SubagentTaskMode, message: string, workflow: SubagentWorkflow): CollaborationWorkerSpec[] {
  const explicit = workers?.map((worker) => ({
    name: worker.name.trim(),
    task: worker.task.trim(),
    ...(worker.dependsOn?.length ? { dependsOn: worker.dependsOn.map((d) => d.trim()).filter(Boolean) } : {}),
  })).filter((worker) => worker.name && worker.task);
  if (explicit?.length) {
    // pipeline/sequential 且 worker 未声明依赖时，按声明顺序自动连成链，
    // 让调度层能把前一个 worker 的结论注入后一个的 prompt。
    if ((workflow === "pipeline" || workflow === "sequential") && explicit.length > 1) {
      return explicit.map((worker, index) => {
        if (worker.dependsOn?.length) return worker;
        const prev = explicit[index - 1];
        return prev ? { ...worker, dependsOn: [prev.name] } : worker;
      }).slice(0, MAX_WORKERS_PER_RUN);
    }
    return explicit.slice(0, MAX_WORKERS_PER_RUN);
  }

  if (taskMode === "parallel") {
    return [
      { name: "方案 A", task: `独立尝试完成目标，优先选择最小可行改动。\n\n目标：${message}` },
      { name: "方案 B", task: `独立尝试完成目标，可以采用不同实现路径，并说明取舍。\n\n目标：${message}` },
      { name: "方案 C", task: `独立尝试完成目标，重点关注稳定性、测试和回归风险。\n\n目标：${message}` },
      { name: "方案 D", task: `独立尝试完成目标，重点关注边界条件、异常路径和长期维护成本。\n\n目标：${message}` },
      { name: "方案 E", task: `独立尝试完成目标，从更激进或不同抽象层次的实现路径出发，并说明风险。\n\n目标：${message}` },
    ];
  }
  if (taskMode === "review") {
    if (/安全|security/i.test(message)) {
      return [{ name: "Security Review Agent", task: `以安全审查视角检查当前目标相关改动，优先指出权限、注入、数据泄露、凭据、供应链和滥用风险。只报告有证据的问题和必要的验证建议。\n\n目标：${message}` }];
    }
    if (/\bci\b|构建|测试失败|check|workflow|pipeline/i.test(message)) {
      return [{ name: "CI Investigator", task: `调查当前目标相关的 CI、构建或测试失败，定位最可能根因，给出复现路径和最小修复建议。不要修改文件。\n\n目标：${message}` }];
    }
    return [{ name: "Code Review Agent", task: `审查当前目标相关改动，优先指出 bug、行为回归、风险和测试缺口。只列出有实际影响的问题。\n\n目标：${message}` }];
  }
  if (taskMode === "code") {
    return [{ name: "Coding Agent", task: `在隔离环境中实现目标，完成后总结变更与验证建议。\n\n目标：${message}` }];
  }
  return [{ name: "Research Agent", task: `只读调研并给出结论、证据和建议。\n\n目标：${message}` }];
}

function buildTitle(message: string, taskMode: SubagentTaskMode): string {
  const label: Record<SubagentTaskMode, string> = {
    ask: "Ask",
    code: "Code",
    parallel: "Parallel Attempts",
    review: "Review",
    custom: "Custom",
  };
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine ? `${label[taskMode]}: ${oneLine.slice(0, 42)}` : label[taskMode];
}
