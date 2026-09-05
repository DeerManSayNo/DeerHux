import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  abortCollaborationRun,
  getCollaborationRun,
  startCollaborationRun,
  subscribeCollaborationRun,
} from "./collaboration-orchestrator";
import type { CollaborationRunState, CollaborationWorkerState, SubagentTaskMode, SubagentWorkflow } from "./collaboration-types";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isSubagentConcurrencyLimitError, SUBAGENT_TOOL_NAME } from "./subagent-concurrency";
import { MAX_WORKERS_PER_RUN } from "./subagent-planner";
import { waitForForegroundRun } from "./foreground-run-wait";

export { SUBAGENT_TOOL_NAME };

export interface CreateSubagentToolOptions {
  /** Resolved at execution time so the tool can attach the run to its parent session. */
  getParentSessionId?: () => string | undefined;
  /** Optional parent entry id (e.g. the current tool-call turn). */
  getParentEntryId?: () => string | undefined;
  /** Resolved at execution time so worker sessions inherit the parent's model.
   *  Without this, workers fall back to modelRegistry's first available model,
   *  which is often a different (and possibly broken) model than the parent. */
  getParentModel?: () => { provider: string; modelId: string } | undefined;
}

/**
 * A tool that lets the main agent delegate a self-contained sub-task to one or
 * more isolated sub-agents. Backed by the collaboration orchestrator: workers
 * run their own agent sessions in parallel.
 *
 * The tool is always registered (so it can be toggled active at runtime), but
 * whether it appears in the agent's active tool set is controlled by the
 * `set_subagent_enabled` command on AgentSessionWrapper.
 */
export function createSubagentTool(cwd: string, options: CreateSubagentToolOptions = {}) {
  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description: "Delegate a focused, self-contained task to isolated subagents for parallel alternatives, scoped coding, or review/research. Use direct tools for simple lookups or quick edits. Workers do not share this conversation; include all required context.",
    promptSnippet: "subagent: Delegate a focused task to isolated subagents for parallel alternatives, scoped coding, or review/research.",
    parameters: Type.Object({
      message: Type.String({
        description: "Complete, self-contained instructions for the workers. Include the goal, relevant context, constraints, and expected output; workers do not share this conversation.",
      }),
      mode: Type.Optional(Type.Union(
        [
          Type.Literal("ask"),
          Type.Literal("code"),
          Type.Literal("parallel"),
          Type.Literal("review"),
        ],
        { description: "ask = read-only research; code = isolated coding with diff; parallel = multiple independent attempts (default 3); review = dedicated review pass. Omit to auto-infer." },
      )),
      workflow: Type.Optional(Type.Union(
        [
          Type.Literal("parallel"),
          Type.Literal("sequential"),
          Type.Literal("pipeline"),
        ],
        { description: "How workers are scheduled. parallel = all at once (default). sequential = one after another, each sees prior workers' conclusions. pipeline = chained, prior output feeds next (for 调研→实现→审查 flows). Omit to auto-infer." },
      )),
      workers: Type.Optional(Type.Array(
        Type.Object({
          name: Type.String({ description: "Short label for the worker, e.g. '方案 A' / 'Security Review'." }),
          task: Type.String({ description: "Self-contained instructions for this worker. Include the goal and any constraints." }),
          dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Names of prior workers this one depends on (pipeline/sequential). Omit to infer sequential order." })),
        }),
        { description: `Custom worker breakdown. Maximum ${MAX_WORKERS_PER_RUN} workers. Omit to let the planner auto-build workers from the mode.` },
      )),
    }),
    executionMode: "parallel" as const,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      signal?.throwIfAborted();
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        return {
          content: [{ type: "text" as const, text: "subagent error: `message` is required." }],
          details: undefined,
        };
      }
      const taskMode = (params.mode as SubagentTaskMode | undefined) ?? undefined;
      const workflow = (params.workflow as SubagentWorkflow | undefined) ?? undefined;
      if (Array.isArray(params.workers) && params.workers.length > MAX_WORKERS_PER_RUN) {
        return {
          content: [{
            type: "text" as const,
            text: `subagent error: too many workers (${params.workers.length}). Maximum allowed is ${MAX_WORKERS_PER_RUN}.`,
          }],
          details: { maxWorkers: MAX_WORKERS_PER_RUN, requestedWorkers: params.workers.length },
          isError: true,
        };
      }
      const workers = Array.isArray(params.workers)
        ? params.workers
            .map((w) => ({
              name: typeof w?.name === "string" ? w.name.trim() : "",
              task: typeof w?.task === "string" ? w.task.trim() : "",
              ...(Array.isArray(w?.dependsOn) && w.dependsOn.length
                ? { dependsOn: w.dependsOn.map((d: unknown) => (typeof d === "string" ? d.trim() : "")).filter(Boolean) }
                : {}),
            }))
            .filter((w) => w.name && w.task)
        : undefined;

      let state: CollaborationRunState;
      try {
        state = await startCollaborationRun({
          cwd,
          message,
          taskMode,
          workflow,
          runPlacement: "foreground",
          workers,
          parentSessionId: options.getParentSessionId?.(),
          parentEntryId: options.getParentEntryId?.(),
          parentModel: options.getParentModel?.(),
        });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        const details = isSubagentConcurrencyLimitError(error) ? error.details : undefined;
        return {
          content: [{ type: "text" as const, text: `subagent failed to start: ${err}` }],
          details,
          isError: true,
        };
      }

      // ★ 流式进度：订阅 collaboration run 事件，通过 onUpdate 推送给主 Agent
      //   每次 worker 状态变化 / 工具活动更新时，发射 tool_execution_update 事件。
      const runId = state.runId;
      const finalState = await waitForForegroundRun({
        runId,
        signal,
        getRun: getCollaborationRun,
        subscribe: subscribeCollaborationRun,
        abortRun: abortCollaborationRun,
        onProgress: (_event, latest) => {
          if (onUpdate) onUpdate(buildProgressPartial(runId, latest));
        },
      });

      // 终态时推送最后一次完整进度，确保主 Agent 看到最终 worker 状态
      if (onUpdate) {
        onUpdate(buildProgressPartial(runId, finalState));
      }

      const isError = finalState.status === "error" || finalState.status === "aborted";
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(finalState) }],
        details: { runId: finalState.runId, status: finalState.status },
        isError,
      };
    },
  });
}

