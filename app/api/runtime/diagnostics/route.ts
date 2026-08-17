import { NextResponse } from "next/server";
import { getAgentEventStore } from "@/lib/agent-runtime/event-store";
import { getTransportDiagnostics } from "@/lib/agent-runtime/transport-diagnostics";
import { getRpcRuntimeDiagnostics } from "@/lib/rpc-manager";
import { getSessionFileCacheDiagnostics } from "@/lib/session-reader";
import { getMcpProcessDiagnostics } from "@/lib/mcp-runtime";
import { getEventLoopDiagnostics } from "@/lib/agent-runtime/event-loop-diagnostics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const memory = process.memoryUsage();
  return NextResponse.json({
    timestamp: Date.now(),
    process: {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    eventLoop: getEventLoopDiagnostics(),
    sessions: getRpcRuntimeDiagnostics(),
    journal: getAgentEventStore().diagnostics(),
    sessionCache: getSessionFileCacheDiagnostics(),
    transport: getTransportDiagnostics(),
    mcp: getMcpProcessDiagnostics(),
  });
}
