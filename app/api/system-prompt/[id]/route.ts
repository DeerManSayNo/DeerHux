import { NextResponse } from "next/server";
import {
  readVersions,
  updateVersion,
  deleteVersion,
} from "@/lib/system-prompt-decomposer";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const version = updateVersion(id, body);
    if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
    return NextResponse.json({ version });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ok = deleteVersion(id);
  return NextResponse.json({ ok, versions: readVersions() }, { status: ok ? 200 : 400 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const versions = readVersions();
  const version = versions.find((v) => v.id === id);
  if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  return NextResponse.json({ version });
}
