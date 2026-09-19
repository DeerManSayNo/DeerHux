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
    const results = await Promise.all(paths.map(async (filePath: string) => {
      if (!path.isAbsolute(filePath) || filePath.includes("\0")) return { valid: false, directory: false };
      if (process.platform !== "win32" && isWindowsAbsolutePath(filePath)) return { valid: false, directory: false };
      if (!isPathAllowed(filePath, roots)) return { valid: false, directory: false };
      try {
        const info = await fs.stat(filePath);
        if (!info.isFile() && !info.isDirectory()) return { valid: false, directory: false };
        await fs.access(filePath, fs.constants.R_OK);
        return { valid: true, directory: info.isDirectory() };
      } catch { return { valid: false, directory: false }; }
    }));
    return NextResponse.json({
      valid: results.map((result) => result.valid),
      directories: results.map((result) => result.directory),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "File validation unavailable" }, { status: 503 });
  }
}
