import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { createMcpRuntime, loadEnabledMcpServers, type McpServerStatus } from "@/lib/mcp-runtime";

const SCRIPT_PATH_PATTERN = /\.(?:[cm]?js|ts|py)$/i;

function invalidLocalPath(server: ReturnType<typeof loadEnabledMcpServers>[number]): string | null {
  if (server.command?.startsWith("/") && !existsSync(server.command)) {
    return `启动命令不存在：${server.command}`;
  }
  const script = server.args?.find((arg) => arg.startsWith("/") && SCRIPT_PATH_PATTERN.test(arg));
  return script && !existsSync(script) ? `启动脚本不存在：${script}` : null;
}

/**
 * Runtime MCP discovery is intentionally separate from the System Prompt
 * configuration read. Starting external stdio servers can be slow or fail and
 * must never delay opening the role editor.
 */
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd")?.trim();
  if (!cwd || !existsSync(cwd)) {
    return NextResponse.json({ error: "A valid cwd is required" }, { status: 400 });
  }

  const servers = loadEnabledMcpServers(cwd);
  const invalidStatuses: McpServerStatus[] = [];
  const runnableServers = servers.filter((server) => {
    const errorMessage = invalidLocalPath(server);
    if (!errorMessage) return true;
    invalidStatuses.push({
      id: server.id,
      name: server.name,
      transport: server.transport,
      status: "error",
      toolCount: 0,
      errorMessage,
      sourcePath: server.sourcePath,
    });
    return false;
  });

  let runtime: Awaited<ReturnType<typeof createMcpRuntime>> | null = null;
  try {
    runtime = await createMcpRuntime(cwd, runnableServers);
    return NextResponse.json({
      tools: runtime.tools.map((tool) => ({
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description ?? "",
      })),
      statuses: [...invalidStatuses, ...runtime.serverStatuses],
    });
  } catch {
    return NextResponse.json({
      tools: [],
      statuses: invalidStatuses,
      error: "MCP 工具发现失败，请检查 MCP 服务配置。",
    }, { status: 502 });
  } finally {
    runtime?.close();
  }
}
