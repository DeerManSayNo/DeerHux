import { NextResponse } from "next/server";
import {
  readProjectMeta,
  writeProjectMeta,
  isEmptyProjectMeta,
  type ProjectMeta,
} from "@/lib/project-meta";

// GET /api/project-meta
// Returns the persisted project meta. `exists=false` signals the file hasn't
// been created yet — the client uses this to trigger a one-time migration
// from the legacy localStorage keys.
export async function GET() {
  try {
    const meta = readProjectMeta();
    return NextResponse.json({ meta, exists: !isEmptyProjectMeta(meta) });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/project-meta  body: ProjectMeta
// Overwrites the persisted project meta with the normalized payload.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<ProjectMeta>;
    const meta = writeProjectMeta({
      hiddenCwds: Array.isArray(body.hiddenCwds) ? body.hiddenCwds : [],
      pinnedCwds: Array.isArray(body.pinnedCwds) ? body.pinnedCwds : [],
      notes: body.notes && typeof body.notes === "object" ? body.notes : {},
      defaultPinInitializedCwds: Array.isArray(body.defaultPinInitializedCwds)
        ? body.defaultPinInitializedCwds
        : [],
      customCwds: Array.isArray(body.customCwds) ? body.customCwds : [],
    });
    return NextResponse.json({ ok: true, meta });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
