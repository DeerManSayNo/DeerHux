import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";

export async function POST(request: NextRequest) {
  try {
    const { paths } = await request.json() as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length > 64 || paths.some((value) => typeof value !== "string" || value.length > 4096)) {
      return NextResponse.json({ error: "Invalid paths" }, { status: 400 });
    }
    const roots = await getAllowedRoots();
    const valid = await Promise.all(paths.map(async (filePath: string) => {
      if (!path.isAbsolute(filePath) || filePath.includes("\0")) return false;
      if (process.platform !== "win32" && isWindowsAbsolutePath(filePath)) return false;
      if (!isPathAllowed(filePath, roots)) return false;
      try {
        const info = await fs.stat(filePath);
        if (!info.isFile()) return false;
        await fs.access(filePath, fs.constants.R_OK);
        return true;
      } catch { return false; }
    }));
    return NextResponse.json({ valid }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "File validation unavailable" }, { status: 503 });
  }
}
