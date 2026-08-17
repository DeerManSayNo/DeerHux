import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const stat = statSync(filePath);
    return NextResponse.json({ mtimeMs: stat.mtimeMs, size: stat.size });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
