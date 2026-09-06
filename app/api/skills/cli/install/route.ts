import { NextResponse } from "next/server";
import { cliInstallCommand } from "@/lib/skill-cli-installers";
import { installSkillCli } from "@/lib/skill-cli-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 360;

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if ((origin && origin !== new URL(req.url).origin) || req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "不允许跨站安装请求" }, { status: 403 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "无效的安装请求" }, { status: 400 });
  }
  const command = body && typeof body === "object" && "command" in body ? body.command : undefined;
  if (typeof command !== "string" || !cliInstallCommand(command)) {
    return NextResponse.json({ error: "此 CLI 不支持自动安装" }, { status: 400 });
  }
  try {
    return NextResponse.json(await installSkillCli(command));
  } catch (error) {
    const failure = error as { message?: string; stderr?: string; stdout?: string; killed?: boolean };
    const detail = [failure.stderr, failure.stdout].filter(Boolean).join("\n").replace(/\x1B\[[0-9;]*m/g, "").slice(-6000);
    return NextResponse.json({ error: failure.killed ? "安装超时，请重新检测 CLI 状态后再重试。" : failure.message || "安装失败", output: detail }, { status: 500 });
  }
}
