import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_COLLISION_ATTEMPTS = 10_000;

function safeFileName(name: string): string {
  const baseName = path.basename(name.trim()).replace(/[\u0000-\u001f\u007f]/g, "");
  if (!baseName || baseName === "." || baseName === "..") return "pasted-file";
  return baseName;
}

function collisionName(fileName: string, attempt: number): string {
  if (attempt === 0) return fileName;
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  return `${stem} (${attempt})${ext}`;
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const cwdValue = form.get("cwd");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少要粘贴的文件" }, { status: 400 });
    }
    if (typeof cwdValue !== "string" || !cwdValue.trim()) {
      return NextResponse.json({ error: "当前会话尚未设置工作目录" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "文件过大（最大 100MB）" }, { status: 413 });
    }

    const cwd = path.resolve(cwdValue);
    const allowedRoots = await getAllowedRoots(true);
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "无权写入该项目" }, { status: 403 });
    }

    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "项目工作目录不存在" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const requestedName = safeFileName(file.name);
    let targetPath = "";

    // 不覆盖项目中已有文件；和桌面文件管理器一样自动生成可辨认的副本名。
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = path.join(cwd, collisionName(requestedName, attempt));
      try {
        fs.writeFileSync(candidate, buffer, { flag: "wx" });
        targetPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        // writeFile 可能已创建文件后才因磁盘错误失败，避免留下半份上传文件。
        try {
          fs.unlinkSync(candidate);
        } catch {
          // 文件没有创建时无需清理。
        }
        throw error;
      }
    }

    if (!targetPath) {
      return NextResponse.json({ error: "无法为文件生成不冲突的名称" }, { status: 409 });
    }

    return NextResponse.json({
      ok: true,
      path: targetPath,
      name: path.basename(targetPath),
    });
  } catch (error) {
    console.error("project-file-upload failed", error);
    return NextResponse.json({ error: "文件粘贴失败" }, { status: 500 });
  }
}
