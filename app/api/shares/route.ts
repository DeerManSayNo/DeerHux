import { shareGateway } from "@/lib/sharing/gateway";
import { ShareError, exactObject, ensureOwnerCode } from "@/lib/sharing/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gateway = shareGateway();
  await gateway.service.expire();
  return Response.json({ shares: [...gateway.service.shares.values()].map(s => ({ id: s.id, name: s.name, writable: s.writable, expiresAt: s.expiresAt, urls: gateway.urls(s.id), code: s.ownerCode ?? null })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 100_000) throw new ShareError("请求过大", 413);
    const gateway = shareGateway();
    await gateway.start(new URL(req.url).origin);
    const { share, code } = gateway.service.create(await req.json());
    // Preserve the code even when dev HMR retains an older service instance.
    share.ownerCode = code;
    return Response.json({ id: share.id, code, urls: gateway.urls(share.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof ShareError ? error.message : "创建失败，请检查项目、模型和角色" }, { status: error instanceof ShareError ? error.status : 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = exactObject(await req.json(), ["id"]);
    if (typeof id !== "string") throw new ShareError("缺少分享 ID");
    await shareGateway().service.revoke(id);
    return Response.json({ success: true });
  } catch { return Response.json({ error: "停止分享失败" }, { status: 400 }); }
}

export async function PATCH(req: Request) {
  try {
    const { id } = exactObject(await req.json(), ["id"]);
    if (typeof id !== "string") throw new ShareError("缺少分享 ID");
    const share = shareGateway().service.active(id);
    return Response.json({ code: ensureOwnerCode(share) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof ShareError ? error.message : "生成匹配码失败" }, { status: error instanceof ShareError ? error.status : 400 });
  }
}
