import { NextResponse } from "next/server";
import { getWorktreeRollout } from "@/lib/parallel-agent/worktree-rollout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ worktrees: getWorktreeRollout() }, { headers: { "Cache-Control": "no-store" } });
}
