import { NextResponse } from "next/server";
import { readGlobalMemory, writeGlobalMemory } from "@/lib/memory";

export async function GET() {
  return NextResponse.json({ global: readGlobalMemory() });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as { global?: unknown };
    if (!Array.isArray(body.global)) return NextResponse.json({ error: "global must be an array" }, { status: 400 });
    return NextResponse.json({ global: writeGlobalMemory(body.global as never[]) });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
