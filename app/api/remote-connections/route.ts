import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir, listAllSessions } from "@/lib/session-reader";
import { readSessionIndex } from "@/lib/session/session-index";
import type { SessionInfo } from "@/lib/types";
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
    const userSessions = readWechatUserSessions();
    const wechatStatus = getWeChatBotService().getStatus();
    const boundSessionIds = new Set(Object.values(userSessions));
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
