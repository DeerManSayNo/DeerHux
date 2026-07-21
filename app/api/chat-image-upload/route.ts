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
    const form = await request.formData();
    const image = form.get("image");
    const cwd = form.get("cwd");

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

    const allowedRoots = await getAllowedRoots();
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
