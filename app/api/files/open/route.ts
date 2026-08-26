import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  try {
    const { filePath } = (await request.json()) as { filePath?: unknown };

    if (typeof filePath !== "string" || !filePath) {
      return NextResponse.json({ error: "Missing filePath" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
    }

    if (process.platform === "darwin") {
      await execFileAsync("open", [resolved]);
    } else if (process.platform === "win32") {
      await execFileAsync("explorer", [resolved]);
    } else {
      await execFileAsync("xdg-open", [resolved]);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[files/open] error:", error);
    return NextResponse.json({ error: "Failed to open file" }, { status: 500 });
  }
}
