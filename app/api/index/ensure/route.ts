import { stat } from "fs/promises";
import { codeIndexLifecycle } from "@/lib/code-index/lifecycle";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { cwd?: unknown };
  if (typeof body.cwd !== "string" || !body.cwd.trim()) {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }
  const directory = await stat(body.cwd).catch(() => null);
  if (!directory?.isDirectory()) return Response.json({ error: "Project directory not found" }, { status: 400 });
  codeIndexLifecycle().touch(body.cwd);
  return Response.json({ scheduled: true }, { status: 202 });
}
