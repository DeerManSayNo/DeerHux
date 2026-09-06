import { NextResponse } from "next/server";
import { listSystemClis, removeSystemCli } from "@/lib/system-cli";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 360;
export async function GET() {
  try { return NextResponse.json({ clis: await listSystemClis() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 npm 全局 CLI" }, { status: 500 }); }
}
export async function DELETE(req: Request) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "不允许跨站删除请求" }, { status: 403 });
  try {
    const body = await req.json();
    if (typeof body?.path !== "string" || typeof body?.realPath !== "string" || (body.packageName !== undefined && typeof body.packageName !== "string")) return NextResponse.json({ error: "无效的 CLI" }, { status: 400 });
    const output = await removeSystemCli(body.path, body.realPath, body.packageName);
    return NextResponse.json({ success: true, output });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    return NextResponse.json({ error: (failure.stderr || failure.message || "删除失败").slice(-6000) }, { status: 400 });
  }
}
