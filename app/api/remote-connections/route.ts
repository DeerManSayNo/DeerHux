import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { readSessionIndex } from "@/lib/session/session-index";
import type { SessionInfo } from "@/lib/types";
import { getWeChatBotService, WeChatBindingError } from "@/lib/wechat-bot";

export async function GET() {
  try {
    const userSessions = getWeChatBotService().getConnections();
    const wechatStatus = getWeChatBotService().getStatus();
    const boundSessionIds = new Set(Object.values(userSessions).filter(Boolean));
    const sessionById = new Map<string, SessionInfo>();
    // This endpoint is requested on every app launch, even without bindings.
    // Reuse the sidebar index instead of parsing all historical JSONL files.
    if (boundSessionIds.size > 0) {
      const index = process.env.DEERHUX_SESSION_INDEX === "0" ? null : await readSessionIndex();
      const sessions = index ? index.records : await listAllSessions();
      for (const session of sessions) {
        if (!boundSessionIds.has(session.id)) continue;
        sessionById.set(session.id, {
          id: session.id, path: session.path, cwd: session.cwd,
          name: session.name, created: session.created, modified: session.modified,
          messageCount: session.messageCount, firstMessage: session.firstMessage,
          isSubagent: session.isSubagent, parentSessionId: session.parentSessionId,
        });
      }
    }
    const connections = Object.entries(userSessions).map(([userId, sessionId]) => ({
      id: `wechat:${userId}`,
      type: "wechat" as const,
      provider: "微信 Bot",
      userId,
      sessionId,
      session: sessionById.get(sessionId) ?? null,
      connected: wechatStatus.connected,
      polling: wechatStatus.polling,
    }));

    return NextResponse.json({
      status: { wechat: wechatStatus },
      connections,
    });
  } catch (error) {
    console.error("[api/remote-connections] error:", error);
    return NextResponse.json({ error: "Internal server error", connections: [] }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body || !["bind", "unbind"].includes(body.action)
      || typeof body.userId !== "string" || !body.userId.trim()
      || typeof body.sessionId !== "string" || !body.sessionId.trim()
      || (body.action === "bind" && typeof body.expectedSessionId !== "string")) {
      return NextResponse.json({ error: "无效的微信绑定参数" }, { status: 400 });
    }
    const bot = getWeChatBotService();
    if (body.action === "bind") await bot.bindSession(body.userId, body.sessionId, body.expectedSessionId);
    else bot.unbindSession(body.userId, body.sessionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof WeChatBindingError) return NextResponse.json({ error: error.message }, { status: error.status });
    // 进程级单例的错误可能由另一个 Next 路由包内的类实例抛出。
    if (error instanceof Error && error.name === "WeChatBindingError" && "status" in error && typeof error.status === "number") {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) return NextResponse.json({ error: "无效的 JSON" }, { status: 400 });
    console.error("[api/remote-connections] mutation failed:", error);
    return NextResponse.json({ error: "更新微信绑定失败" }, { status: 500 });
  }
}
