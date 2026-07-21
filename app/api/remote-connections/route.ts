import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir, listAllSessions } from "@/lib/session-reader";
import { getWeChatBotService } from "@/lib/wechat-bot";

function readWechatUserSessions(): Record<string, string> {
  const file = join(getAgentDir(), "wechat", "user-sessions.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

export async function GET() {
  try {
    const [sessions, wechatStatus] = await Promise.all([
      listAllSessions(),
      Promise.resolve(getWeChatBotService().getStatus()),
    ]);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const userSessions = readWechatUserSessions();
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
