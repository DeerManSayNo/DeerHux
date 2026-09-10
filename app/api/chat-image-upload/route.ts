import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getAllowedRoots, isPathAllowed } from "@/lib/file-access";

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function imageExtFromUpload(file: File): string {
  const fromName = path.basename(file.name || "").toLowerCase().split(".").pop() ?? "";
  if (fromName && IMAGE_EXT_TO_MIME[fromName]) return fromName;
  switch (file.type) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/png":
    default:
      return "png";
  }
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

export async function POST(request: NextRequest) {
  try {
    let image: FormDataEntryValue | null;
    let cwd: unknown;
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await request.json();
      cwd = body.cwd;
      const sourcePath = body.path;
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
        return NextResponse.json({ error: "Invalid image path" }, { status: 400 });
      }
      const mimeType = IMAGE_EXT_TO_MIME[path.extname(sourcePath).slice(1).toLowerCase()];
      if (!mimeType) return NextResponse.json({ error: "Unsupported image type" }, { status: 400 });
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isFile()) return NextResponse.json({ error: "Not an image file" }, { status: 400 });
      if (stat.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Image too large (>20MB)" }, { status: 413 });
      image = new File([await fs.promises.readFile(sourcePath)], path.basename(sourcePath), { type: mimeType });
    } else {
      const form = await request.formData();
      image = form.get("image");
      cwd = form.get("cwd");
    }

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "Missing image" }, { status: 400 });
    }
    if (!image.type.startsWith("image/")) {
      return NextResponse.json({ error: "Only image uploads are supported" }, { status: 400 });
    }
    if (image.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "Image too large (>20MB)" }, { status: 413 });
    }
    if (typeof cwd !== "string" || !cwd.trim()) {
      return NextResponse.json({ error: "Missing cwd" }, { status: 400 });
    }

    // Uploads can be the first request after reopening a historical session.
    // Refresh roots here rather than trusting the short-lived access cache.
    const allowedRoots = await getAllowedRoots(true);
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const assetsDir = path.join(cwd, "assets", "chats");
    fs.mkdirSync(assetsDir, { recursive: true });

    const ext = imageExtFromUpload(image);
    const fileName = `chat-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const targetPath = path.join(assetsDir, fileName);
    fs.writeFileSync(targetPath, Buffer.from(await image.arrayBuffer()));

    // Build the /api/files/... URL for frontend access
    const apiUrl = `/api/files${targetPath}?type=read`;

    return NextResponse.json({
      ok: true,
      path: targetPath, // absolute path, used by backend to read the file
      url: apiUrl,      // frontend access URL via /api/files/[...path]
      mimeType: image.type,
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