/**
 * 从 CollaborationRunState 构建用于 tool_execution_update 的进度快照。
 * 只包含前端渲染需要的字段，避免传输大量文本。
 */
export type SubagentProgressDetails = {
  runId: string;
  status: string;
  workers: Array<{
    name: string;
    status: string;
    activeTool?: { toolName: string; summary: string };
    recentTools?: Array<{ toolName: string; summary: string; status: string }>;
  }>;
};

function buildProgressPartial(
  runId: string,
  run: CollaborationRunState,
): AgentToolResult<SubagentProgressDetails> {
  const result: AgentToolResult<SubagentProgressDetails> = {
    content: [{
      type: "text" as const,
      text: `Subagent「${run.title ?? runId}」running — ${run.workers.filter((w) => w.status === "complete").length}/${run.workers.length} workers done`,
    }],
    details: {
      runId: run.runId,
      status: run.status,
      workers: run.workers.map((w) => ({
        name: w.name,
        status: w.status,
        ...(w.activeTool ? {
          activeTool: {
            toolName: w.activeTool.toolName,
            summary: w.activeTool.summary,
          },
        } : {}),
        ...(w.recentTools?.length ? {
          recentTools: w.recentTools.slice(0, 4).map((t) => ({
            toolName: t.toolName,
            summary: t.summary,
            status: t.status,
          })),
        } : {}),
      })),
    },
  };
  return result;
}

function formatSubagentResult(run: CollaborationRunState): string {
  const header = `Subagent task「${run.title ?? run.runId}」finished — mode: ${run.taskMode ?? run.mode}, status: ${run.status}.`;
  const parts: string[] = [header, ""];

  for (const worker of run.workers) {
    parts.push(formatWorker(worker));
    parts.push("");
  }

  if (run.summary?.trim()) {
    parts.push("## Aggregated summary");
    parts.push(run.summary.trim());
  }

  if (run.error) {
    parts.push("");
    parts.push(`Task error: ${run.error}`);
  }

  parts.push("");
  parts.push(
    run.mode === "isolated_coding"
      ? "Coding workers produced diffs in isolated worktrees. Ask the user to review/apply them from the collaboration card if needed."
      : "Workers were read-only.",
  );

  return parts.join("\n").trim();
}

function formatWorker(worker: CollaborationWorkerState): string {
  const title = worker.title ?? worker.name;
  const lines: string[] = [`## ${title} (${worker.status})`];
  if (worker.error) {
    lines.push(`Error: ${worker.error}`);
  }
  if (worker.result?.trim()) {
    lines.push(worker.result.trim());
  }
  if (worker.diffStats?.trim()) {
    lines.push("");
    lines.push("Changed files:");
    lines.push(worker.diffStats.trim());
  }
  return lines.join("\n");
}
