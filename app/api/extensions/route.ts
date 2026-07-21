import { NextResponse } from "next/server";
import { loadExtensionsView } from "@/lib/extensions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const includeMcpRuntimeStatus = searchParams.get("mcpRuntime") === "1" || searchParams.get("mcpRuntime") === "true";
  if (!cwd?.trim()) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    return NextResponse.json(await loadExtensionsView(cwd, { includeMcpRuntimeStatus }));
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
