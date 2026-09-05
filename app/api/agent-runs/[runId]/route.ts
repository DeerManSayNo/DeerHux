import { NextResponse } from "next/server";
import { getCollaborationRun } from "@/lib/parallel-agent/collaboration-orchestrator";
import { sanitizeCollaborationRun } from "@/lib/parallel-agent/collaboration-sanitize";
import { abortCollaborationRun, removeCollaborationRun } from "@/lib/parallel-agent/collaboration-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/agent-runs/[runId]
 * 获取单个 collaboration run 的脱敏快照（剥离 worker sessionId / worktreePath）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(sanitizeCollaborationRun(state), { headers: { "Cache-Control": "no-store" } });
}

/**
 * DELETE /api/agent-runs/[runId]
 * 放弃并回收一个 collaboration run：全量释放 worktree + worker sessions + 内存 Map
 * 条目 + 磁盘 jsonl。用于前端「放弃」按钮，或清理 apply 失败 / 用户不再处理的孤立 run。
 *
 * 对仍处于运行态的 run 会先 abort（停 workers + 清 worktree），再 remove；对已终结
 * 的 run 直接 remove。重复调用幂等（removeCollaborationRun 对不存在的 run 是 no-op）。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const state = getCollaborationRun(runId);
  if (!state) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (state.mode === "isolated_coding") {
    return NextResponse.json({ error: "Isolated runs require the confirmation-based discard API" }, { status: 409 });
  }
  // 仍运行中的 run 先停 workers，避免 remove 后后台 Promise.all 继续写已删除的 state。
  if (state.status === "running" || state.status === "setting_up" || state.status === "applying") {
    await abortCollaborationRun(runId).catch(() => {});
  }
  await removeCollaborationRun(runId);
  return NextResponse.json({ ok: true });
}
