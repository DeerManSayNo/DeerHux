import { NextResponse } from "next/server";
import { ROLE_BLOCKS, addRoleSetting, type RoleBlock } from "@/lib/roles";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd");
    const body = await req.json() as { block?: RoleBlock; text?: string };
    if (!body.text?.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
    const block = ROLE_BLOCKS.includes(body.block as RoleBlock) ? body.block as RoleBlock : "Rules";
    const setting = addRoleSetting(id, block, body.text, cwd);
    if (!setting) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    return NextResponse.json({ setting });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
