import { NextResponse } from "next/server";
import { createRole, readRoles } from "@/lib/roles";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  return NextResponse.json({ roles: readRoles(cwd) });
}

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd");
    const body = await req.json() as { name?: string; description?: string; basePrompt?: string; scope?: "user" | "project" };
    if (!body.name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
    return NextResponse.json({ role: createRole({ name: body.name, description: body.description, basePrompt: body.basePrompt, scope: body.scope, cwd }) });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
