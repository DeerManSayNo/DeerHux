import { NextResponse } from "next/server";
import { readMcpServers, writeMcpServers } from "@/lib/mcp-config";
import { reloadMcpForIdleSessions } from "@/lib/rpc-manager";

export async function GET() {
  return NextResponse.json({ servers: readMcpServers() });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { servers?: unknown };
    if (!Array.isArray(body.servers)) return NextResponse.json({ error: "servers must be an array" }, { status: 400 });
    const servers = writeMcpServers(body.servers as never[]);
    const reloadResults = await reloadMcpForIdleSessions();
    return NextResponse.json({ servers, reloadResults });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
