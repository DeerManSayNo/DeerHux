import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const { filePath } = (await request.json()) as { filePath: string };

    if (!filePath || typeof filePath !== "string") {
      return NextResponse.json({ error: "Missing filePath" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Determine if it's a file or directory
    let isDir = false;
    try {
      const stat = fs.statSync(filePath);
      isDir = stat.isDirectory();
    } catch {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
    }

    const platform = process.platform;
    // ★ 安全修复：使用 execFile（参数数组）替代 exec（shell 字符串拼接），
    // 彻底消除 filePath 含特殊字符时的命令注入风险。
    const resolved = path.resolve(filePath);

    if (platform === "darwin") {
      // macOS: open directory to view contents, reveal file in Finder
      const args = isDir ? [resolved] : ["-R", resolved];
      execFile("open", args, (error) => {
        if (error) console.error("Failed to reveal file:", error);
      });
    } else if (platform === "win32") {
      // Windows: open directory, or select file in Explorer
      const args = isDir ? [resolved] : ["/select," + resolved];
      execFile("explorer", args, (error) => {
        if (error) console.error("Failed to reveal file:", error);
      });
    } else {
      // Linux: open directory or containing directory
      const dir = isDir ? resolved : path.dirname(resolved);
      execFile("xdg-open", [dir], (error) => {
        if (error) console.error("Failed to reveal file:", error);
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[files/reveal] error:", error);
    return NextResponse.json({ error: "Failed to reveal file" }, { status: 500 });
  }
}
