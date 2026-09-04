import path from "node:path";
import { NextResponse } from "next/server";
import { listProjectBranches, readProjectBranch, switchProjectBranch } from "@/lib/project-branch";

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd || !path.isAbsolute(cwd)) {
    return NextResponse.json({ error: "Expected an absolute project path" }, { status: 400 });
  }
  const includeBranches = new URL(req.url).searchParams.get("list") === "1";
  let branches: string[] | undefined;
  if (includeBranches) {
    try {
      branches = await listProjectBranches(cwd);
    } catch {
      return NextResponse.json({ error: "无法读取分支，请确认项目路径存在且为 Git 仓库" }, { status: 400 });
    }
  }
  return NextResponse.json({ branch: await readProjectBranch(cwd), branches }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!body || typeof body.cwd !== "string" || !path.isAbsolute(body.cwd)
    || typeof body.branch !== "string" || !body.branch || body.branch.startsWith("-")) {
    return NextResponse.json({ error: "项目路径或分支名无效" }, { status: 400 });
  }
  try {
    return NextResponse.json({ branch: await switchProjectBranch(body.cwd, body.branch) });
  } catch (error) {
    const gitError = error as { stderr?: string; message?: string };
    return NextResponse.json({ error: gitError.stderr?.trim() || gitError.message || "切换分支失败" }, { status: 409 });
  }
}
