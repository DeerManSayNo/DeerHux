import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

const IS_POSIX = process.platform !== "win32";

function tryChmod(filePath: string, mode: number): void {
  if (!IS_POSIX) return;
  try { chmodSync(filePath, mode); } catch { /* best effort */ }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic write: temp file + rename to avoid truncated config on interrupt
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, path);
    tryChmod(path, 0o600);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    throw e;
  }
}

export async function GET() {
  return NextResponse.json(readModelsJson());
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsJson(body);
    // Model registry refreshes on each /api/models request (no local cache to invalidate)
    return NextResponse.json({ success: true });
  } catch (_error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
