import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { installShareDevClient } from "../lib/sharing/dev-client.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AgentEnginePort } from "../lib/engine/port";
import type { DeerLoopOptions } from "../lib/engine/deer-loop";

// Exercise the installed Next client: without the guard 26 failed connections
// reload the page; a shared page must neither connect nor schedule retries.
{
  const require = createRequire(import.meta.url);
  const nextClient = fs.readFileSync(require.resolve("next/dist/client/dev/hot-reloader/app/web-socket.js"), "utf8");
  function run(guard: boolean, pathname = "/share/00000000-0000-0000-0000-000000000000") {
    let connections = 0, reloads = 0;
    const timers: (() => void)[] = [];
    const sockets: Socket[] = [];
    class Socket extends EventTarget {
      constructor(..._args: unknown[]) { super(); connections++; sockets.push(this); }
      readyState = 3; OPEN = 1; onerror: (() => void) | null = null;
      close() {} send() {}
    }
    const location = { pathname, host: "share.example.test", href: `https://share.example.test${pathname}`, reload: () => { reloads++; } };
    const window = { WebSocket: Socket, location, console };
    const exports: { createWebSocket?: (...args: unknown[]) => Socket } = {};
    const context = vm.createContext({ window, location, self: { __next_r: "test" }, exports, EventTarget, URL, TextDecoder, console,
      process: { env: {} }, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
      require: (name: string) => name.endsWith("get-socket-url") ? { getSocketUrl: () => "wss://share.example.test" } : name.endsWith("constants") ? { WEB_SOCKET_MAX_RECONNECTIONS: 25 } : {},
    });
    if (guard) vm.runInContext(`(${installShareDevClient.toString()})();`, context);
    vm.runInContext(nextClient, context);
    const socket = exports.createWebSocket!("", {});
    sockets.at(-1)?.onerror?.();
    for (let i = 0; i < 30 && timers.length; i++) {
      timers.shift()!();
      sockets.at(-1)?.onerror?.();
    }
    return { connections, reloads, timers, socket, window, NativeSocket: Socket };
  }
  const guarded = run(true);
  assert.equal(guarded.connections, 0);
  assert.equal(guarded.timers.length, 0);
  assert.equal(guarded.reloads, 0);
  assert.equal(guarded.socket.readyState, 3);
  assert.ok(new guarded.window.WebSocket("wss://share.example.test/business") instanceof guarded.NativeSocket);
  assert.equal(run(true, "/").connections > 0, true);
  assert.equal(run(false).connections, 26);
  assert.equal(run(false).reloads, 1);
  console.log("PASS: sharing disables Next HMR connection/retries while owner HMR remains native");
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "deerhux-share-test-"));
// Set before importing the SDK; tests never access the user's model credentials.
process.env.DEERHUX_CODING_AGENT_DIR = path.join(temporary, "agent");
process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
const { SharedFiles } = await import("../lib/sharing/files.ts");
const { ShareService, ShareError, ensureOwnerCode } = await import("../lib/sharing/service.ts");
const { ShareGateway, isLocalNetwork } = await import("../lib/sharing/gateway.ts");
const project = path.join(temporary, "project");
fs.mkdirSync(project); fs.writeFileSync(path.join(project, "hello.txt"), "original");
fs.writeFileSync(path.join(project, ".env"), "secret");
fs.writeFileSync(path.join(temporary, "outside.txt"), "outside");
fs.symlinkSync(path.join(temporary, "outside.txt"), path.join(project, "link.txt"));
fs.linkSync(path.join(temporary, "outside.txt"), path.join(project, "hard.txt"));
let writable = false; let active = true;
const files = new SharedFiles(project, () => writable, () => { if (!active) throw new Error("revoked"); });
let gateway: InstanceType<typeof ShareGateway> | undefined;
let owner: ReturnType<typeof createServer> | undefined;
try {
  assert.equal(isLocalNetwork("192.168.1.2"), true);
  assert.equal(isLocalNetwork("::ffff:10.0.1.2"), true);
  assert.equal(isLocalNetwork("8.8.8.8"), false);
  assert.equal(files.read("hello.txt"), "original");
  for (const target of ["../outside.txt", "link.txt", "hard.txt", ".env", "/etc/passwd", "C:\\test", "sub/../../outside.txt", "file.key"]) {
    assert.throws(() => files.read(target), target);
    assert.throws(() => files.write(target, "bad"), target);
  }
  assert.throws(() => files.write("hello.txt", "bad"));
  assert.equal(files.list(), "hello.txt");
  assert.equal(fs.readFileSync(path.join(project, "hello.txt"), "utf8"), "original");
  writable = true; files.write("hello.txt", "changed"); files.write("new.txt", "new");
  assert.equal(files.read("hello.txt"), "changed");
  assert.throws(() => files.write("link.txt", "bad"));
  assert.throws(() => files.write("hard.txt", "bad"));
  assert.equal(fs.readFileSync(path.join(temporary, "outside.txt"), "utf8"), "outside");
  active = false; assert.throws(() => files.read("hello.txt")); assert.throws(() => files.write("hello.txt", "bad"));
  console.log("PASS: read-only, authorized write, path traversal, hidden files, symlink and hardlink boundaries");

  let options: DeerLoopOptions | undefined;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const fakeEngine = {
    subscribe: (fn: typeof listener) => { listener = fn; return () => {}; },
    setAutoCompactionEnabled: () => {}, setAutoRecoveryMode: () => {},
    prompt: async () => { listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "mock reply" }], timestamp: Date.now() } }); },
    abort: async () => {}, dispose: () => {},
  } as unknown as AgentEnginePort;
  const model = { provider: "test", id: "model" } as NonNullable<DeerLoopOptions["model"]>;
  const service = new ShareService(() => ({ find: (p, id) => p === "test" && id === "model" ? model : undefined, getApiKeyForProvider: async () => undefined }), { create: input => { options = input; return fakeEngine; } });
  const config = { name: "test", projects: [project], models: [{ provider: "test", modelId: "model" }], roleIds: ["default"], writable: false, hours: 1 };
  const permanent = service.create({ ...config, hours: null });
  assert.equal(permanent.share.expiresAt, null);
  assert.equal(JSON.parse(JSON.stringify(service.catalog(permanent.share.id))).expiresAt, null);
  const now = Date.now;
  try {
    Date.now = () => now() + 365 * 24 * 3600_000;
    await service.expire();
    assert.equal(service.active(permanent.share.id), permanent.share);
  } finally { Date.now = now; }
  await service.revoke(permanent.share.id);
  assert.throws(() => service.active(permanent.share.id));
  for (const hours of [0, -1, 169, Infinity, "permanent", undefined]) assert.throws(() => service.create({ ...config, hours }));
  console.log("PASS: permanent expiry survives time advance, supports manual revocation and rejects invalid durations");
  const created = service.create(config);
  assert.match(created.code, /^\d{6}$/);
  assert.equal(created.share.ownerCode, created.code);
  assert.equal(ensureOwnerCode(created.share), created.code);
  assert.ok(!("ownerCode" in service.catalog(created.share.id)));
  const legacy = service.create(config);
  delete legacy.share.ownerCode;
  const replacement = ensureOwnerCode(legacy.share);
  assert.match(replacement, /^\d{6}$/);
  assert.notEqual(replacement, legacy.code);
  assert.equal(ensureOwnerCode(legacy.share), replacement);
  assert.throws(() => service.login(legacy.share.id, legacy.code));
  assert.ok(service.login(legacy.share.id, replacement));
  await service.revoke(legacy.share.id);
  const id = created.share.id;
  assert.throws(() => service.login(id, "wrong"));
  const token = service.login(id, created.code);
  const guest = service.guest(id, token);
  const other = service.guest(id, service.login(id, created.code));
  const catalog = service.catalog(id);
  assert.ok(!JSON.stringify(catalog).includes(project));
  const input = { projectId: catalog.projects[0].id, roleId: "default", provider: "test", modelId: "model" };
  for (const override of [{ projectId: "other" }, { provider: "other" }, { roleId: "other" }, { writable: true }, { cwd: project }, { toolNames: ["bash"] }]) assert.throws(() => service.createSession(guest, { ...input, ...override }));
  const session = service.createSession(guest, input);
  assert.throws(() => service.subscribe(other, session.id, () => {}));
  const subscriptions = Array.from({ length: 8 }, () => service.subscribe(guest, session.id, () => {}));
  assert.throws(() => service.subscribe(guest, session.id, () => {}));
  subscriptions.forEach(unsubscribe => unsubscribe());
  service.subscribe(guest, session.id, () => {})();
  assert.deepEqual(options?.activeToolNames, ["share_list", "share_read"]);
  assert.throws(() => service.snapshot(other, session.id));
  assert.throws(() => service.guest(id, "forged"));
  for (const type of ["set_mode", "set_tools", "set_role", "set_model", "fork", "bash", "reload_mcp"]) await assert.rejects(service.command(guest, session.id, { type }));
  await assert.rejects(service.command(guest, session.id, { type: "prompt", message: "hello", permissions: { writable: true } }));
  await service.command(guest, session.id, { type: "prompt", message: "hello" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(service.snapshot(guest, session.id).messages.length, 2);
  const oldTool = options!.tools![1];
  await service.revoke(id);
  assert.throws(() => service.guest(id, token));
  await assert.rejects(oldTool.execute("call", { path: "hello.txt" }, undefined, undefined, {} as never));
  const writeShare = service.create({ ...config, writable: true });
  const writeGuest = service.guest(writeShare.share.id, service.login(writeShare.share.id, writeShare.code));
  service.createSession(writeGuest, { ...input, projectId: service.catalog(writeShare.share.id).projects[0].id });
  const writeTool = options!.tools!.find(t => t.name === "share_write")!;
  await writeTool.execute("write", { path: "new.txt", content: "tool write" }, undefined, undefined, {} as never);
  assert.equal(fs.readFileSync(path.join(project, "new.txt"), "utf8"), "tool write");
  await assert.rejects(writeTool.execute("escape", { path: "../outside.txt", content: "bad" }, undefined, undefined, {} as never));
  writeShare.share.writable = false;
  await assert.rejects(writeTool.execute("downgrade", { path: "new.txt", content: "bad" }, undefined, undefined, {} as never));
  await service.revoke(writeShare.share.id);
  const limited = service.create(config);
  for (let i = 0; i < 10; i++) assert.throws(() => service.login(limited.share.id, "wrong"));
  assert.throws(() => service.login(limited.share.id, limited.code), (e: unknown) => e instanceof ShareError && e.status === 429);
  limited.share.expiresAt = 0;
  assert.throws(() => service.guest(limited.share.id, token));
  console.log("PASS: authentication, resource allowlists, guest isolation, command spoofing, revocation and rate limits; mock engine reply");

  const ownerHits: string[] = [];
  owner = createServer((req, res) => {
    ownerHits.push(req.url ?? ""); res.setHeader("Content-Type", "text/html");
    if (req.headers["accept-encoding"]?.includes("gzip")) {
      res.setHeader("Content-Encoding", "gzip"); res.end(gzipSync("share fixture"));
    } else res.end("share fixture");
  });
  await new Promise<void>(resolve => owner!.listen(0, "127.0.0.1", resolve));
  const ownerPort = (owner.address() as { port: number }).port;
  gateway = new ShareGateway();
  Object.defineProperty(gateway, "service", { value: service });
  await gateway.start(`http://127.0.0.1:${ownerPort}`);
  // Seed only the gateway's ephemeral policy; no real model request is made.
  const seeded = service.create(config);
  gateway.service.shares.set(seeded.share.id, seeded.share);
  const link = gateway.urls(seeded.share.id)[0];
  const origin = new URL(link).origin;
  const base = `${origin}/api/share/${seeded.share.id}`;
  const pageResponse = await fetch(link);
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get("content-encoding"), "gzip");
  assert.equal(await pageResponse.text(), "share fixture");
  const asset = "/_next/static/chunks/%5Broot%5D_%40next_abc~4..js";
  assert.equal((await fetch(`${origin}${asset}`)).status, 200);
  for (const route of ["/api/sessions", "/api/agent/new", "/api/shares", "/api/roles", "/", "/share/anything", "/_next/static/../server.js"]) assert.equal((await fetch(`${origin}${route}`)).status, 404, route);
  assert.equal((await fetch(`${base}/catalog`)).status, 401);
  assert.equal((await fetch(`${base}/auth`, { method: "POST", body: JSON.stringify({ code: seeded.code }) })).status, 403);
  assert.equal((await fetch(link, { method: "POST", headers: { "Next-Action": "forged" } })).status, 404);
  const auth = await fetch(`${base}/auth`, { method: "POST", headers: { "X-DeerHux-Share": "1" }, body: JSON.stringify({ code: seeded.code }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  const response = await fetch(`${base}/catalog`, { headers: { cookie } });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(project));
  const streamGuest = service.guest(seeded.share.id, cookie.split("=")[1]);
  const streamSession = service.createSession(streamGuest, { ...input, projectId: service.catalog(seeded.share.id).projects[0].id });
  const eventsUrl = `${base}/sessions/${streamSession.id}/events`;
  assert.equal((await fetch(eventsUrl)).status, 401);
  const otherToken = service.login(seeded.share.id, seeded.code);
  assert.equal((await fetch(eventsUrl, { headers: { cookie: `dh_share_${seeded.share.id}=${otherToken}` } })).status, 404);
  async function openStream() {
    const controller = new AbortController();
    const response = await fetch(eventsUrl, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      close: () => controller.abort(),
      next: async () => {
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
          while (!buffer.includes("\n\n")) {
            const chunk = await reader.read();
            assert.equal(chunk.done, false);
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          const end = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          return { event: /^event: (.+)$/m.exec(frame)![1], data: JSON.parse(/^data: (.+)$/m.exec(frame)![1]) };
        } finally { clearTimeout(timeout); }
      },
    };
  }
  const stream = await openStream();
  assert.equal((await stream.next()).data.reset, true);
  listener?.({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "live" }] } });
  const partial = await stream.next();
  assert.equal(partial.data.partial.content[0].text, "live");
  assert.deepEqual(partial.data.messages, []);
  assert.equal(partial.data.reset, false);
  const largeText = "x".repeat(256_000);
  listener?.({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: largeText }] } });
  assert.equal((await stream.next()).data.partial.content[0].text.length, largeText.length);
  listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } });
  // A drain can deliver the latest partial before the final message event.
  let finalFrame = await stream.next();
  while (!finalFrame.data.messages.length) finalFrame = await stream.next();
  assert.equal(finalFrame.data.messages.length, 1);
  stream.close();
  const reconnect = await openStream();
  const baseline = await reconnect.next();
  assert.equal(baseline.data.reset, true);
  assert.equal(baseline.data.messages.length, 1);
  await gateway.service.revoke(seeded.share.id);
  assert.equal((await reconnect.next()).event, "expired");
  reconnect.close();
  console.log("PASS: SSE live partial, history append, reconnect snapshot, guest isolation, revocation and gzip proxy");
  assert.equal((await fetch(`${base}/catalog`, { headers: { cookie } })).status, 410);
  assert.deepEqual(ownerHits, [new URL(link).pathname, asset]);
  console.log("PASS: real HTTP gateway, cookie authentication, private API denial, server action denial and revocation");
  await gateway.close();
  process.env.DEERHUX_SHARE_PUBLIC_ORIGIN = `https://127.0.0.1:${new URL(link).port}`;
  process.env.DEERHUX_SHARE_PORT = new URL(link).port;
  gateway = new ShareGateway();
  await gateway.start(`http://127.0.0.1:${ownerPort}`);
  const publicShare = service.create(config);
  gateway.service.shares.set(publicShare.share.id, publicShare.share);
  assert.ok(gateway.urls(publicShare.share.id).every(url => new URL(url).protocol === "http:" && isLocalNetwork(new URL(url).hostname)));
  const relay = `http://127.0.0.1:${process.env.DEERHUX_SHARE_PORT}`;
  const endpoint = `${relay}/api/share/${publicShare.share.id}/auth`;
  assert.equal((await fetch(endpoint)).status, 401);
  const relayHeaders = { "X-Forwarded-Proto": "https", "X-DeerHux-Share": "1" };
  const secureAuth = await fetch(endpoint, { method: "POST", headers: relayHeaders, body: JSON.stringify({ code: publicShare.code }) });
  assert.equal(secureAuth.status, 403);
  assert.equal(secureAuth.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${relay}/api/shares`, { headers: relayHeaders })).status, 403);
  await gateway.service.revoke(publicShare.share.id);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "X-DeerHux-Share": "1" }, body: JSON.stringify({ code: publicShare.code }) })).status, 410);
  console.log("PASS: legacy public origin ignored, relay rejected and LAN share revocation");
} finally {
  delete process.env.DEERHUX_SHARE_PUBLIC_ORIGIN;
  delete process.env.DEERHUX_SHARE_PORT;
  await gateway?.close();
  if (owner) { owner.closeAllConnections(); await new Promise<void>(resolve => owner!.close(() => resolve())); }
  fs.rmSync(temporary, { recursive: true, force: true });
}
