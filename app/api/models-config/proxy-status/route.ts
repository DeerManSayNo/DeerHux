import { NextResponse } from "next/server";
import { getProviderProxy, probeProviderProxy, probeProxyUrl, ProviderProxyConfigError } from "@/lib/provider-proxy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider")?.trim() ?? "";
  if (!provider) return NextResponse.json({ error: "缺少供应商名称" }, { status: 400 });
  if (!getProviderProxy(provider)) return NextResponse.json({ configured: false });
  try {
    return NextResponse.json({ configured: true, node: await probeProviderProxy(provider) });
  } catch (error) {
    return NextResponse.json({
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { proxyUrl?: unknown };
    if (typeof body.proxyUrl !== "string" || !body.proxyUrl.trim()) {
      return NextResponse.json({ error: "缺少代理地址" }, { status: 400 });
    }
    return NextResponse.json({ configured: true, node: await probeProxyUrl(body.proxyUrl) });
  } catch (error) {
    const status = error instanceof ProviderProxyConfigError ? 400 : 502;
    return NextResponse.json({
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    }, { status });
  }
}
