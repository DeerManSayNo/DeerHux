/**
 * 微信 Bot API
 *
 * GET  /api/wechat          → 获取当前状态
 * POST /api/wechat          → 执行操作
 *   { action: "login" }           开始扫码登录（返回二维码 URL）
 *   { action: "start" }           启动消息轮询
 *   { action: "stop" }            停止轮询
 *   { action: "restart" }         重启消息轮询
 *   { action: "logout" }          退出登录
 *   { action: "setCwd", cwd }    设置默认工作目录
 */

import { NextResponse } from "next/server";
import { getWeChatBotService } from "@/lib/wechat-bot";

export async function GET() {
  try {
    const bot = getWeChatBotService();
    return NextResponse.json(bot.getStatus());
  } catch (_error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as {
      action?: string;
      cwd?: string;
      token?: string;
      accountId?: string;
      baseUrl?: string;
      userId?: string;
    };

    const bot = getWeChatBotService();

    switch (body.action) {
      case "login": {
        // 开始扫码登录流程
        try {
          const qrcodeUrl = await bot.getQRCode();
          return NextResponse.json({
            success: true,
            qrcodeUrl,
            message: "请用微信扫描二维码",
          });
        } catch (err) {
          console.error("[wechat] getQRCode failed:", err);
          return NextResponse.json({
            success: false,
            error: "获取二维码失败",
          }, { status: 500 });
        }
      }

      case "start": {
        // 启动消息轮询。startPolling 是一个长轮询循环，不能 await；否则该 API 请求会一直挂起，
        // 前端按钮会停在“启动中...”，后续状态/对话同步也容易被误判为不可用。
        if (!bot.getStatus().connected) {
          return NextResponse.json({
            success: false,
            error: "尚未登录，请先扫码",
          }, { status: 400 });
        }
        void bot.startPolling().catch((err) => {
          console.error("[WeChatBot] 手动启动轮询失败:", err);
        });
        return NextResponse.json({ success: true, message: "消息轮询已启动" });
      }

      case "stop": {
        bot.stopPolling();
        return NextResponse.json({ success: true, message: "消息轮询已停止" });
      }

      case "restart": {
        if (!bot.getStatus().connected) {
          return NextResponse.json({
            success: false,
            error: "尚未登录，请先扫码",
          }, { status: 400 });
        }
        bot.stopPolling();
        void bot.startPolling().catch((err) => {
          console.error("[WeChatBot] 重启轮询失败:", err);
        });
        return NextResponse.json({ success: true, message: "消息轮询已重启" });
      }

      case "logout": {
        bot.logout();
        return NextResponse.json({ success: true, message: "已退出登录" });
      }

      case "setCwd": {
        if (body.cwd) {
          bot.setCwd(body.cwd);
          return NextResponse.json({ success: true, cwd: body.cwd });
        }
        return NextResponse.json({ error: "cwd is required" }, { status: 400 });
      }

      // 手动设置凭证（用于恢复之前的登录状态）
      case "restore": {
        if (body.token && body.accountId) {
          bot.loginWithCredentials({
            botToken: body.token,
            accountId: body.accountId,
            baseUrl: body.baseUrl ?? "https://ilinkai.weixin.qq.com",
            userId: body.userId ?? "",
          });
          return NextResponse.json({ success: true, message: "凭证已恢复" });
        }
        return NextResponse.json({ error: "token and accountId are required" }, { status: 400 });
      }

      default:
        return NextResponse.json({
          error: `Unknown action: ${body.action}. Supported: login, start, stop, restart, logout, setCwd, restore`,
        }, { status: 400 });
    }
  } catch (_error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
