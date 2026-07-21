import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { createMcpRuntimeFromServers } from "@/lib/mcp-runtime";
import type { McpServerConfig } from "@/lib/mcp-config";

export async function POST(req: Request) {
  let runtime: Awaited<ReturnType<typeof createMcpRuntimeFromServers>> | null = null;
  try {
    const body = await req.json() as { cwd?: unknown; servers?: unknown };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
    if (!existsSync(cwd)) return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    if (!Array.isArray(body.servers)) return NextResponse.json({ error: "servers must be an array" }, { status: 400 });

    runtime = await createMcpRuntimeFromServers(cwd, body.servers as Partial<McpServerConfig>[]);
    return NextResponse.json({
      statuses: runtime.serverStatuses,
      toolNames: runtime.toolNames,
      toolCount: runtime.toolNames.length,
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    runtime?.close();
  }
}
