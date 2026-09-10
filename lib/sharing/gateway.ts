import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { ShareService, ShareError, exactObject } from "./service";

export function isLocalNetwork(address: string): boolean {
  const ip = address.replace(/^::ffff:/, "");
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
}

function addresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(i => !i.internal && i.family === "IPv4" && isLocalNetwork(i.address)).map(i => i.address));
}

async function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    socket.setTimeout(700, () => done(false));
  });
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 100_000) throw new ShareError("请求过大", 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ShareError("无效 JSON"); }
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}

export class ShareGateway {
  readonly service = new ShareService();
  private server?: Server;
  private starting?: Promise<void>;
  private port = 0;
  private ownerOrigin = "";
  private publicOrigin = "";
  private expiry?: ReturnType<typeof setInterval>;

  urls(id: string) {
    return this.publicOrigin ? [`${this.publicOrigin}/share/${id}`] : addresses().map(ip => `http://${ip}:${this.port}/share/${id}`);
  }

  async start(origin: string) {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.open(origin).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async open(origin: string) {
    const publicOrigin = process.env.DEERHUX_SHARE_PUBLIC_ORIGIN ?? "";
    const listenPort = Number(process.env.DEERHUX_SHARE_PORT ?? 0);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new ShareError("分享端口配置无效");
    if (publicOrigin) {
      const external = new URL(publicOrigin);
      if (external.protocol !== "https:" || external.origin !== publicOrigin || !listenPort) throw new ShareError("公网分享需要 HTTPS 来源和固定分享端口");
    }
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new ShareError("请从主人设备的本机地址打开 DeerHux");
    const ips = addresses();
    if (!ips.length && !publicOrigin) throw new ShareError("未找到局域网地址，请先连接网络");
    const port = Number(url.port || 80);
    // A public original API would bypass every gateway permission. Fail closed on
    // existing dev servers started before the loopback-only startup change.
    const exposed = await Promise.all(ips.map(ip => reachable(ip, port)));
    if (exposed.some(Boolean)) throw new ShareError("本机服务仍向局域网开放。请重启 DeerHux（开发环境重新运行 npm run dev）后再分享");
    this.ownerOrigin = `http://127.0.0.1:${port}`;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    server.maxConnections = 80;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, publicOrigin ? "127.0.0.1" : "0.0.0.0", () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    this.publicOrigin = publicOrigin;
    this.port = (server.address() as { port: number }).port;
    server.unref();
    this.expiry = setInterval(() => { void this.service.expire().catch(() => {}); }, 1000);
    this.expiry.unref();
  }

  async close() {
    for (const id of this.service.shares.keys()) await this.service.revoke(id);
    if (this.expiry) clearInterval(this.expiry);
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (!isLocalNetwork(req.socket.remoteAddress ?? "")) throw new ShareError("仅允许局域网访问", 403);
      if (this.publicOrigin && (req.headers.host !== new URL(this.publicOrigin).host || req.headers["x-forwarded-proto"] !== "https")) throw new ShareError("请通过 HTTPS 分享入口访问", 403);
      const raw = req.url ?? "";
      const url = new URL(raw, "http://share.invalid");
      const decodedPath = decodeURIComponent(url.pathname);
      if (/[\\%]/.test(decodedPath) || raw.startsWith("http") || raw.startsWith("//")) throw new ShareError("无效路径", 404);
      const match = /^\/api\/share\/([a-f0-9-]{36})\/(auth|catalog|sessions)(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if (match) {
        const [, id, action, sessionId] = match;
        if (url.search || (sessionId && action !== "sessions")) throw new ShareError("接口不存在", 404);
        if (!["GET", "POST"].includes(req.method ?? "")) throw new ShareError("不支持的操作", 405);
        // Require a custom header for mutations: browsers cannot send it cross-origin
        // without preflight, which this gateway never permits. No forwarded trust.
        if (req.method === "POST" && (req.headers["x-deerhux-share"] !== "1" || req.headers["sec-fetch-site"] === "cross-site")) throw new ShareError("请求来源无效", 403);
        if (action === "auth" && req.method === "POST") {
          const data = exactObject(await body(req), ["code"]);
          const token = this.service.login(id, data.code);
          res.setHeader("Set-Cookie", `dh_share_${id}=${token}; HttpOnly; SameSite=Strict; Path=/api/share/${id}; Max-Age=604800${this.publicOrigin ? "; Secure" : ""}`);
          json(res, { success: true }); return;
        }
        const token = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`dh_share_${id}=`))?.split("=")[1];
        const guest = this.service.guest(id, token);
        if (action === "catalog" && req.method === "GET") { json(res, this.service.catalog(id)); return; }
        if (action === "sessions") {
          if (req.method === "GET") { json(res, sessionId ? this.service.snapshot(guest, sessionId) : this.service.list(guest)); return; }
          const data = await body(req);
          json(res, sessionId ? await this.service.command(guest, sessionId, data) : this.service.createSession(guest, data)); return;
        }
        throw new ShareError("接口不存在", 404);
      }
      // Proxy only this public page and immutable Next assets. Never proxy API,
      // server actions, RSC headers, arbitrary query strings or original cookies.
      const page = /^\/share\/[a-f0-9-]{36}$/.test(url.pathname);
      const asset = /^\/_next\/static\/[A-Za-z0-9_./@~\-\[\]()]+$/.test(decodedPath) && !decodedPath.endsWith(".map");
      if (req.method !== "GET" || (!page && !asset) || url.search || decodedPath.split("/").some(p => p === ".." || p === ".")) throw new ShareError("接口不存在", 404);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      const upstream = httpRequest(`${this.ownerOrigin}${url.pathname}`, { method: "GET", headers: { accept: page ? "text/html" : "*/*" }, timeout: 60_000 }, response => {
        res.statusCode = response.statusCode ?? 502;
        res.setHeader("Content-Type", response.headers["content-type"] ?? "application/octet-stream");
        res.setHeader("Cache-Control", page || process.env.NODE_ENV === "development" ? "no-store" : "public, max-age=3600");
        response.pipe(res);
      });
      upstream.once("timeout", () => upstream.destroy());
      upstream.once("error", () => { if (!res.headersSent) json(res, { error: "主人服务暂不可用" }, 502); else res.destroy(); });
      res.once("close", () => upstream.destroy()); upstream.end();
    } catch (error) {
      if (!res.headersSent) json(res, { error: error instanceof ShareError ? error.message : "请求失败" }, error instanceof ShareError ? error.status : 500);
      else res.destroy();
    }
  }
}

declare global { var __deerhuxShareGateway: ShareGateway | undefined; }
export function shareGateway() {
  const gateway = globalThis.__deerhuxShareGateway ??= new ShareGateway();
  // Dev HMR keeps live shares and sockets. Refresh methods without discarding
  // their state so updated validation/expiry rules apply to that live service.
  if (process.env.NODE_ENV === "development" && Object.getPrototypeOf(gateway.service) !== ShareService.prototype) {
    Object.setPrototypeOf(gateway.service, ShareService.prototype);
  }
  return gateway;
}
