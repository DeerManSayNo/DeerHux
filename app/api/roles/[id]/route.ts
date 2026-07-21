import { NextResponse } from "next/server";
import { deleteRole, moveRole, readRoles, updateRole } from "@/lib/roles";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get("cwd");
    const body = await req.json();
    const wantsMove = (body.scope === "user" || body.scope === "project") && (body.moveRole === true || body.scopeTarget === true);
    if (wantsMove) {
      // fromCwd explicitly null → global role (search only global file).
      // fromCwd set to a string → project role (search that project file first, then global).
      // fromCwd not in body → fall back to URL cwd (legacy behavior).
      const searchCwd = "fromCwd" in body ? (body.fromCwd as string | null) : cwd;
      const updated = updateRole(id, { name: body.name, description: body.description, basePrompt: body.basePrompt, blocks: body.blocks }, searchCwd);
      if (!updated) return NextResponse.json({ error: "Role not found" }, { status: 404 });
      const moved = moveRole(id, { scope: body.scope, cwd: (body.cwd as string) ?? cwd, fromCwd: searchCwd });
      if (!moved) return NextResponse.json({ error: "Role cannot be moved" }, { status: 400 });
      return NextResponse.json({ role: moved });
    }
    const role = updateRole(id, body, cwd);
    if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
    return NextResponse.json({ role });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  const ok = deleteRole(id, cwd);
  return NextResponse.json({ ok, roles: readRoles(cwd) }, { status: ok ? 200 : 400 });
}
